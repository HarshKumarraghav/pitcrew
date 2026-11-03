# Pit Crew — Architecture

**OpenCode drives. Your local models are the crew. No swap, no cloud, no crashes.**

OpenCode is the driver; the models and the scheduler (internally nicknamed *RAMbo*) are the
crew; a model swap is a pit stop; the dashboard is telemetry; benchmarks are laps; product
intelligence scouts the track; fine-tuning tunes the car.

> A memory-aware scheduler and OpenAI-compatible gateway that lets one unified-memory
> machine (Apple Silicon first, Linux second) run **several local AI models at once** —
> coding LLMs, small helper LLMs, image generators, speech models — without swap
> thrashing, silent context truncation, or accidental cloud routing.

---

## 1. Problem

On Apple Silicon the CPU, GPU and every app share one pool of RAM. Local runtimes decide
whether a model "fits" by looking at the **GPU working-set limit** (≈74% of RAM, 17.8 GiB
on a 24 GB Mac). They do **not** look at what Chrome, Docker, your editor and the other
models are already using. The result, measured on the reference machine (M5, 24 GB):

| Symptom | Root cause |
|---|---|
| Mac becomes sluggish, beachballs, fans | A model load pushes apps into compression and swap (swap was already 13.7 / 14.3 GB used before any model loaded) |
| Agent "forgets" its tools, replies nonsense | Ollama's default context is **4096 tokens**; OpenCode's prompt is larger and is **silently truncated** |
| Two models answer slower than one | Both loaded and generating at once compete for memory bandwidth, then swap |
| Model reloads constantly | Clients request different context sizes → Ollama reloads the model each time |
| Image or TTS jobs crash or freeze the system | They allocate GBs outside the LLM runtime's accounting |
| Privacy surprise | `*:cloud` models and alias rules can route "local" requests to the internet |

## 2. Goals and non-goals

**Goals**
1. One local endpoint for every model type: chat/completions, embeddings, images, speech.
2. Admit work only when it fits into the memory that is *really* available, not theoretical.
3. Prefer interactive work (your coding agent) over background work (titles, batch jobs).
4. Pick a correct context window per request; never silently truncate.
5. Unload idle models automatically; never unload a model mid-request.
6. React to real thrashing (swap-out rate, kernel pressure) by backing off.
7. 100% local: refuse cloud models; bind to localhost by default.
8. Observable: live terminal-style GUI, JSON state, Prometheus metrics, event log.
9. Measurable: a reproducible benchmark comparing *with* vs *without* the governor.
10. Zero runtime dependencies (Node ≥ 22 standard library only) so it is easy to audit.

**Non-goals (v0.1)**
- Not an inference engine. It drives Ollama and model CLIs; it does not run kernels.
- No multi-machine clustering, no auth/multi-tenant features (localhost tool).
- No model downloading (it tells you the `ollama pull` command instead).

## 3. System overview

```
 ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
 │  OpenCode    │ │ scripts/curl │ │ 2nd agent    │ │  GUI (browser)│
 └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
        │  OpenAI-compatible HTTP (127.0.0.1:11500)         │ SSE /governor/events
        ▼                ▼                ▼                 ▼
 ┌───────────────────────────────────────────────────────────────────┐
 │                          Pit Crew                            │
 │                                                                   │
 │  HTTP layer ── Router ── Resolver ── Context Sizer                │
 │                    │                                              │
 │                    ▼                                              │
 │  ┌─────────────── Scheduler ────────────────┐   Memory Monitor    │
 │  │ priority queues · slots · admission      │◄── vm_stat/sysctl   │
 │  │ eviction planner · thrash controller     │    (1 Hz, EMA)      │
 │  └───────┬───────────────────────┬──────────┘                     │
 │          │                       │           Footprint Model      │
 │          ▼                       ▼           (metadata + measured │
 │   Ollama Adapter          Job Adapter         calibration)        │
 │   (LLMs, embeddings)      (image, TTS, STT    Event Log · Metrics │
 │                            via local CLIs)                        │
 └──────────┬────────────────────────┬──────────────────────────────┘
            ▼                        ▼
   Ollama (127.0.0.1:11434)    mflux / mlx-audio / whisper.cpp
   qwen3.5:9b  qwen3.5:2b      Z-Image-Turbo 4-bit, Kokoro-82M, …
   qwen3.5:0.8b
```

