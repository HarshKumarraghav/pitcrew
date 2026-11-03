# Contributing

```sh
npm install          # typescript + @types/node (dev only)
npm test             # unit + integration tests; no GPU or Ollama needed (mock backend)
npm run typecheck
npm run dev -- audit # run the CLI from source (Node ≥ 22.6, type stripping)
```

Ground rules

- **Zero runtime dependencies.** Node standard library only. Dev dependencies are fine.
- **Erasable TypeScript only** (no enums, namespaces or parameter properties) so the source runs
  directly with `--experimental-strip-types`.
- **Every scheduler behaviour gets a test** in `test/scheduler.test.ts` using the fake machine.
- **Benchmarks report measurements, not impressions.** Put raw results under `bench/**/results/`
  (git-ignored) and summarise in `docs/BENCHMARKS.md` with machine, versions and background load.
  Label estimates as estimates.
- Hardware reports are welcome: run `pitcrew audit`, `pitcrew garage` and the agent suite and open an
  issue with the output.
