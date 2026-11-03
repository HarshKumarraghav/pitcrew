# Execution Plan — OpenCode-first local coding platform

**How to resume:** read this file top to bottom. `NEXT →` shows where work stopped. Each
task has a check that proves it is done. Tick the box and append to the progress log when
a task finishes. Architecture: `docs/ARCHITECTURE.md`.

> NEXT → M7.0 instrument gateway (per-request prefill/decode/reasoning/tool timing), then M9.1 cap coder memory growth (8→17 GB). Full order at the end of M9. M4 runs are ALL-DONE (saturated); fold the table into BENCHMARKS.md with M7.2.

**Objective:** maximise *successful coding tasks per unit of time and hardware* on a 24 GB
Apple Silicon Mac, with **OpenCode as the only coding-agent interface**, local models only.

```
OpenCode (agent: tools, edits, approvals, sessions)
   │  OpenAI-compatible provider (127.0.0.1)
   ▼
Pit Crew  ── task router (modes A/B/C) ── resource scheduler ── lifecycle manager
   │                │                              │
   │                └─ product intelligence ◄──── retrieval index (symbols, BM25, deps, opt. embeddings)
   ▼
Ollama (Metal)  ·  optional: llama.cpp / MLX  ·  optional job runners (image/TTS)
```

## The three goals (set 2026-11-03) and honest feasibility

| # | goal | feasible on a 24 GB Mac, local only? | target we commit to | milestone |
|---|---|---|---|---|
| 1 | answers comparable to Claude 4.5 / 4.6 / 4.7 | **Not in general.** A 9B model cannot match frontier models on hard tasks. On routine tasks it already passes (A–E). | Same tasks and verifiers for Claude Code and local. **Parity on routine tasks; measure the gap on hard tasks and shrink it**, and publish it either way | M8 |
| 2 | faster than plain OpenCode + Ollama | **Yes.** Already 2,390 s → 1,166 s on A–F (mostly the title fix) | ≥ 2× solved tasks/hour vs the *fair* baseline (title fix included) at equal quality | M7 |
| 3 | coding + voice + image/video models without eating all RAM | **Yes, if the large ones take turns.** Coder + speech-to-text + text-to-speech can stay loaded together; image/video (≈ 8–16 GB each, *estimate*) cannot share memory with the coder | Every model is available through one endpoint; the scheduler decides what is in memory; pressure never reaches "critical" | M9 |

**The goals pull against each other.** Quality techniques (repair loops, retries) spend time (goal 2),
and a bigger model would spend RAM (goal 3). Every change is measured on all three: pass rate and review score,
solved tasks/hour, and peak memory plus swap-out rate.

**Memory reality (measured 2026-11-03):** swap 36.8 of 37.9 GB used; the 9B coder showed **17 GB**
in `ollama ps` (8 GB at load). Capping that growth (M9.1) is the biggest single win for goal 3.

---

## Audit summary (2026-11-02, read-only)

| | measured |
|---|---|
| Machine | MacBook Pro `Mac17,2`, **Apple M5** (4 Super + 6 Efficiency cores, 10-core GPU, Metal 4) — the brief said M4 |
| RAM | 24 GB unified; Metal `recommendedMaxWorkingSetSize` 19.07 GB (Ollama: 17.8 GiB) |
| Live load | Chrome ≈ 5 GB, Zed ≈ 1.9 GB, Spotify ≈ 1.6 GB, Slack, node; Docker VM (8 GB) seen at first, later stopped |
| Pressure | kernel level **2 (warn)** before any model loaded; est. available 2.8 GB; swap 13.1–13.7 / 14.3 GB used |
| Disk | 994 GB APFS SSD, ≈ 206 GB free |
| OS | macOS 26.3.1 (25D771280a); on battery |
| Network | 1–4 MB/s → ~5–15 min per GB downloaded |
| Ollama | 0.40.11 (app) on 127.0.0.1:11434; default ctx **4096**; cloud enabled; only `kimi-k2.5:cloud`; aliases route `claude-*` → cloud |
| OpenCode | 1.18.35; global default `freellmapi/auto` → localhost proxy that routes to **free cloud models** |
| Other runtimes | llama.cpp 0.8.0 (brew), whisper-cli; no MLX-LM; uv 0.10.12; Node 22.16, Python 3.9 (system), git 2.50 |
| Local assets | HF cache 51 GB (TTS/image/STT models, no coding LLM) |

