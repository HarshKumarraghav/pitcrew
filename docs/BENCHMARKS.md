# Benchmarks

All numbers are **measured on the reference machine** unless marked *estimate*.
Reference machine: MacBook Pro Mac17,2, Apple M5 (4S+6E CPU, 10-core GPU), 24 GB, macOS 26.3.1,
Ollama 0.40.11, OpenCode 1.18.35. Background load during runs: Chrome, Zed, Slack, Spotify
(≈ 10–12 GB); kernel memory pressure "warn" and swap ≈ 13 GB used *before* any model loaded.

## M1.3 — What OpenCode actually sends to the model

Method: OpenCode was pointed at `bench/tools/capture-server.mjs`, a fake OpenAI-compatible
endpoint that records request bodies. Prompt: "List the files in src." on the fixture repo.
`bench/tools/analyze-capture.mjs` summarises the captured requests.

| OpenCode configuration | system prompt | tool schemas | tools | est. tokens* |
|---|---|---|---|---|
| user default (global skills from `~/.claude/skills`, `~/.config/opencode/skills`) | 56,946 chars | 20,856 chars | 10 | ≈ 24,300 |
| `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` | 19,801 | 20,856 | 10 | ≈ 12,700 |
| + `tools: {webfetch:false, skill:false, task:false}` (**local profile**) | 8,873 | 15,028 | 7 | ≈ 7,500 |

\* *estimate* at 3.2 chars/token; replaced by the model's real `prompt_eval_count` in M1.6.

Breakdown of the default 57k-char system prompt: ≈ 8.7k core OpenCode instructions, ≈ 0.4k
`~/.claude/CLAUDE.md`, ≈ 48k **skill catalogue (~95 skills)**. A separate title-generation
request (≈ 2.1k chars, no tools) is sent per session via `small_model`.

**Consequences**
- An 8k context cannot hold even the trimmed agent prompt plus an output budget.
  16k is the floor; **32k is the default** for the local profile.
- With the user's default skills, a local model would need ≥ 32k just to start.
- *Correction (M4 load test):* Ollama documents a 4,096-token default, but on Ollama 0.40.11 with
  the MLX runner (`qwen3.5:9b`, no `num_ctx` set) the model reported all 5,858 prompt tokens — no
  truncation was observed. Earlier text claiming ~83% would be cut was an untested inference.
- Each skill-heavy request costs ~3× the prefill time on a local model.

## M1.4–M1.6 — qwen3.5:9b on Ollama (MLX runner), measured

Model: `qwen3.5:9b` (Ollama tag digest `d63f830f28d5`, 9.65 B params, **NVFP4**, safetensors, runner `mlx`),
derived `pitcrew/qwen3.5-9b:32k` (`num_ctx` 32768, temperature 0.6, top_p 0.95, top_k 20, presence_penalty 0).
The derived model shares weight blobs: total model storage stayed 7.6 GB.

| metric | value |
|---|---|
| cold load (wall) | 5.9 s |
| resident size after load (`/api/ps`) | 7.62 GB |
| resident size after a 5.9k-token request | 8.06 GB |
| est. available memory before → after load | 3.02 → 1.59 GB |
| swapped out by macOS during load | ≈ 5.7 GB (374k pages × 16 KiB); swap file grew 16.3 → 22.1 GB |
| OpenCode local-profile request (replayed capture), real prompt tokens | **5,858** (4.12 chars/token) |
| cold prefill | 10.0 s · 584 tok/s |
| warm prefill (same prefix, cached) | ≈ 0 s |
| decode | 23.0 tok/s (cold run) · 36.3 tok/s (warm run) |
| tool call for "List the files in src." | `glob {"pattern": "src/**/*"}` ✅ valid |

Background apps were not closed (Chrome, Zed, Slack, Spotify). Measurements are single runs; repeats in M4.

## M1.7 — finding: the session-title request blocks the agent

OpenCode sends a short, tool-less "generate a title" request to `small_model` at the start of
every session, in parallel with the first agent step. In the M1 profile `small_model` is the same
thinking model. Ollama server log for task A (13:23–13:29):

| request | duration | status |
|---|---|---|
| title (`/v1/chat/completions`, no tools) | **5 m 0 s** | **500** (runaway thinking, cut off) |
| first agent step (queued behind it, `OLLAMA_NUM_PARALLEL=1`) | 5 m 20 s | 200 |
| next 6 agent steps | 2–41 s each | 200 |

