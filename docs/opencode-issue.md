# Draft issue for OpenCode — not filed

> Filing this is the maintainer's call (user). Nothing here has been posted anywhere.

**Title:** Session-title request can block the first agent step for minutes on local reasoning models

**Version:** OpenCode 1.18.35 · Ollama 0.40.11 (`/v1` OpenAI-compatible) · macOS 26.3.1, Apple M5, 24 GB

## What happens

At the start of every session OpenCode sends a short, tool-less "generate a title" request to
`small_model`, in parallel with the first agent step. If `small_model` is not set it falls back to
the main model. With a local reasoning model (e.g. `qwen3.5:9b` on Ollama) that means:

1. The title request is sent with `reasoning_effort: "low"` and `max_tokens: 8192` (captured with a
   fake OpenAI-compatible server, see below). Ollama's Qwen 3.5 models treat any non-`none`
   effort as "think", so the model reasons freely about a one-line title.
2. Local servers usually serve one request per model at a time (`OLLAMA_NUM_PARALLEL=1` here), so
   the **first agent step queues behind the title**.

Measured (single run, task "create `chunk()` + tests"): the title request ran **5 min 0 s and
ended with HTTP 500**; the first agent step waited 5 min 20 s behind it; the task took 385 s, of
which 343 s was waiting. Over six tasks, 1,651 of 2,390 s (69%) was spent waiting on title requests.

## Evidence

Captured request body (main model used as small model, abbreviated):

```json
{ "model": "…", "max_tokens": 8192, "reasoning_effort": "low",
  "messages": [ { "role": "system", "content": "You are a title generator. You output ONLY a thread title. …" },
                { "role": "user", "content": "Generate a title for this conversation:\n" },
                { "role": "user", "content": "\"Fix the failing tests\"" } ], "stream": true }
```

Same prompt on `qwen3.5:0.8b`, `max_tokens` 512: default thinking → 14.4 s, 512 tokens all
spent on reasoning, **empty title**; `reasoning_effort: "none"` → 0.2 s, 3 tokens, a usable title.

## Workaround we use

Set `small_model` to a small model with thinking off; OpenCode forwards provider options, and the
title request then carries `reasoning_effort: "none"` and `max_tokens: 512` (verified by capture):

```json
"small_model": "local/helper",
"provider": { "local": { "models": { "helper": {
  "id": "qwen3.5:0.8b", "reasoning": false, "options": { "reasoningEffort": "none" } } } } }
```

## Suggestions

- Send title requests with reasoning disabled (`reasoning_effort: "none"` / `think: false`) and a
  small `max_tokens` (e.g. 64), regardless of which model serves them.
- Don't let the first agent step wait on the title: generate the title after the first step, or
  cancel it if it is still running when the agent needs the model.
- Document that `small_model` falls back to the main model, and that this is slow for local reasoning models.

Repro: `bench/tools/script-server.mjs` (scripted fake model that records request bodies) and
`bench/agent/run.mjs` in https://github.com/… (Pit Crew), profile `examples/opencode/opencode.local.json`.