## Model decision (evidence so far)

| candidate | type | Q4 weights | fits beside apps? | verdict |
|---|---|---|---|---|
| Qwen3.8-27B (Aug 2026) | dense, hybrid attn | 17–18 GB | no (GPU limit 17.8 GiB, ~3–8 GB free) | too big for this Mac today |
| Qwen3.6-27B | dense | 17 GB | no | too big |
| Qwen3.6-35B-A3B / Qwen3.5-35B-A3B | MoE 3B active | 22 GB | no | MoE still needs all weights resident |
| Qwen3-Coder-30B-A3B | MoE | 19 GB | no | too big |
| Devstral Small 2 24B | dense | 15 GB | barely, heavy swap | not comfortable |
| Gemma 4 26B-A4B QAT | MoE | 16 GB | barely | not comfortable |
| **Qwen3.5-9B** | dense, hybrid DeltaNet (8/32 layers KV) | **6.6–7.6 GB** | **yes**; KV ≈ 32 KB/token → 32k ctx ≈ 1 GB | **M1 baseline** |
| Gemma 4 12B QAT | dense | 7.2 GB | yes | comparison candidate |
| Qwen3.5-2B / 0.8B | dense | 1.9 / 1.0 GB | yes | light-model role (modes B/C) |
| Qwen3-Embedding-0.6B | embedding | ~0.6 GB | yes | only if retrieval eval shows benefit |

Runtime: **Ollama** first (installed, documented OpenCode path, Qwen tool parser). llama.cpp
can load the same GGUF blob for a zero-download speed comparison; MLX only if measured better.

---

## M1 — Hardware audit + working baseline
- [x] M1.1 read-only audit (above)
- [x] M1.2 model + runtime research and recommendation (above)
- [x] M1.3 measure the exact prompt OpenCode sends (system + tool schemas) → choose context
      ✔ check: token count recorded in `docs/BENCHMARKS.md`
- [x] M1.4 `qwen3.5:9b` downloaded; `/api/show` metadata recorded; derived `num_ctx` model created
- [x] M1.5 OpenCode local profile (`examples/opencode/opencode.local.json` + `bin/opencode-local`):
      only local provider, `small_model` local, share off, autoupdate off, models.dev fetch off;
      global config untouched
- [x] M1.6 verify local inference (curl) + tool calling (OpenCode `run` reads/edits/executes)
- [x] M1.7 agent tasks A–F (`bench/agent`) → success, TTFT, wall time, tool errors, memory, swap
- [~] M1.8 prove no cloud routing: `lsof` of OpenCode/Ollama during a run shows only 127.0.0.1
- [x] M1.9 document baseline in `docs/BENCHMARKS.md`

## M2 — Product intelligence
- [x] M2.1 `pitcrew index <repo>`: languages, frameworks, entry points, scripts, tests, deps
      (deterministic: manifests, file tree, import graph, git history) → stored in
      `~/.pitcrew/projects/<id>/` (never inside the repo)
- [x] M2.2 artifacts: PRODUCT_OVERVIEW.md, ARCHITECTURE.md, MODULE_MAP.json,
      DEPENDENCY_GRAPH.json, ENGINEERING_CONVENTIONS.md, TESTING_GUIDE.md (LLM only for synthesis)
- [x] M2.3 retrieval: symbol index + BM25 + dependency expansion; `pitcrew context "<task>"`
- [ ] M2.4 OpenCode integration: instructions file + custom command/tool that calls `pitcrew context`
      ✔ check: retrieval precision@k on fixture tasks; unit tests

