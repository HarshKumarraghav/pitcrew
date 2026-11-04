# Breakthrough plan — local-first, any agent, any laptop

Pit Crew is a local gateway between a coding agent and Ollama. Measured so far (`docs/BENCHMARKS.md`):
with the same `qwen3.5:9b`, Pit Crew lifts routine tasks A–F from 61% → 92% and is ~3× faster than
plain OpenCode → Ollama; on hard tasks G–P the local model scores 1/8 with or without Pit Crew, while
Claude Code (Opus 4.5/4.6/4.7) scores 90–100%.

Requirements: **local-only must stand on its own** (no subscription); **bring your own agent** is
optional (Claude Code, Codex, Gemini CLI, OpenCode, Aider — Pit Crew may hand *only* stuck tasks to
it); **adapts to the machine** down to 8 GB; proven with **public, repeatable numbers**.

Claim we aim for: *"A free model on an ordinary laptop solves most real coding work — hard tasks
included — and, if you already have a cloud agent, gets near-frontier results for a fraction of its
usage."*

## Success criteria (fixed before measuring; published either way)

| # | claim | today | target |
|---|---|---|---|
| T1 | local-only hard tasks (G–P, fixed, not eased) | 13% | **≥ 40%** |
| T2 | local-only routine A–F | 92%, ~2 min/task | **≥ 95%, ≤ 90 s/task** |
| T3 | local-first + BYO agent | — | **≥ 95% of that agent's solo success, ≤ 30% of its usage** |
| T4 | public benchmark score | — | **Aider polyglot (Python+JS subset)** local-only and BYO; SWE-bench-verified-mini (50) as stretch |
| T5 | other machines | 24 GB | **8 / 16 / 24 / 32 GB** reports, pressure never "critical" |
| T6 | 8 GB laptop | — | **routine ≥ 60% local-only**, fully automatic setup |

"Breakthrough" = T1 + T3 + T4 met. Anything missed is reported as measured.

## What exists (reuse, don't rebuild)

- Gateway `src/server/http.ts` — `proxyModelRequest` (OpenAI chat/completions/responses, native), `leaseLlm`,
  `StreamTap` (telemetry), `warmUp`, reconcile loop, job endpoints. **No `/v1/messages`.**
- Router `src/server/router.ts` (`classify`, `route`, modes A/B/C) and levers `src/server/levers.ts`
  (`classifyStep`, `applyLevers`: `reasoningBudget`, `injectContext`, `planFirst`, `loopHints`, `testRepair`;
  all off by default; OpenCode-specific tool names in `workingDir()`/READ_ONLY).
- Scheduler `src/scheduler/scheduler.ts` — admission policies, primary/aggressive, fast lane, `maxResidentGiB`
  recycle, thrash controller. **No exclusive mode, no model escalation.**
- Setup `src/setup/{catalog,init,doctor}.ts` (uncommitted, other session) — `tierFor()` 8/16/24/32/48 GB,
  `recommend()`, OpenCode profile writer.
- Intel `src/intel/*` (`scanProject`, `retrieve`, `formatContext`), learn `src/learn/examples.ts`.
- Bench: `bench/agent/{run.mjs,lib.mjs,tasks.mjs,interleave.sh,selftest.mjs}`, `bench/configs/make.mjs`,
  `bench/summarize.mjs`, `bench/tools/mark-slept.mjs`, `bench/load/run.ts`, `bench/e2e.sh`. Agents in harness:
  `opencode`, `claude` (dontAsk + allow-list).
- Known bug found in exploration: `pitcrew-levers-all-r1/L` — model emitted tool calls as **plain-text Qwen XML**
  (`<function=read><parameter=filePath>…`), Ollama didn't parse them, OpenCode ended the session.

## External facts verified (official docs)

- **Claude Code** → `ANTHROPIC_BASE_URL` gateway speaking Anthropic Messages (`/v1/messages`, full SSE incl.
  `message_delta`/`message_stop`, `ping`); unknown model IDs assumed 200K ctx (must declare real limit);
  headless `-p --output-format stream-json`, `--permission-mode dontAsk --allowedTools`. Anthropic does not
  officially support non-Claude models via gateways (works, unsupported). **Ollama itself serves `/v1/messages`.**
