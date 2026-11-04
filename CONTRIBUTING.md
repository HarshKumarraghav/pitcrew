# Contributing

Thanks for helping. Bug reports, hardware reports, docs fixes and code are all welcome. New here?
Start with a [good first issue](https://github.com/HarshKumarraghav/pitcrew/labels/good%20first%20issue),
or ask in [Discussions](https://github.com/HarshKumarraghav/pitcrew/discussions).

## Setup

```sh
npm install          # typescript + @types/node (dev only)
npm test             # unit + integration tests; no GPU or Ollama needed (mock backend)
npm run typecheck
npm run dev -- audit # run the CLI from source (Node ≥ 22.6, type stripping, no build step)
npm run build        # dist/ for the npm package
```

You don't need a Mac, a GPU or Ollama for most changes. CI runs on Ubuntu and macOS with Node 22
and 24.

## Ground rules

- **Zero runtime dependencies.** Node standard library only. Dev dependencies are fine.
- **Erasable TypeScript only** (no enums, namespaces or parameter properties) so the source runs
  directly with `--experimental-strip-types`.
- **Every scheduler behaviour gets a test** in `test/scheduler.test.ts` using the fake machine.
- **Local only.** No outbound network calls from the gateway, no cloud models, no prompt text in
  logs. See [SECURITY.md](SECURITY.md).
- **Benchmarks report measurements, not impressions.** Put raw results under `bench/**/results/`
  (git-ignored) and summarise in `docs/BENCHMARKS.md` with machine, versions and background load.
  Label estimates as estimates.

## Project map

| path | what lives there |
|---|---|
| `src/cli.ts` | the `pitcrew` command: `init`, `doctor`, `serve`, `audit`, `garage`, `scout`, `context`, `status`, `learn`, `tune`, `clean` |
| `src/config.ts` | config types, defaults (`DEFAULTS`), loading and validation |
| `src/setup/` | `init` (model catalog and recommendation by memory tier, pulls, config + OpenCode profile) and `doctor` |
| `src/scheduler/` | RAMbo: admission against real headroom, LRU eviction, priorities, queueing, thrash control |
| `src/server/http.ts` | the OpenAI/Ollama-compatible gateway, `/governor/*` endpoints, warm-up, reconcile loop |
| `src/server/router.ts` | the `auto` model: helper vs agent classification, modes A/B/C |
| `src/server/context.ts` | prompt-size estimate and context-window choice |
| `src/server/levers.ts` | per-step agent levers (reasoning budget, loop hints, test repair) |
| `src/server/telemetry.ts`, `metrics.ts` | per-request timing from the stream, Prometheus `/metrics` |
| `src/server/gui.html` | the dashboard (one file, no build) |
| `src/models/` | model registry, derived per-context models, memory footprint estimates |
| `src/backend/` | Ollama client, image/voice job runner (no shell) |
| `src/system/` | memory probe (macOS `vm_stat`/`sysctl`, Linux `/proc`), responsiveness probe |
| `src/intel/` | `scout`/`context`: repo scan, symbols, import graph, BM25 retrieval |
| `src/learn/` | opt-in training-example collection and export, secret scanning |
| `test/` | `node:test` suites; `mock-ollama.ts` is the fake backend |
| `bench/` | load tests and the agent benchmark (needs a real machine and models) |
| `scripts/demo/` | records the dashboard replay, builds the Pages site, the GIF and the social card |
| `docs/` | architecture, benchmarks, models, troubleshooting, the plan |

## How the tests work

Nothing in `npm test` touches a real model. Two fakes stand in for the machine:

- **`test/mock-ollama.ts`**: `startMockOllama(models, { tokenDelayMs, loadDelayMs, parallel })`
  starts a fake Ollama on a random port. It tracks which models are loaded and how big they are,
  streams OpenAI-style responses (reasoning, content, tool calls, usage) and records every call in
  `calls` and request bodies in `bodies`, so tests can assert what the backend saw.
- **A fake memory probe**: an object with `read()` that returns a `MemorySnapshot`. Tests usually
  make available memory shrink by whatever the mock reports as loaded, which is enough to force
  admission waits and evictions. See `fakeProbe` in `test/integration.test.ts`.

Scheduler-only tests (`test/scheduler.test.ts`) skip HTTP entirely and drive the scheduler with a
fake machine and fake load/unload functions.

Run one file with `node --experimental-strip-types --no-warnings --test test/router.test.ts`.

## Pull requests

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Branch from `main`, keep the change focused, and add or update tests.
3. `npm run typecheck && npm test` must pass locally; CI also runs the build, an npm-package
   check and a secret scan.
4. Describe what changed and how you checked it. Measured numbers need the machine, versions and
   background load.

## Hardware reports

Reports from other machines are very useful, especially 8/16/32/64 GB Macs and Linux boxes. Run
`pitcrew audit` and `pitcrew garage` (and the agent suite if you can) and open a
[hardware report](https://github.com/HarshKumarraghav/pitcrew/issues/new?template=hardware-report.yml).