## M3 — Multi-model scheduling
- [x] M3.1 resource scheduler: admission, eviction, priorities, thrash control (12 tests)
- [x] M3.2 job adapter for non-LLM models (5 tests)
- [x] M3.3 HTTP gateway: OpenAI-compatible streaming proxy, tool-call passthrough, cancellation,
      timeouts, `/governor/state`, SSE, metrics ✔ integration tests with mock Ollama
- [x] M3.4 task router: modes A (single), B (sequential light+strong), C (resource-aware hybrid)
- [x] M3.5 CLI: `serve`, `status`, `plan`, `doctor`, `clean`

## M4 — Comparative evaluation
- [ ] M4.1 harness configs: single (no context) · single + context · B · C
- [ ] M4.2 task set: understanding, single-file, multi-file, bug fix, test gen, refactor,
      regression diagnosis, review (extend `bench/agent`)
- [ ] M4.3 ≥ 3 repeats per config; report mean ± spread; measured vs estimated separated
- [ ] M4.4 `docs/BENCHMARKS.md` with results and resources per successful task

## M5 — Learning pipeline
- [x] M5.1 reviewed-example collector (opt-in; patch + context + passing tests; secret scan; provenance)
- [x] M5.2 dataset validator + export to MLX-LM LoRA format
- [~] M5.3 LoRA job (explicit command only, resource-budgeted, never automatic); verify base-model support
- [ ] M5.4 4-way eval (base/±retrieval × finetuned/±retrieval); promote only on significant gain

## M6 — Observability + release
- [~] M6.1 terminal-style dashboard (`/`) — measured vs estimated clearly labelled
- [x] M6.2 README, MODELS.md, SECURITY.md, CONTRIBUTING.md, TROUBLESHOOTING.md, ROADMAP.md, LICENSE
- [~] M6.3 CI (typecheck + tests, ubuntu + macos), `npm run build`, clean-clone install check
- [ ] M6.4 rollback doc; final report

## M7 — Throughput breakthrough: same model, more solved tasks per hour

**Claim to earn:** same `qwen3.5:9b`, same Ollama, same busy 24 GB Mac → **≥ 2× solved tasks per
hour** vs a *fair* baseline (stock OpenCode + Ollama **with the title fix already applied**, so the
gain is not the title bug). Constraints fixed in Q&A 2026-11-03: local models only (hard rule), keep
Ollama + qwen3.5 (no new runtime/model downloads), measure on harder in-repo tasks.

**Why this is the constraint.** Decode is memory-bandwidth bound: ~150 GB/s ÷ ~5.5 GB of weights
≈ 25–30 tok/s (*estimate*; measured 23–36). Nothing can raise that, so
`task time ≈ Σ steps × (uncached prefill + generated tokens ÷ ~30 tok/s + tool time)`.
The levers are **fewer generated tokens per step, fewer uncached prefills, fewer steps**.
Evidence so far: after removing the title wait, A–E work time did not improve (M1 ≈ 363 s vs mode A
≈ 429 s); M4 mode A task F generated 12,645 output tokens (≈ 420 s of its 685 s at 30 tok/s,
*estimate*) and OpenCode compacted its context mid-task (a "Work State" summary appears in the final text).

**Example (illustrative, to be replaced by M7.0 numbers):** step 7 of task F, the model has just
received a `glob` result. Today it thinks freely (say 300 tokens ≈ 10 s) and then calls `read`.
With a per-step budget, a step that follows a read-only tool result runs with thinking off and
issues the `read` in ~1 s. Steps that follow a test failure or a failed edit keep full thinking.

**Metric:** solved tasks per hour = passes ÷ total wall (failed tasks cost their full time).
Also reported: seconds, generated tokens, steps, and uncached prefill tokens per solved task.
Headline numbers are the median of ≥ 3 repeats with the range shown. Ablations use 1 repeat.

- [ ] M7.0 **Instrument first.** Gateway logs per request: kind (agent/helper), prompt tokens,
      cached vs uncached prefill (`prompt_eval_count`/duration), generated tokens split into
      reasoning and content, decode duration, the chosen tool, and whether a compaction request occurred.
      `bench/summarize.mjs` turns this into a time budget per task.
      *Check:* the per-task budget sums to within 5% of wall time on a rerun of A–F.
      *Gate:* rank the levers by their measured share of time. If reasoning decode is < 30% of wall time, re-plan before M7.3.
