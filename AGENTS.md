# Notes for coding agents

**Setting Pit Crew up for a user?** Follow [docs/AGENT_SETUP.md](docs/AGENT_SETUP.md):
`npx pitcrew-ai init --json` → explain the plan → `init --yes` → `serve` → `doctor`.

**Working on this repository?** Read [CONTRIBUTING.md](CONTRIBUTING.md). In short:

- Zero runtime dependencies; erasable TypeScript only (runs with `--experimental-strip-types`).
- `npm run typecheck && npm test` must pass. Tests use `test/mock-ollama.ts` and a fake memory
  probe; they need no GPU or Ollama.
- Every scheduler behaviour gets a test in `test/scheduler.test.ts`.
- Local only: no outbound calls from the gateway, no cloud models, no prompt text in logs.
- Measured numbers need machine, versions and background load; label estimates.
- `docs/PLAN.md` is the resume point (`NEXT →` markers).