Task A still passed (8/8 hidden checks), but **340 of its 385 seconds were spent waiting for the
title request**. Fix candidates evaluated in M3/M4: route `small_model` to a small non-coding model
(`qwen3.5:0.8b`), or have the gateway cap/disable thinking for tool-less helper requests.

## M1.7 — baseline: OpenCode → Ollama direct, qwen3.5:9b @ 32k (single run)

Profile `examples/opencode/opencode.local.json` (`small_model` = same model). Harness
`bench/agent/run.mjs`, disposable git copies of `bench/agent/fixture`, hidden verifiers, permissions
auto-approved inside the temp dir only, 900 s timeout per task.

| task | result | wall | waiting before 1st step | steps | tool calls (errors) | hidden checks | suite after | peak prompt tokens |
|---|---|---|---|---|---|---|---|---|
| A codegen + tests | ✅ | 385 s | 343 s | 6 | 9 (0) | 8/8 | 14/14 | 9,157 |
| B repo understanding | ✅ | 170 s | 94 s | 6 | 16 (0) | rubric ≥7/9, no edits | 9/9 | 12,742 |
| C multi-file feature | ✅ | 488 s | 288 s | 11 | 22 (0) | 6/6 | 15/15 | 14,796 |
| D debugging | ✅ | 153 s | 130 s | 7 | 6 (1) | tests untouched | 9/9 | 8,534 |
| E tool execution | ✅ | 294 s | 272 s | 4 | 4 (0) | counts correct, no edits | 9/9 | 6,941 |
| F multi-step reliability | ❌ timeout | 900 s | 524 s | 22 | 28 (2) | 3/4 | 9/10 | 18,724 |

**5/6 tasks passed.** Total wall time 2,390 s, of which **1,651 s (69%) was spent waiting for the
first agent step** behind OpenCode's title request on the same thinking model.
F failed on the planted trap: `GET /tasks/stats` registered after `GET /tasks/:id` is shadowed (404);
the agent's own new test caught it and it was still iterating when the timeout hit.
Tool errors: one `todowrite` schema error (missing `status`), one no-op `edit`, one in D (recovered).

Memory during the session: kernel pressure stayed at "warn"; swap used grew 22.8 → 29.4 GB;
**the 9B model's resident size grew from 8.06 GB to 17.05 GB** as Ollama's MLX runner cached long
prompts — load-time size is not a safe estimate of steady-state size.

### Helper requests: thinking off

`qwen3.5:0.8b`, title-generation prompt, `/v1/chat/completions`, `max_tokens` 512:

| setting | time | completion tokens | reasoning chars | title |
|---|---|---|---|---|
| default (thinking on) | 14.4 s | 512 (cap) | 2,047 | *(empty)* |
| `reasoning_effort: "none"` | **0.2 s** | 3 | 0 | `redirect_login_error` |

→ the router now caps helper output and sends `reasoning_effort: "none"`.

### Network check (M1.8) — partially inconclusive