Three layers, three responsibilities:

| Layer | Owns | Does not own |
|---|---|---|
| **Coding agent** (OpenCode) | planning, tools, file edits, the loop | memory, models |
| **Pit Crew** | *when* and *where* work runs, memory, context sizes, priorities | inference math |
| **Runtimes** (Ollama, mflux, mlx-audio) | running the model | other apps, other runtimes |

## 4. Components

### 4.1 HTTP layer (`src/server/`)

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI chat (streaming + tools), scheduled → Ollama `/v1` |
| `POST /v1/completions`, `/v1/embeddings`, `/v1/responses` | scheduled passthrough |
| `GET /v1/models` | aliases + local models (no cloud) |
| `POST /v1/images/generations` | OpenAI-style image generation → Job adapter |
| `POST /v1/audio/speech` | OpenAI-style TTS → Job adapter (returns WAV) |
| `POST /v1/audio/transcriptions` | STT → Job adapter |
| `POST /api/chat`, `/api/generate`, `/api/embed` | Ollama-native, scheduled |
| `GET /api/tags`, `/api/ps`, `/api/show`, `/api/version` | Ollama passthrough (read-only) |
| `GET /` | terminal-style GUI |
| `GET /governor/state` | full JSON snapshot |
| `GET /governor/events` | Server-Sent Events: snapshot every second + event log |
| `POST /governor/unload` | manual unload (`{"model": "..."}`) |
| `GET /metrics` | Prometheus text format |

Streaming responses are piped byte-for-byte; the slot is held until the upstream stream
ends **or the client disconnects** (upstream request is aborted, slot released).

### 4.2 Resolver (`src/models/registry.ts`)

- Maps a requested name to a **base model**. Names can be *aliases* from config
  (`coder`, `fast`, `image`, `tts`) or raw local model names.
- Rejects anything with a `remote_host`, `:cloud` or `-cloud` suffix (HTTP 403).
- Rejects missing models with the exact `ollama pull …` command (HTTP 404).

### 4.3 Context Sizer

Ollama's OpenAI endpoint cannot take `num_ctx` per request, and changing `num_ctx` forces
a reload. The governor therefore uses **derived models**: metadata-only copies created via
`/api/create {from: base, parameters: {num_ctx}}` named `pitcrew/<base>:<N>k`. They share the
parent's weight blobs (no extra disk).

```
estimate_tokens = chars(messages + tools) / chars_per_token(model)    # learned from usage
need            = estimate_tokens + max_output (request.max_tokens or default 4096)
bucket          = smallest of [8k, 16k, 32k, 64k, 128k] ≥ need × 1.1, within [minCtx, maxCtx]
if need > maxCtx  → HTTP 400 "context too large" (never silent truncation)
sticky: if base is already loaded with ctx ≥ bucket → reuse it (no reload)
grow:   if bucket > loaded ctx → wait for that base's in-flight requests to drain,
        unload the old variant, load the larger one
```

Invariant: **at most one variant of a base model is loaded at any time** (otherwise the
weights would be resident twice).

`chars_per_token` starts at 3.2 and is updated from `usage.prompt_tokens` (EMA), so the
estimate converges to the model's real tokenizer after a few requests.

### 4.4 Footprint Model (`src/models/footprint.ts`)

```
footprint(model, ctx, parallel) = weights + kv_bytes_per_token × ctx × parallel + overhead
```

- `weights` = GGUF blob size from `/api/tags`.
- `kv_bytes_per_token` from `/api/show` metadata:
  `Σ_layers kv_heads × (key_len + value_len) × elem_bytes(kv_cache_type)`, counting only
  layers that keep a KV cache:
  - hybrid linear-attention models (Qwen3.5/3.6/3.8: Gated DeltaNet + every 4th layer full
    attention) → only 1/4 of layers count;
  - sliding-window layers (Gemma) cost `min(ctx, window)`;
  - SSM layers (Mamba/Nemotron-H, `head_count_kv = 0`) cost nothing.
