# Pit Crew

**Run several local LLMs on one Mac without swapping.** A memory-aware gateway between
[OpenCode](https://opencode.ai) and [Ollama](https://ollama.com).

[![ci](https://github.com/HarshKumarraghav/pitcrew/actions/workflows/ci.yml/badge.svg)](https://github.com/HarshKumarraghav/pitcrew/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pitcrew-ai)](https://www.npmjs.com/package/pitcrew-ai)
[![license](https://img.shields.io/github/license/HarshKumarraghav/pitcrew)](LICENSE)
[![discussions](https://img.shields.io/github/discussions/HarshKumarraghav/pitcrew)](https://github.com/HarshKumarraghav/pitcrew/discussions)

![Pit Crew dashboard: a coder model loads, a title request goes to the light model, a burst queues, an idle model is evicted for background work](docs/img/demo.gif)

```sh
npx pitcrew-ai init     # checks your Mac, picks models that fit its memory, sets everything up
```

**[Live demo →](https://harshkumarraghav.github.io/pitcrew/)** the real dashboard replaying a recorded session
(mock backend on a simulated 24 GB Mac; [how it is recorded](scripts/demo/record.mjs)).
Or let your coding agent do it: [one prompt](#let-your-agent-set-it-up).

**OpenCode drives. Your local models are the crew. No swap, no cloud, no crashes.**

Pit Crew turns a laptop with a modest amount of unified memory into a dependable local coding
setup. OpenCode stays your coding agent (tools, edits, approvals, sessions). Pit Crew sits between
OpenCode and Ollama and decides **which model runs, when, with how much context, and whether your
machine can afford it right now**.

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
- OpenCode's default prompt with a typical skills folder is **≈ 24k tokens** (≈ 5.9k with the
  local profile). Ollama advertises a 4,096-token default context; on Ollama 0.40 with the MLX
  runner the full 5,858-token prompt still reached the model (measured), so truncation depends on
  runtime and version — Pit Crew sizes the window explicitly instead of relying on defaults.
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

Needs Node ≥ 22.6 and [Ollama](https://ollama.com/download). macOS on Apple Silicon is the main
target; Linux works but is less tested.

```sh
npx pitcrew-ai init      # look at the machine, recommend a coder + light model, ask, then set up
npx pitcrew-ai serve     # gateway + dashboard on http://127.0.0.1:11500
OPENCODE_CONFIG=~/.pitcrew/opencode.json opencode
npx pitcrew-ai doctor    # if anything is off: checks each link and prints the fix
```

`init` reads total and free memory, what Ollama has pulled and whether OpenCode is installed, then
shows a plan like this before changing anything:

```
recommended for a 16 GB machine
  coder   qwen3.5:4b     4.5 GB estimate        not pulled → download
  light   qwen3.5:0.8b   1.2 GB on disk         already pulled ✓
  context 16k for the coder · model budget 11.4 GB · coder + light ≈ 6.1 GB (estimate)

will do
  1. ollama pull qwen3.5:4b
  2. write ~/.pitcrew/config.json
  3. write ~/.pitcrew/opencode.json   (your own OpenCode config is untouched)
```

Picks come from measured data in [docs/MODELS.md](docs/MODELS.md), not from a model. Override with
`--coder <tag>` / `--light <tag>`; `--json` prints the plan for scripts; `--yes` skips the question.

### Let your agent set it up

Paste this into Claude Code, OpenCode, Codex or any agent that can run commands:

```text
Set up Pit Crew (local LLM gateway for OpenCode + Ollama) on this machine by following
https://raw.githubusercontent.com/HarshKumarraghav/pitcrew/main/docs/AGENT_SETUP.md
Explain the plan to me and wait for my OK before downloading models or writing files.
```

It runs `init --json`, explains the recommendation, applies it after you agree, starts the gateway
and runs `doctor`. Steps: [docs/AGENT_SETUP.md](docs/AGENT_SETUP.md).

### From source

```sh
git clone https://github.com/HarshKumarraghav/pitcrew.git && cd pitcrew
npm install              # dev tools only (typescript); runtime has no dependencies
npm run dev -- init
npm run dev -- serve
```

`bin/opencode-local` launches OpenCode with the local-only profile and turns off OpenCode's update
checks, model-metadata fetches and LSP downloads. Set `PITCREW_OPENCODE_PROFILE` to choose the
profile it uses.

## Commands

| command | |
|---|---|
| `pitcrew init` | recommend models for this machine, pull them, write config + OpenCode profile |
| `pitcrew doctor` | check Ollama, models, memory, gateway and OpenCode; print fixes |
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

## Contributing

Issues, hardware reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md),
the [good first issues](https://github.com/HarshKumarraghav/pitcrew/labels/good%20first%20issue) and
[Discussions](https://github.com/HarshKumarraghav/pitcrew/discussions). Security reports:
[SECURITY.md](SECURITY.md).

## License

MIT. Model weights are not included; each model has its own license (Qwen3.5: Apache 2.0).