- [ ] M7.1 **Harder task set G–P** (~10 tasks): traps like F (route order), multi-file refactor,
      a flaky test, a misleading error message, config plus code changes, and a long tool chain.
      Each one has hidden verifiers, a reference solution that passes, and an untouched fixture that fails.
      *Target:* the fair baseline passes ~30–60%. A–F stay as a regression set.
- [ ] M7.2 **Fair baseline**: `opencode.local.json` with `small_model` = `qwen3.5:0.8b` and thinking
      off, OpenCode → Ollama directly, 3 repeats on G–P. This is the number to beat.
- [ ] M7.3 **Lever 1: per-step reasoning budget** (router). Classify each request from the last
      message: first step or plan, after a test failure or edit error → full thinking; after a successful
      read-only tool result → `reasoning_effort: "none"` (or low). Per-step-kind `max_tokens` cap.
      *Check:* generated tokens per solved task drop ≥ 40% and pass rate is not lower.
      **Quality guardrails** (the main risk is skipping thinking that was needed):
      escalate: if a no-think step gives an invalid or repeated tool call, or the next tool result is
      an error, the following steps run with full thinking. Try `low` before `none`. Use M7.0 logs to
      check whether thinking after reads ever changes the next action (if it mostly does not, it is
      safe to skip). Quality is judged on more than pass rate: hidden checks, no tests weakened, diff size,
      and a blind diff review of 5 solved tasks per config. If any of these is worse beyond the run-to-run
      spread, the lever is dropped or narrowed.
- [ ] M7.4 **Lever 2: prefill and compaction**: keep the request prefix byte-stable (cache
      hits), count compactions, and compare 32k with the existing 64k bucket on compaction cost against memory.
      *Check:* uncached prefill tokens per solved task drop, and pressure never reaches "critical".
- [ ] M7.5 **Lever 3: fewer steps**: inject `pitcrew context` retrieval into the first request
      (finishes M2.4). Detect loops of repeated identical tool calls and failed `edit`s (`oldString` not found) and
      add a short corrective hint for the next step.
      *Check:* steps per solved task drop ≥ 25%.
- [ ] M7.6 **Ablation + headline**: baseline, all levers, and all levers minus one (each).
      Headline at 3 repeats. Claim "2×" only if ranges do not overlap.
      Machine time ≈ 10 h (*estimate*: 16 tasks × ~5 min × runs), so runs happen overnight.
- [ ] M7.7 write-up in `docs/BENCHMARKS.md`: time budget before and after, which lever bought what, and limits
      (one machine, one model, in-repo tasks). Report the title-request issue to OpenCode separately.

Out of scope for M7 (per Q&A): speculative decoding (Ollama does not support it), other
models or runtimes, and any cloud model in the loop.

## M8 — Quality vs Claude (goal 1)

Claude is used only as a **yardstick**. It is never inside the local pipeline, which stays local only.
Runs use the user's logged-in Claude Code (`bench/run-claude.sh`, which counts against their usage).

- [ ] M8.1 run Claude Code on A–F and G–P with the Claude 4.5 / 4.6 / 4.7 models still available
      (check the model IDs at run time; the script currently has opus-4-6 and sonnet-4-6). 3 repeats.
- [ ] M8.2 quality score beyond pass/fail: hidden checks, tests not weakened, diff size, and a blind
      review of the diffs (reviewer does not know which agent produced them). The same rubric applies to every agent.
- [ ] M8.3 local quality levers (each one also measured for time cost):
      test-driven repair (after an edit, failing test output goes back to the model with thinking on);
      plan first (one planning step with full thinking, then execution); retrieval at the start (M2.4);
      repository LoRA from reviewed examples (M5.4, only with a significant gain).