- `overhead` = compute graph + recurrent state + buffers; starts conservative.
- **Calibration**: after every load the governor reads `/api/ps` (true resident size).
  One observation fixes `overhead`; two observations at different `ctx × parallel` fit a
  line `size = a + b·tokens`, i.e. the per-token cost is *measured*, not assumed.
  Persisted in `~/.pitcrew/calibration.json`, keyed by blob digest.
- Job workloads (image/TTS) declare `memoryGiB` and are calibrated from measured peak
  process-tree RSS.

### 4.5 Memory Monitor (`src/system/memory.ts`)

Polls at 1 Hz with unprivileged commands:

| Signal | macOS source | Linux source |
|---|---|---|
| total | `hw.memsize` | `MemTotal` |
| available (free + clean file cache + purgeable) | `vm_stat` | `MemAvailable` |
| inactive anonymous (compressible) | `vm_stat` | `Inactive(anon)` |
| swap used / total | `vm.swapusage` | `SwapTotal - SwapFree` |
| swap-out **rate** (EMA) | Δ `Swapouts` pages | Δ `pswpout` |
| kernel pressure | `kern.memorystatus_vm_pressure_level` (1/2/4) | PSI `some avg10` |
| GPU limit | `iogpu.wired_limit_mb` or 0.74 × RAM | — |

Thrash state: `critical` if kernel says critical, or swap-out rate > threshold while the
kernel says warn; `warn` if either alone; else `ok`. Swap *used* is deliberately **not** a
signal (macOS keeps stale pages in swap for days); swap-out *rate* is.

### 4.6 Scheduler (`src/scheduler/scheduler.ts`)

State per base model: `loadedVariant`, `ctx`, `inFlight`, `lastUsed`, `footprint`,
`state ∈ {unloaded, loading, ready, unloading}`. Global: `running`, queues.

**Queue order**: interactive before background (`strictPriority`), FIFO within a class,
background items waiting longer than `agingMs` are promoted (no starvation).

**Dispatch loop** (runs on every enqueue, completion, load finish, memory sample):

```
for item in queue (priority order):
    if running ≥ effectiveMaxConcurrent: break
    m = state(item.base)
    if m.ready and m.ctx ≥ item.ctx and m.inFlight < parallel:  start(item); continue
    if m.loading:                                               continue   # wait for it
    if m.ready and m.ctx < item.ctx:                            # needs bigger window
        if m.inFlight == 0: reload(m, item.ctx)                 continue
    plan = admission(item.base, item.ctx)
    switch plan:
        fits            → load(m, item.ctx)
        fits_if_evict E → unload(E) then load(m, item.ctx)
        wait            → leave queued (re-evaluated on next event)
        never           → reject 507 "needs X GiB, budget is Y GiB"
expire items older than queueTimeoutMs → 503 + Retry-After
```

**Admission** for a footprint `F`:

```
budget    = min(maxModelMemory (default 0.9 × GPU limit), total − osReserve)
committed = Σ measured size of resident models (incl. ones loaded by other clients) + running jobs
headroom  = available − minFree
          + 0.5 × inactive_anon        (policy = balanced; strict: +0; aggressive: +∞)
fits      ⇔ committed + F ≤ budget  ∧  F ≤ headroom  ∧  thrash ≠ critical
          (thrash = warn → treat policy as strict)
```

**Eviction planner**: candidates are resident models with `inFlight = 0`, not pinned, not
needed by a higher-or-equal-priority queued item. Sorted by (background first, then
least-recently-used). Take the shortest prefix whose freed memory makes `fits` true. If no
prefix suffices → `wait` (if something is in flight that will eventually free) or `never`.

**Thrash controller** (feedback loop on top of the estimate-based admission):

| state | action |
|---|---|
| `ok` | normal |
| `warn` | strict policy; background queue paused |
| `critical` (≥ 3 s) | concurrency → 1; evict idle unpinned models (background first, pinned last); no new loads |
| back to `ok` for 20 s | restore |

**Idle unload**: models unused for `idleUnloadMs` (default 15 min) are unloaded unless
pinned. Ollama's own `keep_alive` is set to `-1` for governor loads so Ollama never
unloads behind the governor's back.

**Foreign models**: models loaded by clients that bypass the governor are seen through
`/api/ps` (reconciled every 2 s) and counted in `committed`; the governor may evict them
when idle (`evictForeign: true`, default).

### 4.7 Adapters

