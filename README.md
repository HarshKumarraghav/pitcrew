# Pit Crew

**OpenCode drives. Your local models are the crew. No swap, no cloud, no crashes.**

Pit Crew turns a laptop with a modest amount of unified memory into a dependable local coding
setup. [OpenCode](https://opencode.ai) stays your coding agent (tools, edits, approvals,
sessions). Pit Crew sits between OpenCode and [Ollama](https://ollama.com) and decides **which
model runs, when, with how much context, and whether your machine can afford it right now**.

```
OpenCode ──► Pit Crew gateway (127.0.0.1:11500, OpenAI-compatible)
               ├─ router        auto → coder / light model   (modes A · B · C)
               ├─ RAMbo         memory-aware admission, eviction, priorities, thrash control
               ├─ context sizer 8k/16k/32k… per request, never silent truncation
               ├─ scout         repo facts, module map, import graph, BM25 retrieval
               └─ telemetry     terminal-style dashboard, /metrics, event log
            ──► Ollama (Metal / MLX)   ·   optional image / TTS job runners
```

## Why

Measured on a 24 GB Apple M5 MacBook Pro with Chrome, Zed, Slack and Spotify open
(details in [docs/BENCHMARKS.md](docs/BENCHMARKS.md)):

- Kernel memory pressure was already **warn** and ~13 GB were in swap *before any model loaded*.
- Loading a 7.6 GB coding model pushed **≈ 5.7 GB of other apps into swap**.
- OpenCode's default prompt with a typical skills folder is **≈ 24k tokens**; Ollama's default
  context is **4,096** → ~83% of the prompt would be silently cut.
- OpenCode's session-title request went to the same thinking model, ran for 5 minutes and
  **blocked the first agent step for 5 m 20 s**.

Local runtimes size models against the GPU limit, not against what your other apps are using.
Pit Crew fills that gap.

## What it does

| | |
|---|---|
| **Memory-aware scheduling** | Loads a model only if it fits *real* headroom (free + clean cache + part of compressible memory, minus reserves). Evicts idle models LRU-first, never one that is mid-request. Queues instead of thrashing. |
| **Thrash control** | Watches swap-out *rate* and kernel pressure; under sustained pressure it drops to one request at a time, sheds idle models and pauses background work. |
| **Context sizing** | Picks the smallest window that fits each request; keeps it sticky to avoid reloads; returns a clear error instead of truncating. |
| **Router (`auto`)** | Mode A: one model for everything. Mode B: helper requests (titles, short summaries) → light model, heavy work sequential. Mode C: light model only when it fits without eviction, otherwise reuse the resident coder. |
| **Product intelligence** | `pitcrew scout` builds PRODUCT_OVERVIEW, ARCHITECTURE, MODULE_MAP, DEPENDENCY_GRAPH, ENGINEERING_CONVENTIONS, TESTING_GUIDE from code, manifests and git — stored in `~/.pitcrew`, never in your repo. `pitcrew context "<task>"` returns the files that matter. |
| **Local only** | Binds to 127.0.0.1, refuses `:cloud` models, no outbound calls. |
| **Observable** | Dashboard at `/`, JSON at `/governor/state`, live SSE, Prometheus `/metrics`; measured vs estimated values are labelled. |
| **Zero runtime dependencies** | Node ≥ 22 standard library only. |

## Quick start

```sh
git clone <this repo> pitcrew && cd pitcrew
npm install            # dev tools only (typescript); runtime has no dependencies
ollama pull qwen3.5:9b && ollama pull qwen3.5:0.8b

cp examples/pitcrew.config.json pitcrew.config.json   # edit aliases if you like
npm run dev -- audit     # what does this machine have, what fits now?
npm run dev -- serve     # gateway + dashboard on http://127.0.0.1:11500

bin/opencode-local       # OpenCode with the local-only profile, through Pit Crew
```

Your global OpenCode config is not modified: `bin/opencode-local` sets `OPENCODE_CONFIG` to a
profile that is merged on top and restricts OpenCode to the local provider.

## Commands

| command | |
|---|---|
| `pitcrew serve` | gateway, router, scheduler, dashboard |
| `pitcrew audit` | machine, memory, swap, pressure, runtimes, local and cloud models |
| `pitcrew garage` | each local model's estimated / calibrated / measured memory and whether it fits now |
| `pitcrew scout <repo>` | analyse a repository (deterministic) |
| `pitcrew context "<task>" --repo <dir>` | most relevant files with reasons |
| `pitcrew status` | live scheduler state |
| `pitcrew clean --yes` | remove Pit Crew's derived context models (`pitcrew/*`, metadata only) |

## Choosing models

See [docs/MODELS.md](docs/MODELS.md). Short version for 24 GB machines: Qwen3.5-9B is the largest
current Qwen that fits beside a normal desktop workload; 27B-class models (Qwen3.6/3.8-27B,
17–18 GB at 4-bit) and 30B MoE models (19–22 GB) do not, even though their benchmark scores are
higher. On 32 GB+ machines, try Qwen3.8-27B.

## Status

Early (0.1). Tested on macOS 26 / Apple M5 / Ollama 0.40 / OpenCode 1.18. Linux memory probing is
implemented but less tested. See [docs/PLAN.md](docs/PLAN.md) for the roadmap and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for internals.

A local 9B model is not a frontier model. Benchmarks in this repo measure what it does on
specific tasks; they make no claim of parity with hosted models.

## License

MIT. Model weights are not included; each model has its own license (Qwen3.5: Apache 2.0).