- [ ] M8.4 report: local vs each Claude version, as pass rate, review score and time per task, split
      into routine (A–F) and hard (G–P). *Target:* parity on routine tasks, and at least half the hard-task gap
      closed relative to the fair baseline (*aspiration*, unknown until measured).

## M9 — Many models without eating RAM (goal 3)

Budget: 24 GB total. macOS + apps ≈ 12 GB, so ≈ 10–12 GB is left for models, and swap is already near full.

| model | size (*estimate* until calibrated) | policy |
|---|---|---|
| coder `qwen3.5:9b` | 8 GB at load → 17 GB observed | primary; growth capped (M9.1) |
| helper `qwen3.5:0.8b` | 1.2 GB | stays loaded |
| speech-to-text (whisper small) | ≈ 0.5–1 GB | stays loaded |
| text-to-speech (e.g. Kokoro) | ≈ 0.5 GB | stays loaded |
| image (mflux, 4-bit) | ≈ 8–10 GB | queued; runs when the coder is idle or unloaded |
| video (e.g. LTX-Video / Wan small) | ≈ 8–16 GB | queued; background only; coder unloaded first |

- [ ] M9.1 **cap coder memory growth** (8 → 17 GB): find the cause (MLX prompt cache vs KV at
      32k), then fix it with a context bucket, a periodic reload when the coder is idle, or runner options. *Check:* steady-state
      resident size ≤ 10 GB through task F, pass rate unchanged.
- [ ] M9.2 calibrate real peak memory for STT, TTS, image (`jobs.ts` already measures peak RSS).
- [ ] M9.3 add a `video` job endpoint (same job adapter; background priority; preemptible queue).
- [ ] M9.4 mixed-load scenario S3: coder runs a task while STT/TTS requests arrive and an
      image/video job is queued. *Check:* pressure never "critical", app swap-out rate under the
      thrash threshold, coder pass rate and time within the run-to-run spread, and video finishes after the coder
      goes idle.
- [ ] M9.5 dashboard: who is loaded, who is queued and why, memory headroom.

**Order of work:** M7.0 (instrument) → M9.1 (memory cap, helps all three goals) → M7.1 harder
tasks → M7.2 fair baseline + M8.1 Claude runs on the same tasks → speed levers (M7.3–7.5) and quality
levers (M8.3), each judged on all three metrics → M9.2–9.5 → M7.6/M8.4 write-up.

---

## Decisions log

| decision | why |
|---|---|
| Governor = OpenAI-compatible proxy in front of Ollama | OpenCode supports custom OpenAI-compatible providers; keeps OpenCode's tools/approvals intact |
| Node ≥ 22 + TypeScript, zero runtime deps | auditable; runs via `--experimental-strip-types` without a build |
| Derived models per context bucket | Ollama's OpenAI API cannot set `num_ctx` per request; derived models share blobs |
| Swap-out *rate*, not swap *used*, as thrash signal | swap is ~95% used before any model loads |
| Deterministic analysis first, LLM for synthesis only | facts from code are cheaper and verifiable; small models hallucinate structure |
| No app is closed, no global config edited | not authorised; the system must cope with a busy machine |
| Image/TTS job support kept as optional extension | built earlier on request; not on the coding critical path |
| Breakthrough axis = throughput (solved tasks/hour), local-only, Ollama + qwen3.5 fixed (2026-11-03 Q&A) | decode is bandwidth-bound; most defensible claim that is not an upstream bug fix; no slow downloads |
| Fair baseline includes the title fix | otherwise the headline is just the OpenCode title bug |

## Progress log