During the M1 run, `lsof` saw non-loopback connections from processes named `opencode` to
`api.opencode.ai` and from `ollama` to `registry.ollama.ai` / Cloudflare R2. The Ollama ones match the
two model pulls running at the time. The watcher matched by process name and two unrelated
long-running `opencode acp` processes (editor integration using the user's *global* config) were
alive, so the OpenCode connections cannot be attributed. Controlled re-runs with the local profile
(capture backend, 25 s each, per-PID watcher) showed **no** non-loopback connections. All model
requests in the Ollama log came from 127.0.0.1. Re-verified per-PID in M4.

## M4 — routine tasks A–F: direct vs Pit Crew modes (measured, 11-03)

Same model (`qwen3.5:9b`, NVFP4, Ollama 0.40.11), same OpenCode 1.18.35, same six tasks and hidden
verifiers. All runs below finished by 17:51 on 11-03, before the machine's overnight sleep.
Docker Desktop (≈ 4.5 GB VM) was running from ≈ 15:30, i.e. during Direct r2/r3 and mode C r2.

| configuration | runs | passed per run | pass rate | wall per 6-task run | avg wait before 1st agent step |
|---|---|---|---|---|---|
| Direct — OpenCode → Ollama, `small_model` = same model | 3 | 5/6, 3/6, 3/6 | **61%** | 2,391 / 3,036 / 3,191 s | 275–370 s |
| Pit Crew mode A — single model, helper requests capped, thinking off | 1 | 5/6 | 83% | 1,166 s | 9 s |
| Pit Crew mode B — helpers → 0.8B, sequential | 1 | 6/6 | 100% | 1,256 s | 18 s |
| Pit Crew mode C — helpers → 0.8B only if it fits without eviction | 2 | 6/6, 5/6 | **92%** | 1,536 / 686 s | 20 s |
| Pit Crew mode C + "breakthrough" gateway changes (separate config) | 1 | 5/6 | 83% | 1,381 s | 11 s |

Per task (passes / runs): Direct A 3/3 · B 1/3 · C 1/3 · D 3/3 · E 3/3 · F 0/3; mode C (r1–r2)
A 2/2 · B 2/2 · C 2/2 · D 2/2 · E 2/2 · F 1/2. Task F contains a route-shadowing trap
(`/tasks/stats` registered after `/tasks/:id`); it is the hardest of A–F.

**Reading it:** the model is identical, so the gain is not "a smarter model". It comes from removing
the session-title stall (helper requests no longer block the agent) and from not swapping the coder
out. Small samples (1–3 runs); treat the A/B/C ordering as unresolved.

## M4 / M10 — load test: 6 concurrent clients over 3 models

2 clients send the real 5,858-token OpenCode request to the 9B coder, 2 chat with `qwen3.5:2b`, 2
ask `qwen3.5:0.8b` for titles; 3 rounds each = 18 requests per run. No truncation in any mode.

**Current results (11-03 17:53–18:01 IST, Mac awake, 3 interleaved repeats, median (min–max)):**

| round | mode | total wall | title p50 | agent p95 | background chat p95 | swapped out | s critical |
|---|---|---|---|---|---|---|---|
| 1 (`summary-2026-11-03T12-23-32-972Z.json`) | direct, coder 32k | **40.0 s** (39.6–48.3) | 0.21 s | 31.0 s | 8.5 s | 0.50 (0–5.36) GB | 0 |
| 1 | Pit Crew | 47.1 s (46.7–50.3) | 0.22 s | **15.4 s** | 33.5 s | 1.09 (0.54–1.14) GB | 0 |
| 2 (`summary-2026-11-03T12-31-37-531Z.json`, after two fixes) | direct, coder 32k | **39.9 s** (38.1–42.3) | 0.22 s | 27.9 s | 16.2 s | 3.32 (0–3.54) GB | 0 |
| 2 | Pit Crew | 43.0 s (42.7–49.4) | 0.25 s | **14.9 s** | 32.8 s | **0.13** (0–1.57) GB | 0 |

**Reading it:** Pit Crew is still ~8% slower in total time. It roughly halves the agent's worst-case
latency (p95 27.9 → 14.9 s) and in round 2 swapped out less (median 0.13 vs 3.32 GB, but the ranges
overlap). The price is background chat: its p95 doubles (16 → 33 s) because interactive work goes first.
All 18/18 requests succeeded in every mode. Details: `docs/PLAN.md` M10.6.

*Superseded:* a single run on 11-03 15:28 with the earlier gateway (Docker running) gave Pit Crew
83 s vs 41 s direct; kept in `bench/results/load/` for the record.

## End-to-end check (`bench/e2e.sh`, 11-03 15:31)

27 / 28 checks passed (tests, typecheck, build, every CLI command, every gateway endpoint against
real Ollama, router, cloud refusal, oversize refusal, streaming, native API, metrics, dashboard).
Failed: "OpenCode → Pit Crew edits a file" — after 17 s no `src/version.ts` existed; not yet
diagnosed.

## Validity notes

- The Mac slept (clamshell, lid closed) 11-03 18:22 → 11-04 00:52 and again 04:00 → 04:04
  (`pmset -g log`). Runs overlapping a sleep measure nothing and are marked `invalid` and excluded.
  An earlier explanation of Claude Code "stalls" as rate limiting was wrong — they were sleep.
- Machine state per task is logged in `bench/agent/results/machine-state.log`.