- **Codex CLI** → custom provider must speak **Responses API** (`wire_api="responses"` only); Ollama ≥ 0.13.3
  serves stateless `/v1/responses`; headless `codex exec --json -s workspace-write -a never`.
- **Gemini CLI** → `GOOGLE_GEMINI_BASE_URL` (PR #21561) but needs the **Gemini API format** → only via a
  translating proxy; headless `-p -o stream-json --approval-mode auto_edit`. Treat as helper-only / best-effort.
- **Aider** → OpenAI-compatible base URL. **OpenCode** → done.
- **SWE-bench**: official harness needs Docker (Apple Silicon experimental); verified-mini = 50 tasks, MIT.
  **Aider polyglot**: 225 Exercism tasks, unit-test checked, laptop-friendly.

## Architecture additions

```
any front-end agent ──► Pit Crew gateway ──► Ollama (local models)
 OpenCode (OpenAI chat) │  /v1/chat/completions  (exists)
 Codex (Responses)      │  /v1/responses          (exists → verify + levers)
 Claude Code (Messages) │  /v1/messages           (NEW: lease + ctx + levers, forward to Ollama /v1/messages)
 Aider (OpenAI chat)    │
                        └─ tool-call repair (NEW) · stuck signals (NEW) · exclusive mode (NEW)

pitcrew solve "<task>"  (NEW outer loop, local-first)
  attempt 1..N on 9B in git worktrees ─► judge with the repo's own tests (never hidden tests)
  └─ stuck/failed ─► exclusive mode + bigger local model (27B) ─► judge
       └─ still failed ─► helper = user's own agent (claude | codex | gemini | null) headless in a worktree ─► judge
```

## Phases (in order; each ends with tests green + numbers in `docs/BENCHMARKS.md`)

### Phase 0 — foundations (≈ 1 day)
1. **Tool-call repair** in the gateway: new `src/server/toolcalls.ts` that detects Qwen-XML / JSON-in-text tool
   calls in a streamed assistant message and rewrites them as proper `tool_calls` (OpenAI) / `tool_use`
   (Anthropic) when the request carried `tools`. Hook into the streaming path in `http.ts` (buffer only when the
   text starts like a tool call). Flag `router.repairToolCalls` (on by default after ablation).
2. Diagnose the e2e failure ("OpenCode → Pit Crew file edit"), fix.
3. Commit hygiene: each session commits only its own paths (`git add <paths>`); commit `src/setup/*` with its owner.

**Phase 0 status (11-04):**
- 0.1 done. `src/server/toolcalls.ts` handles OpenAI chat/completions, both SSE and JSON. The Anthropic
  `tool_use` side comes with `/v1/messages` in Phase 3.
  - Formats: Qwen XML with or without `<tool_call>`, Hermes JSON, and one whole-message JSON object,
    optionally in a ```json fence and with flat arguments. The last format was found in the e2e
    failure.
  - Tests: 18 unit and 2 integration. With the flag off, the output is byte-identical.
  - Real Ollama 0.40.11 streams pass through byte-identical with the flag on.
  - **The leak is rare:** 1 of ~220 saved bench runs (`L`), plus 1 of the 7 manual e2e repros that
    reached the model. It is insurance, not a T1 lever.
- 0.2 done. The e2e OpenCode failure had two causes:
  - The model wrote its tool call as a ```json block, and the session ended after one step. The flag
    repairs this.
  - `opencode run` waits for piped stdin to close, so the check hung. Fixed with `</dev/null`.
  - A lock on the shared `opencode.db` was suspected and ruled out.
- 0.3 pending. Needs the Mac on power: L × 3 for `levers-all` vs `levers-minus-toolcalls`, A–F × 1 for
  `repair-toolcalls` vs `today`. The default flips only if there is no regression.

### Phase 1 — make the local model better (≈ 3 days) → T1, T2
Extend `src/server/levers.ts` (keep levers off by default; keep the escalation rule):
- **Stuck signals**: same failing test 3×, no diff progress across N edit turns, tool-error streak → `StepInfo.stuck`.
- **Real repair loop** (`testRepair` upgrade): include the failing assertion lines (already in tool output) in the hint.
New `src/solve/` (outer loop, uses existing `src/intel` and bench `lib.mjs` ideas):
- `worktree.ts` (git worktree per attempt, cleanup), `judge.ts` (run the project's detected test command via
  `profileProject().testCommand`; score = tests pass, fewer files/lines changed, no test weakening — reuse the
  `diffRecord`/`testsWeakened` logic from `bench/agent/lib.mjs`), `solve.ts` (attempt loop, best-of-N, stop on
  first passing attempt, time budget), `agents/opencode.ts` (headless `opencode run --format json`).
- CLI `pitcrew solve "<task>" [--repo] [--attempts 3] [--budget 15m]` in `src/cli.ts`.
- Ablations via `bench/configs/make.mjs` (+ `repair-toolcalls`, `stuck`, `best-of-3`) through `interleave.sh`.

### Phase 1 builds on what exists

Already built (`src/server/levers.ts`, flags under `router.*`, all **off by default**, configs in
`bench/configs/*.json`, unit + integration tests) — extend these, don't add a parallel path:

| Phase 1 item | existing lever | state |
|---|---|---|
| budget per step | `router.reasoningBudget` (step classes: first / after-read / after-edit / after-test-fail / after-error / repeat). Measured: qwen3.5 ignores `reasoning_effort: "low"`; only `"none"` works | built |
| retrieval | `router.injectContext` (byte-stable block appended to the system prompt per session) | built |
| plan first | `router.planFirst` (in the same stable block) | built |
| stuck signals | `router.loopHints` (3× identical tool call; edit-miss hint with the current file excerpt) | partial — add "same failing test 3×", "no diff progress", "tool-error streak" → `StepInfo.stuck` |
| real repair loop | `router.testRepair` (hint after failing test output) | partial — quote the failing assertion lines in the hint |
| best-of-N | — | **not built** → `src/solve/` |
| tool-call repair | `router.repairToolCalls` (Phase 0) | built, off until ablation |
| escalation rule | repeat / error / test-fail → full thinking | built, keep |
| cap memory growth | `maxResidentGiB` + idle recycle (`docs/PLAN.md` M9.1) | done |

Lever evidence so far: n = 1 on G–P (levers-all 1/9 vs baseline 1/8). Every comparison runs through
`bench/agent/interleave.sh` (interleaved order, power-log sleep check). **G–P stay fixed** (not eased),
so T1 remains a real test.

### Phase 2 — bigger brain on the same laptop (≈ 2 days + download) → T1, T5
- Scheduler: `AcquireRequest.exclusive` → evict every idle unit, pause background, hold new loads until released
  (`src/scheduler/scheduler.ts`; tests in `test/scheduler.test.ts`).
- Catalog: add Qwen3.8-27B low-bit (`hf.co/unsloth/Qwen3.8-27B-GGUF:IQ3_XXS` ≈ 11 GB) and Qwen3.6-35B-A3B low-bit;
  `tierFor` offers them only where they fit in exclusive mode; tool-call smoke test before use.
- `solve` cascade: 9B attempts → 27B attempt in exclusive mode → (Phase 3) helper.

### Phase 3 — any agent, front-end and helper (≈ 4 days) → T3
- **Front-ends**:
  - Claude Code: new `src/server/anthropic.ts` — `/v1/messages` (+ `count_tokens` estimate, `HEAD /api/hello`),
    lease/ctx/router like `proxyModelRequest`, forward to Ollama `/v1/messages`, stream byte-for-byte; levers via a
    small Messages↔internal adapter (system/tool_result shapes). Launcher `bin/claude-local` sets
    `ANTHROPIC_BASE_URL=http://127.0.0.1:11500`, `ANTHROPIC_AUTH_TOKEN=pitcrew`, model + declared context
    (never edits the user's Claude settings).
  - Codex: verify `/v1/responses` passthrough end-to-end; make `classifyStep`/levers read Responses `input` items;
    launcher `bin/codex-local` using `codex -c model_provider=…` overrides (no global config edits).
  - Aider: document OpenAI-compatible settings. Gemini CLI: documented as helper-only (needs Gemini-format proxy).
  - Generalise OpenCode-specific tool names in `levers.ts` via per-agent tool maps.
- **Helpers** (`src/solve/agents/{claude,codex,gemini}.ts`): `detect()` (binary present + logged in, never read
  credentials) and `run(task, worktree, budget)` headless with no permission bypass (Claude: `dontAsk` +
  allow-list as in `bench/agent/run.mjs`; Codex: `exec --json -s workspace-write -a never`; Gemini:
  `-p -o stream-json --approval-mode auto_edit`). Handoff package = task + `pitcrew context` files + failing test
  output + local best diff.
- Config `helper: { agent: null | "claude" | "codex" | "gemini", maxPerDay }` — **default null**; `pitcrew agents`
  lists what is installed; dashboard and solve report show local vs escalated and helper usage.

### Phase 4 — any laptop, from 8 GB (≈ 1–2 days) → T5, T6
- Finish `src/setup/catalog.ts` tiers (8 GB: 2B/4B coder, no second model, 16k ctx, idle unload 2 min; helpers on
  the same model with thinking off). Live downgrade when headroom shrinks (scheduler hook + dashboard notice).
- `pitcrew init` configures every detected front-end agent and recommends helper only if one is installed.
- **8 GB simulation** on this Mac: `memory.maxModelMemoryGiB = 3.5` + 8 GB tier config, run A–F (labelled
  "simulated 8 GB"); community hardware-report template already exists (`.github`).

### Phase 5 — proof (≈ 3 days of runs) → T1–T6
- `bench/agent/run.mjs`: add `--agent codex|gemini` (same allow-list philosophy) and `--solve` mode.
- New `bench/public/polyglot.mjs`: Aider polyglot Python+JS exercises, sandboxed in temp dirs, scored by their
  unit tests; stretch `bench/public/swebench-mini.mjs` using the official harness in Docker.
- Matrix (3 repeats, interleaved, Mac awake + on power, `mark-slept` check): plain OpenCode→Ollama · Pit Crew today ·
  Pit Crew + levers · `solve` local-only (9B) · `solve` cascade (9B→27B) · `solve` + Claude Code helper · + Codex
  helper · each cloud agent solo · 8 GB simulated · front-ends (Claude Code / Codex on local models).
- `bench/summarize.mjs`: add escalation rate, cloud usage per solve, solved/hour, per-tier tables.

### Phase 6 — release (≈ 2 days)
- README leads with the measured table (incl. failures); `docs/BENCHMARKS.md`, `docs/MODELS.md`,
  `docs/AGENT_SETUP.md` per agent; file `docs/opencode-issue.md` upstream (user approval); npm publish and
  GitHub release only with user approval.

## Risks (stated in the write-up)
- Best-of-N/repair cost time (T1 vs T2 tension) — report solved/hour next to pass rate.
- 27B at 3-bit may break tool calling or not fit beside a browser — smoke test, report.
- Claude Code on non-Claude models is unsupported by Anthropic; Codex requires Responses API; Gemini needs a proxy.
- Laptop runs are noisy (sleep, Docker, other sessions) — interleave, machine-state log, sleep invalidation.
- Three sessions share this repo — coordinate runs and commits explicitly.

## Verification
- Every phase: `npm run typecheck && npm test` (mock backend), new unit/integration tests for toolcall repair,
  stuck signals, exclusive mode, `/v1/messages` streaming (event order incl. `message_stop`), Responses levers,
  helper adapters (fake CLIs), tier selection.
- `bench/agent/selftest.mjs` (tasks still valid) and `bench/e2e.sh` (all checks pass, incl. new endpoints).
- Real end-to-end: `bin/claude-local` and `bin/codex-local` each complete task E and C on local models; `pitcrew solve`
  completes a G–P task locally; helper path completes a task with `helper.agent` set and makes zero cloud calls
  when it is null (`bench/tools/netwatch.sh`).
- Final numbers: `bench/summarize.mjs` tables for T1–T6 with spreads, written to `docs/BENCHMARKS.md`.
