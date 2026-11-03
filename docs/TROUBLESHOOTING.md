# Troubleshooting

**A request hangs in the queue with "needs X G; only Y G free after reserves".**
The model does not fit current headroom and nothing idle can be evicted. Options: close apps; mark
your main model `"primary": true` (it may then load past soft headroom while memory is not
thrashing); lower `minCtx`; use a smaller model. `pitcrew garage` shows estimates vs headroom.

**"context too large" (HTTP 400).**
Prompt + output exceed the alias `maxCtx`. Raise `maxCtx` (KV cost: `pitcrew garage`) or let OpenCode
compact. Pit Crew refuses rather than silently truncating.

**The first agent step takes minutes.**
Check whether OpenCode's `small_model` points at a thinking model on the same backend. Use the
`auto` router model (helpers go to a light model with thinking off) — see `docs/BENCHMARKS.md`.

**OpenCode's prompt is huge (20k+ tokens).**
Skills from `~/.claude/skills` and `~/.config/opencode/skills` are listed in every request.
`bin/opencode-local` sets `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`
and disables the `skill`, `task`, `webfetch` tools (measured: 24.3k → 5.9k tokens).

**Memory keeps growing after the model loaded.**
Ollama's MLX runner caches prompts; resident size can double during long sessions. Pit Crew tracks
the live size from `/api/ps`. `curl -XPOST localhost:11500/governor/unload -d '{"model":"coder"}'`
frees it immediately; idle models unload after `idleUnloadMs`.

**"unloaded externally" events.**
Ollama's own scheduler (or `ollama stop`) unloaded a model. Pit Crew notices within 2 s.

**Many `pitcrew/...` entries in `ollama list`.**
Derived context variants (metadata only; weights shared). Remove with `pitcrew clean --yes`.

**Backend unreachable (502).**
Start Ollama (`ollama serve` or the app) or set `backend.url` / `PITCREW_BACKEND`.