**Ollama adapter** (`src/backend/ollama.ts`): control plane (`tags`, `show`, `ps`,
`create`, load via empty `/api/generate`, unload via `keep_alive: 0`) and the data plane
(raw HTTP pipe to `/v1/*` and `/api/*`). Optional **managed mode** spawns a private
`ollama serve` on another port with governor-chosen env (`OLLAMA_NUM_PARALLEL`,
`OLLAMA_KV_CACHE_TYPE`, `OLLAMA_FLASH_ATTENTION`, `OLLAMA_MAX_LOADED_MODELS`), sharing the
normal `~/.ollama/models` store, so the Ollama app's settings are never modified.

**Job adapter** (`src/backend/jobs.ts`): for runtimes that are CLIs (image, TTS, STT). Each
job model is declared in config:

```json
"image": { "kind": "job", "endpoint": "images",
           "command": ["uvx", "--from", "mflux", "mflux-generate-z-image-turbo",
                       "--quantize", "4", "--prompt", "{prompt}", "--width", "{width}",
                       "--height", "{height}", "--steps", "{steps}", "--output", "{out}"],
           "memoryGiB": 6, "priority": "background", "timeoutMs": 600000 }
```

A job is a scheduler item like any other: it is admitted only when its footprint fits, may
trigger eviction of idle LLMs, holds a slot while running, and its measured peak RSS
calibrates `memoryGiB`. Placeholders are substituted as **separate argv entries** (no
shell), so prompts cannot inject commands.

### 4.8 Event log and metrics

Every decision emits an event: `enqueue`, `start`, `finish`, `load`, `loaded`, `unload`,
`evict`, `reject`, `timeout`, `thrash`, `calibrate`. Events go to a ring buffer (GUI),
stdout (one line each, `--log json` for machines) and Prometheus counters:
`pitcrew_requests_total{model,status}`, `pitcrew_queue_depth{priority}`,
`pitcrew_queue_wait_seconds` (histogram), `pitcrew_ttft_seconds`, `pitcrew_model_loads_total`,
`pitcrew_evictions_total`, `pitcrew_memory_available_bytes`, `pitcrew_swapout_bytes_per_second`.

## 5. GUI (`src/server/gui.html`)

Single static file served at `/`, no build step, no external assets (works offline).
Terminal aesthetic: black background, phosphor-green/amber text, box-drawing frames,
monospace, blinking cursor, subtle scanlines. Live via SSE.

```
┌─ Pit Crew ── M5 · 24 GB · ollama 0.40.11 ───────────── state: OK ─┐
│ MEMORY  [███████████▓▓▓▓▓▓▓░░░░░]  apps 15.2G  models 8.9G  free 3.1G │
│ SWAP    13.4G/14.3G   out ▁▁▂▁▁▁▃▂▁  0.4 MB/s     pressure: normal     │
├─ MODELS ─────────────────────────────────────────────────────────────┤
│ ● coder  qwen3.5:9b    32k  7.9G  ██████▌   busy 1/1   idle 0s        │
│ ○ fast   qwen3.5:0.8b  16k  1.3G  █         ready      idle 42s       │
│ · image  z-image-turbo  —   6.0G  —         unloaded                  │
├─ QUEUE ──────────────────────────────────────────────────────────────┤
│ #12 interactive coder  waiting 0.4s  (loading)                        │
│ #13 background  image  waiting 3.1s  (needs 6.0G, headroom 3.1G)      │
├─ EVENTS ─────────────────────────────────────────────────────────────┤
│ 23:41:07 evict  fast (idle 61s, frees 1.3G) for image                 │
│ 23:41:02 start  #11 coder ctx=32k est=11.2k tok                        │
│ 23:40:58 loaded coder 7.9G in 6.2s (est 8.1G → calibrated)            │
└───────────────────────────────────────────────────────────────────────┘
```

Tabs: **live** (above), **bench** (with/without comparison charts from
`bench/results/*.json`), **config** (effective config, read-only).

## 6. Configuration

`pitcrew.config.json` (cwd) or `~/.pitcrew/config.json`. Full example in
`examples/pitcrew.config.json`. Key fields:

