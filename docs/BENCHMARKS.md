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
- With the user's default skills, a local model would need ≥ 32k just to start, and Ollama's
  stock 4,096-token context would silently truncate ~83% of the prompt.
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
