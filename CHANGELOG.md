# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `router.repairToolCalls` (off by default): when a model writes a tool call as answer text (Qwen
  XML with or without `<tool_call>`, Hermes `<tool_call>{…}</tool_call>`, or one whole-message JSON
  object, optionally in a ```json fence) on a `/v1/chat/completions` request that declared tools,
  the gateway rewrites it into proper `tool_calls` with `finish_reason: "tool_calls"`. Only declared
  tool names; values typed by the tool's schema; anything unparseable passes through unchanged.
  Counted in `pitcrew_toolcalls_repaired_total` and `repairedToolCalls` in the request log (no text).
- Bench config `repair-toolcalls` (today + the flag) and lever `toolcalls` in `levers-all`.
- `pitcrew solve "<task>" [--attempts 3] [--budget 15m] [--apply]`: best-of-N attempts with OpenCode
  through the gateway, each in a throwaway git worktree, judged by the repository's own tests. An
  attempt only counts with evidence: the failing suite now passes, or its new tests fail on the
  original code and pass with the change. Attempts that delete, skip or edit existing tests are
  never applied. Patches and `report.json` go to `~/.pitcrew/solve/`.
- `router.stuckHints` (off by default): a change-of-strategy hint when the same test fails 3 runs in
  a row, 3 edits change nothing, or 3 tool calls in a row fail.
- `router.testRepair` now quotes the failing tests (name, location, expected vs actual) from the
  test output (node:test, Jest, Vitest, pytest).
- Bench: `run.mjs --attempts N` (solve inside the same time budget); configs `best-of-3` and `stuck`.
- Exclusive mode for a big model on hard tasks (`models.<alias>.exclusive`): every other idle model
  is unloaded and other requests wait until it has been idle for `scheduler.exclusiveIdleMs` (60 s);
  shown on the dashboard.
- `pitcrew solve --escalate <model>`: one last attempt with a stronger model (e.g. a 27B in exclusive
  mode) when the regular attempts found no strong evidence. Bench config `cascade`.
- Catalog `BIG_MODELS` / `bigModelFor()`: Qwen3.8-27B at ~3-bit for 24 GB, ~4-bit from 32 GB (never
  picked by `init`). `bench/tools/toolcall-smoke.mjs` checks a model's tool calling before use.

### Changed

- README leads with the measured results: headline table, three charts (light and dark,
  `node scripts/charts/build.mjs`), what each of the 16 tasks tests, how runs are graded and
  validated, honest limits, and the roadmap targets.

### Fixed

- `bench/e2e.sh` OpenCode check: OpenCode gets `</dev/null` as stdin (`opencode run` waits for
  piped stdin to close, so the check hung when `e2e.sh` itself ran with an open pipe) and its output
  is kept in `/tmp/e2e-opencode.log` instead of `/dev/null`.

## [0.1.0] - 2026-11-04

First public release. Tested on macOS 26 / Apple M5 24 GB / Ollama 0.40 / OpenCode 1.18.

### Added

- `pitcrew init`: looks at total and free memory, Ollama, OpenCode and pulled models, recommends a
  coder + light model for the machine's memory tier (8 GB to 48 GB+), shows the plan, then pulls
  the models and writes `~/.pitcrew/config.json` and an OpenCode profile. `--json` for scripts and
  agents, `--yes`, `--dry-run`, `--force`, `--coder`, `--light`.
- `pitcrew doctor`: checks config, router aliases, Ollama, pulled models, memory budget, the
  gateway (with a one-token request through `auto`), OpenCode and its profile; prints a fix for
  each problem.
- `docs/AGENT_SETUP.md` and `AGENTS.md`: a prompt and step-by-step instructions so any coding agent
  can set Pit Crew up for a user.
- **Gateway.** OpenAI- and Ollama-compatible endpoint on `127.0.0.1:11500` in front of Ollama:
  chat/completions, completions, responses, embeddings, `/api/*` passthrough. Local only: refuses
  `:cloud` models, makes no outbound calls.
- **Memory-aware scheduler (RAMbo).** Admission against real headroom (free + reclaimable cache +
  part of compressible memory, minus reserves), LRU eviction of idle models only, interactive /
  background / deferrable priorities, queueing instead of thrashing, and thrash control driven by
  swap-out rate and kernel pressure.
- **Fast lane** for requests to an already-loaded model, **warm helpers** (small models loaded at
  start and pinned), and a backend parallel-slot probe.
- **Context sizing.** Derived per-context models (8k/16k/32k/…), sticky windows, a clear error
  instead of silent truncation.
- **Router (`auto`).** Modes A (one model), B (helpers on the light model, heavy work sequential)
  and C (light model only when it fits without eviction). Helper requests get an output cap and
  `reasoning_effort: "none"`.
- **Resident-size cap** (`maxResidentGiB`) with idle recycle, for runners that keep every distinct
  prompt cached, plus a learned growth reservation.
- **Agent levers** (opt-in): per-step reasoning budget, stable context block, loop and failed-edit
  hints, test-driven repair hint, plan-first.
- **Jobs.** Image, speech, transcription and video job runners spawned without a shell, with
  multipart uploads, a `deferrable` priority and learned peak memory cross-checked against the
  drop in free memory.
- **Telemetry.** Terminal-style dashboard at `/` that shows why each model is resident or queued,
  live SSE at `/governor/events`, JSON at `/governor/state`, Prometheus `/metrics`, per-request
  timing in `requests.jsonl` (sizes and timings, no prompt text), and a responsiveness probe.
- **Product intelligence.** `pitcrew scout` (repo facts, module map, import graph, conventions,
  stored in `~/.pitcrew`, never in your repo) and `pitcrew context` (BM25 + symbols + dependency
  retrieval).
- **Learning pipeline** (opt-in): collect reviewed, test-passing changes with secret and e-mail
  scanning, export to MLX-LM JSONL, and `tune plan` (prints a LoRA command, never trains).
- **CLI.** `serve`, `audit`, `garage`, `scout`, `context`, `status`, `learn`, `tune`, `clean`.
- **OpenCode profiles.** Pit Crew, local-only and fair-baseline profiles, and `bin/opencode-local`.
- **Benchmarks.** Load tests, an agent benchmark with tasks A–P and hidden verifiers, Claude
  comparison runs, quality scoring, a blind review pack, interleaved runs, and detection of runs
  during which the Mac slept (those are marked invalid).
- Docs: architecture, benchmarks, model choice, troubleshooting, security, contributing.

### Fixed

- A coder that outgrew the model budget could never reload.
- Thrash relief now also sheds pinned and warm helpers, as documented.
- The fast lane also exempts background work from the swap-out hold (it needs no new memory).
- A gateway evicting another client's model while that client was using it.

[Unreleased]: https://github.com/HarshKumarraghav/pitcrew/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/HarshKumarraghav/pitcrew/releases/tag/v0.1.0