| key | default | meaning |
|---|---|---|
| `listen.port` | 11500 | governor port (localhost only by default) |
| `backend.url` | `http://127.0.0.1:11434` | Ollama |
| `backend.managed` | false | spawn a private `ollama serve` |
| `backend.parallel` | 1 | slots per model (= `OLLAMA_NUM_PARALLEL`) |
| `memory.policy` | balanced | strict / balanced / aggressive |
| `memory.osReserveGiB` | 4 | never given to models |
| `memory.minFreeGiB` | 1 | free memory floor after a load |
| `scheduler.maxConcurrent` | 2 | concurrent generations across models |
| `scheduler.idleUnloadMs` | 900000 | idle unload |
| `context.buckets` | 8k…128k | allowed context sizes |
| `models.<alias>` | — | `{model, minCtx, maxCtx, priority, pin, parameters}` or `{kind:"job", …}` |

## 7. Benchmark methodology (`bench/`)

Two suites, both runnable by anyone:

**Load suite** (`bench/load`) — systems behaviour under concurrency.

| scenario | workload |
|---|---|
| S1 single-agent | 1 client, coder, 6 growing multi-turn requests |
| S2 multi-agent | 2 clients on coder + 2 on small-1 + 1 on small-2, concurrently |
| S3 mixed-modal | S2 + image generation + TTS jobs in parallel |
| S4 churn | 4 clients round-robin across all models (forces evictions) |

Modes: **baseline-default** (clients hit Ollama directly, stock settings — shows silent
truncation), **baseline-tuned** (direct, fixed 32k derived models, no governance), and
**governed** (through Pit Crew). Metrics per run: success/failure count, TTFT p50/p95,
end-to-end latency p50/p95, output tokens/s, prompt truncation detected
(`usage.prompt_tokens` < expected), model loads, evictions, min available memory, peak
swap-out rate, time in thrash state. Environment (apps running, starting swap) is recorded.
Modes are run alternately to reduce drift. Results → `bench/results/<run>/*.json` and a
Markdown summary.

**Agent suite** (`bench/agent`) — coding-agent quality through OpenCode: six tasks
(codegen, repo understanding, multi-file feature, debugging, tool execution, multi-step
reliability) on a disposable fixture repo, verified by hidden tests the agent never sees.

## 8. Security and privacy

- Binds to `127.0.0.1`; a warning is printed for any other host.
- Cloud models refused at resolve time; no outbound network calls from the governor.
- Job commands run without a shell; user input is passed as discrete argv.
- No secrets handled or logged; prompts are not logged (only sizes and timings).
- Local inference does not make the *whole* workflow private: the coding agent, its
  plugins/MCP servers, and package managers can still reach the network. The OpenCode
  profile in `examples/opencode/` disables sharing, auto-update and remote model metadata,
  and allows only the local provider.

## 9. Failure modes

| Failure | Behaviour |
|---|---|
| Ollama down | 502 with message; GUI shows backend offline; retries health every 2 s |
| Load fails (OOM) | event `reject`, request 507, model marked failed for 30 s (no hot loop) |
| Client disconnects mid-stream | upstream aborted, slot released |
| Governor crash | clients fail fast; Ollama keeps models (keep_alive −1) → `pitcrew serve` reconciles via `/api/ps` on restart |
| Estimate too low | measured size from `/api/ps` replaces estimate immediately; thrash controller backs off |
| Request needs more context than `maxCtx` | 400 with token counts |

## 10. Repository layout

```
src/
  cli.ts                 pitcrew serve | status | plan | doctor | clean
  config.ts              schema, defaults, validation
  system/memory.ts       probes (darwin/linux/node) + MemoryMonitor
  backend/ollama.ts      Ollama control-plane client, managed server
  backend/jobs.ts        CLI job runner (image / tts / stt)
  models/footprint.ts    memory model + calibration
  models/registry.ts     alias resolution, derived models, calibration store
  scheduler/scheduler.ts queues, admission, eviction, thrash controller
  server/http.ts         routes, proxying, SSE
  server/gui.html        terminal-style dashboard
  server/metrics.ts      Prometheus exposition
test/                    unit + integration tests (mock Ollama + fake memory)
bench/load/              with/without load benchmark
bench/agent/             OpenCode coding-agent benchmark
examples/                pitcrew config, OpenCode profile
docs/                    ARCHITECTURE.md, PLAN.md, BENCHMARKS.md
```