- 11-02 ~22:57 audit; Ollama confirmed on :11434
- 11-02 ~23:00 `qwen3.5:9b` pull started (1–4 MB/s)
- 11-02 agent fixture + hidden verifiers validated (reference 18/18, baseline fails 10/11)
- 11-02 architecture doc; scheduler (12/12 tests); job adapter (5/5 tests)
- 11-02 23:26 mission expanded to OpenCode-first platform (M1–M6); plan rewritten; Docker VM observed stopped
- 11-02 project renamed to **Pit Crew** (`pitcrew-ai`, CLI `pitcrew`, state `~/.pitcrew`) per user via parallel session; folder moving to `~/personal/pitcrew` — no absolute paths in repo
- 11-02 M1.3 done: OpenCode base prompt ≈24.3k tok default → ≈7.5k tok with local profile; 32k ctx chosen. Local profile + `bin/opencode-local` verified (only `local/coder` listed; model id mapping works)
- 11-03 overnight: pull failed 8× (DNS / machine offline); resumed 13:21 at 9 MB/s — `qwen3.5:9b` installed (7.6 GB, **NVFP4 safetensors on Ollama's MLX runner**, not GGUF → llama.cpp cannot load it; metadata lacks KV layout → footprint falls back to conservative guess + calibration)
- 11-03 M3.3 gateway done: 10/10 integration tests (mock Ollama); typecheck clean; 29/29 tests total
- 11-03 M1.4/M1.6 measured: load 5.9 s; resident 7.62 GB → 8.06 GB after a 5.9k-token prompt at 32k ctx; loading pushed ~5.7 GB of apps to swap (swap file 16.3→22.1 GB); OpenCode local-profile prompt = **5,858 real tokens** (4.12 chars/token); cold prefill 10.0 s (584 tok/s), warm prefill ≈0 s (prefix cache); decode 23–36 tok/s; correct `glob` tool call ✅
- 11-03 M1.7 task A PASS (8/8) but 340 s of 385 s blocked by OpenCode's title request (thinking runaway, 5 min, HTTP 500) on the same model → motivates router; task B PASS (16 tool calls, 0 errors)
- 11-03 M2 product intelligence: `src/intel/` (scan, symbols, import graph, profile, BM25 + symbol + dependency retrieval), `pitcrew scout|context`, artifacts in ~/.pitcrew/projects/<id>/; 7 tests incl. retrieval precision on fixture tasks
- 11-03 M3.4 router (`auto` model; modes A/B/C; helper output cap), M3.5 CLI (serve/audit/garage/scout/context/status/clean), M6.1 dashboard HTML (needs screenshot); 41/41 tests, typecheck clean
- 11-03 M1 baseline done: 5/6 pass; 69% of wall time blocked by title request; 9B resident grew 8→17 GB; `reasoning_effort:none` makes helper titles 0.2 s (was 14.4 s, empty) → router patch added; models unloaded, pressure back to normal
- 11-03 gateway first real run stalled: coder estimate 11.7 GB (unknown-arch guess) vs 5.5 GB headroom → refused forever. Added `primary: true` alias policy (aggressive admission for the chosen coder; others stay balanced; critical pressure still blocks)
- 11-03 M4 mode C (single run): A PASS 123 s (M1: 385 s), first-step wait 26 s (M1: 343 s); B PASS 161 s (M1: 170 s); C PASS 514 s (M1: 488 s; more steps, 4 tool errors, thrash controller engaged)
- 11-03 M5 learning pipeline: collect (opt-in, temp-index diff incl. new files, tests must pass, secret + e-mail scan, provenance), export to MLX-LM chat JSONL, `tune plan` (never runs); bugs found+fixed: untracked files missing from diff, NODE_TEST_CONTEXT leak made failing tests look green. 47/47 tests
- 11-03 docs: README, MODELS, SECURITY, TROUBLESHOOTING, CONTRIBUTING, LICENSE, CI workflow; `npm run build` verified
- 11-03 M4 single runs done: mode A 5/6 1,166 s · B 6/6 1,257 s · C 6/6 1,535 s vs M1 5/6 2,390 s; gain = title wait removed, work time not improved → task set saturated
- 11-03 Q&A: breakthrough axis = throughput, local-only, Ollama+qwen3.5 fixed, harder in-repo tasks → M7 plan written
- 11-03 goals set by user: (1) quality comparable to Claude 4.5/4.6/4.7, (2) faster than plain OpenCode+Ollama, (3) coding+voice+image/video models without eating RAM → Goals table, M8, M9 added; observed coder at 17 GB, swap 36.8/37.9 GB
