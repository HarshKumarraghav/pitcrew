# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-04

First public release. Tested on macOS 26 / Apple M5 24 GB / Ollama 0.40 / OpenCode 1.18.

### Added

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
