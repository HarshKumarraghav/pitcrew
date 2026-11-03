# Execution Plan — OpenCode-first local coding platform

**How to resume:** read this file top to bottom. `NEXT →` shows where work stopped. Each
task has a check that proves it is done. Tick the box and append to the progress log when
a task finishes. Architecture: `docs/ARCHITECTURE.md`.

> NEXT → Agent runs need the Mac **awake** (lid open / external display): restart stage 1 (`bench/agent/interleave.sh "G…P" "baseline cap levers-all" 1 1`, runs under caffeinate; slept runs are auto-marked invalid). Then S3, repeats, ablations.

**Objective:** maximise *successful coding tasks per unit of time and hardware* on a 24 GB
Apple Silicon Mac, with **OpenCode as the only coding-agent interface**, local models only.

```
OpenCode (agent: tools, edits, approvals, sessions)
   │  OpenAI-compatible provider (127.0.0.1)
   ▼
Pit Crew  ── task router (modes A/B/C) ── resource scheduler ── lifecycle manager
   │                │                              │
   │                └─ product intelligence ◄──── retrieval index (symbols, BM25, deps, opt. embeddings)
   ▼
Ollama (Metal)  ·  optional: llama.cpp / MLX  ·  optional job runners (image/TTS)
```

## The three goals (set 2026-11-03) and honest feasibility

| # | goal | feasible on a 24 GB Mac, local only? | target we commit to | milestone |
|---|---|---|---|---|
| 1 | answers comparable to Claude 4.5 / 4.6 / 4.7 | **Not in general.** A 9B model cannot match frontier models on hard tasks. On routine tasks it already passes (A–E). | Same tasks and verifiers for Claude Code and local. **Parity on routine tasks; measure the gap on hard tasks and shrink it**, and publish it either way | M8 |
| 2 | faster than plain OpenCode + Ollama | **Yes.** Already 2,390 s → 1,166 s on A–F (mostly the title fix) | ≥ 2× solved tasks/hour vs the *fair* baseline (title fix included) at equal quality | M7 |
| 3 | coding + voice + image/video models without eating all RAM | **Yes, if the large ones take turns.** Coder + speech-to-text + text-to-speech can stay loaded together; image/video (≈ 8–16 GB each, *estimate*) cannot share memory with the coder | Every model is available through one endpoint; the scheduler decides what is in memory; pressure never reaches "critical" | M9 |

**The goals pull against each other.** Quality techniques (repair loops, retries) spend time (goal 2),
and a bigger model would spend RAM (goal 3). Every change is measured on all three: pass rate and review score,
solved tasks/hour, and peak memory plus swap-out rate.

**Memory reality (measured 2026-11-03):** swap 36.8 of 37.9 GB used; the 9B coder showed **17 GB**
in `ollama ps` (8 GB at load). Capping that growth (M9.1) is the biggest single win for goal 3.

---

## Audit summary (2026-11-02, read-only)

| | measured |
|---|---|
| Machine | MacBook Pro `Mac17,2`, **Apple M5** (4 Super + 6 Efficiency cores, 10-core GPU, Metal 4) — the brief said M4 |
| RAM | 24 GB unified; Metal `recommendedMaxWorkingSetSize` 19.07 GB (Ollama: 17.8 GiB) |
| Live load | Chrome ≈ 5 GB, Zed ≈ 1.9 GB, Spotify ≈ 1.6 GB, Slack, node; Docker VM (8 GB) seen at first, later stopped |
| Pressure | kernel level **2 (warn)** before any model loaded; est. available 2.8 GB; swap 13.1–13.7 / 14.3 GB used |
| Disk | 994 GB APFS SSD, ≈ 206 GB free |
| OS | macOS 26.3.1 (25D771280a); on battery |
| Network | 1–4 MB/s → ~5–15 min per GB downloaded |
| Ollama | 0.40.11 (app) on 127.0.0.1:11434; default ctx **4096**; cloud enabled; only `kimi-k2.5:cloud`; aliases route `claude-*` → cloud |
| OpenCode | 1.18.35; global default `freellmapi/auto` → localhost proxy that routes to **free cloud models** |
| Other runtimes | llama.cpp 0.8.0 (brew), whisper-cli; no MLX-LM; uv 0.10.12; Node 22.16, Python 3.9 (system), git 2.50 |
| Local assets | HF cache 51 GB (TTS/image/STT models, no coding LLM) |

## Model decision (evidence so far)

| candidate | type | Q4 weights | fits beside apps? | verdict |
|---|---|---|---|---|
| Qwen3.8-27B (Aug 2026) | dense, hybrid attn | 17–18 GB | no (GPU limit 17.8 GiB, ~3–8 GB free) | too big for this Mac today |
| Qwen3.6-27B | dense | 17 GB | no | too big |
| Qwen3.6-35B-A3B / Qwen3.5-35B-A3B | MoE 3B active | 22 GB | no | MoE still needs all weights resident |
| Qwen3-Coder-30B-A3B | MoE | 19 GB | no | too big |
| Devstral Small 2 24B | dense | 15 GB | barely, heavy swap | not comfortable |
| Gemma 4 26B-A4B QAT | MoE | 16 GB | barely | not comfortable |
| **Qwen3.5-9B** | dense, hybrid DeltaNet (8/32 layers KV) | **6.6–7.6 GB** | **yes**; KV ≈ 32 KB/token → 32k ctx ≈ 1 GB | **M1 baseline** |
| Gemma 4 12B QAT | dense | 7.2 GB | yes | comparison candidate |
| Qwen3.5-2B / 0.8B | dense | 1.9 / 1.0 GB | yes | light-model role (modes B/C) |
| Qwen3-Embedding-0.6B | embedding | ~0.6 GB | yes | only if retrieval eval shows benefit |

Runtime: **Ollama** first (installed, documented OpenCode path, Qwen tool parser). llama.cpp
can load the same GGUF blob for a zero-download speed comparison; MLX only if measured better.

---

## M1 — Hardware audit + working baseline
- [x] M1.1 read-only audit (above)
- [x] M1.2 model + runtime research and recommendation (above)
- [x] M1.3 measure the exact prompt OpenCode sends (system + tool schemas) → choose context
      ✔ check: token count recorded in `docs/BENCHMARKS.md`
- [x] M1.4 `qwen3.5:9b` downloaded; `/api/show` metadata recorded; derived `num_ctx` model created
- [x] M1.5 OpenCode local profile (`examples/opencode/opencode.local.json` + `bin/opencode-local`):
      only local provider, `small_model` local, share off, autoupdate off, models.dev fetch off;
      global config untouched
- [x] M1.6 verify local inference (curl) + tool calling (OpenCode `run` reads/edits/executes)
- [x] M1.7 agent tasks A–F (`bench/agent`) → success, TTFT, wall time, tool errors, memory, swap
- [~] M1.8 prove no cloud routing: `lsof` of OpenCode/Ollama during a run shows only 127.0.0.1
- [x] M1.9 document baseline in `docs/BENCHMARKS.md`

## M2 — Product intelligence
- [x] M2.1 `pitcrew index <repo>`: languages, frameworks, entry points, scripts, tests, deps
      (deterministic: manifests, file tree, import graph, git history) → stored in
      `~/.pitcrew/projects/<id>/` (never inside the repo)
- [x] M2.2 artifacts: PRODUCT_OVERVIEW.md, ARCHITECTURE.md, MODULE_MAP.json,
      DEPENDENCY_GRAPH.json, ENGINEERING_CONVENTIONS.md, TESTING_GUIDE.md (LLM only for synthesis)
- [x] M2.3 retrieval: symbol index + BM25 + dependency expansion; `pitcrew context "<task>"`
- [ ] M2.4 OpenCode integration: instructions file + custom command/tool that calls `pitcrew context`
      ✔ check: retrieval precision@k on fixture tasks; unit tests

## M3 — Multi-model scheduling
- [x] M3.1 resource scheduler: admission, eviction, priorities, thrash control (12 tests)
- [x] M3.2 job adapter for non-LLM models (5 tests)
- [x] M3.3 HTTP gateway: OpenAI-compatible streaming proxy, tool-call passthrough, cancellation,
      timeouts, `/governor/state`, SSE, metrics ✔ integration tests with mock Ollama
- [x] M3.4 task router: modes A (single), B (sequential light+strong), C (resource-aware hybrid)
- [x] M3.5 CLI: `serve`, `status`, `plan`, `doctor`, `clean`

## M4 — Comparative evaluation
- [ ] M4.1 harness configs: single (no context) · single + context · B · C
- [ ] M4.2 task set: understanding, single-file, multi-file, bug fix, test gen, refactor,
      regression diagnosis, review (extend `bench/agent`)
- [ ] M4.3 ≥ 3 repeats per config; report mean ± spread; measured vs estimated separated
- [ ] M4.4 `docs/BENCHMARKS.md` with results and resources per successful task

## M5 — Learning pipeline
- [x] M5.1 reviewed-example collector (opt-in; patch + context + passing tests; secret scan; provenance)
- [x] M5.2 dataset validator + export to MLX-LM LoRA format
- [~] M5.3 LoRA job (explicit command only, resource-budgeted, never automatic); verify base-model support
- [ ] M5.4 4-way eval (base/±retrieval × finetuned/±retrieval); promote only on significant gain

## M6 — Observability + release
- [~] M6.1 terminal-style dashboard (`/`) — measured vs estimated clearly labelled
- [x] M6.2 README, MODELS.md, SECURITY.md, CONTRIBUTING.md, TROUBLESHOOTING.md, ROADMAP.md, LICENSE
- [~] M6.3 CI (typecheck + tests, ubuntu + macos), `npm run build`, clean-clone install check
- [ ] M6.4 rollback doc; final report

## M10 — Load-test fixes (before M7): make Pit Crew win the load test honestly

**Evidence (single runs, `bench/results/load/*.json`, 11-03):** total 83 s through Pit Crew vs 41 s direct at 32k;
agent p95 better (20 s vs 34 s) but title p50 4.5 s vs 0.8 s. Causes from `/tmp/load-gw-governed.log`:
R-a degraded mode capped *all* work at 1, so 0.2 s titles queued behind 3 s coder calls on an already-loaded model;
R-b the 0.8B helper was refused at start (strict policy under "warn"); R-c background only ran at pressure "ok",
which this Mac never reports while busy → `mid` waited 61–65 s for aging; R-d one request per model; R-e one run each.

- [x] M10.1 **fast lane** (R-a): a request for a ready unit with a big enough window skips the global/degraded
      cap (per-unit `parallel` still applies). Degraded mode still holds new loads and evicts idle models;
      it now recovers after 20 s without critical/swapping (it used to wait for kernel "ok").
- [x] M10.2 **warm helpers** (R-b): alias flag `warm: true` loads + pins at gateway start; models ≤ 1.5 GB
      keep the `balanced` inactive-memory credit at "warn" (never at "critical").
- [x] M10.3 **background gating** (R-c): background waits only at "critical" or while the swap-out rate is
      above `thrashSwapoutMiBps`; a background request may evict an idle model once it has been idle 3 s
      (`scheduler.backgroundEvictIdleMs`); 60 s aging kept.
- [x] M10.4 **per-model parallelism** (R-d): `backend.parallel: "auto"` probes an external server with 4
      concurrent requests at start-up (managed: env value). Unit slots = min(alias `parallel` ?? (small 2 / primary 1), server).
      *Measured 11-04:* Ollama.app here serves **1 of 4** at once → R-d is not fixable from the gateway without
      `OLLAMA_NUM_PARALLEL` on the server (which also multiplies the coder's KV). Reported, not hidden.
- [x] M10.5 **load test v2** (R-e): `--mode a,b,c` interleaved, `--repeats N` (median + range), peak swap-out
      rate, responsiveness probe (spawn `/usr/bin/true` every 1 s), seconds at critical, target table.
- [x] M10.6 **targets** (median of 3, vs direct-32k): total time ≤ +10% · title p50 ≤ 1 s · agent p95 better ·
      swap-out ≤ direct · 0 s critical · responsiveness p95 better. Missed targets are reported as missed.
      **Round 1 (11-03 17:53 IST, `summary-…12-23-32`)**: total 47.1 vs 40.0 s ❌ (+17%) · title 0.22 s ✅ · agent p95 15.4 vs 31.0 s ✅ ·
      swap 1.09 vs 0.50 GB ❌ · critical 0 ✅ · spawn p95 3.1 vs 4.0 ms ✅. Cause: background `mid` held 4–6 s while
      apps swapped even though its model was loaded → fast lane now also exempts background work from the swap hold.
      **Round 2 (11-03 ~18:01 IST, after that fix + the growth-deadlock fix, `summary-…12-31-37`)**: total **43.0 (42.7–49.4) vs 39.9 (38.1–42.3) s ✅ +8%** ·
      title p50 0.25 ✅ · agent p95 **14.9 vs 27.9 s** ✅ · swap **0.13 (0–1.57) vs 3.32 (0–3.54) GB** ✅ (ranges overlap) ·
      peak swap-out 97 vs 589 MB/s · critical 0 ✅ · spawn p95 2.8 vs 5.8 ms ✅.
      Cost, reported: background `chat` p95 **32.8 vs 16.2 s** (it waits for the coder by design). Round 2 follows a fix
      made after seeing round 1, so both rounds are reported.
- bugs fixed on the way: (1) thrash relief evicted *foreign* models (other clients) without the foreign-idle check; (2) **growth deadlock** (found in `m4-modeC-r3` task F): a coder that had grown to 17.4 GB (> 16 GB budget) could never reload to grow 32k→64k because its own size/learned growth counted against itself → 12 min stall, timeout. Own growth now only counts against *other* models; grow-reloads exclude the unit's own memory; never-started requests are logged.

## M7 — Throughput breakthrough: same model, more solved tasks per hour

**Claim to earn:** same `qwen3.5:9b`, same Ollama, same busy 24 GB Mac → **≥ 2× solved tasks per
hour** vs a *fair* baseline (stock OpenCode + Ollama **with the title fix already applied**, so the
gain is not the title bug). Constraints fixed in Q&A 2026-11-03: local models only (hard rule), keep
Ollama + qwen3.5 (no new runtime/model downloads), measure on harder in-repo tasks.

**Why this is the constraint.** Decode is memory-bandwidth bound: ~150 GB/s ÷ ~5.5 GB of weights
≈ 25–30 tok/s (*estimate*; measured 23–36). Nothing can raise that, so
`task time ≈ Σ steps × (uncached prefill + generated tokens ÷ ~30 tok/s + tool time)`.
The levers are **fewer generated tokens per step, fewer uncached prefills, fewer steps**.
Evidence so far: after removing the title wait, A–E work time did not improve (M1 ≈ 363 s vs mode A
≈ 429 s); M4 mode A task F generated 12,645 output tokens (≈ 420 s of its 685 s at 30 tok/s,
*estimate*) and OpenCode compacted its context mid-task (a "Work State" summary appears in the final text).

**Example (illustrative, to be replaced by M7.0 numbers):** step 7 of task F, the model has just
received a `glob` result. Today it thinks freely (say 300 tokens ≈ 10 s) and then calls `read`.
With a per-step budget, a step that follows a read-only tool result runs with thinking off and
issues the `read` in ~1 s. Steps that follow a test failure or a failed edit keep full thinking.

**Metric:** solved tasks per hour = passes ÷ total wall (failed tasks cost their full time).
Also reported: seconds, generated tokens, steps, and uncached prefill tokens per solved task.
Headline numbers are the median of ≥ 3 repeats with the range shown. Ablations use 1 repeat.

- [~] M7.0 **Instrument first.** *(code done 11-04: `src/server/telemetry.ts` SSE tap → `~/.pitcrew/requests.jsonl`, sizes/timings only; `bench/budget.mjs`; live gate pending)* Gateway logs per request: kind (agent/helper), prompt tokens,
      cached vs uncached prefill (`prompt_eval_count`/duration), generated tokens split into
      reasoning and content, decode duration, the chosen tool, and whether a compaction request occurred.
      `bench/summarize.mjs` turns this into a time budget per task.
      *Check:* the per-task budget sums to within 5% of wall time on a rerun of A–F.
      *Gate:* rank the levers by their measured share of time. If reasoning decode is < 30% of wall time, re-plan before M7.3.
- [ ] M7.1 **Harder task set G–P** (~10 tasks): traps like F (route order), multi-file refactor,
      a flaky test, a misleading error message, config plus code changes, and a long tool chain.
      Each one has hidden verifiers, a reference solution that passes, and an untouched fixture that fails.
      *Target:* the fair baseline passes ~30–60%. A–F stay as a regression set.
- [~] M7.2 **Fair baseline** *(profile `examples/opencode/opencode.baseline.json`; capture verified title → `qwen3.5:0.8b`, `reasoning_effort: none`, `max_tokens: 512`)*: `opencode.local.json` with `small_model` = `qwen3.5:0.8b` and thinking
      off, OpenCode → Ollama directly, 3 repeats on G–P. This is the number to beat.
- [~] M7.3 **Lever 1: per-step reasoning budget** *(code done 11-04, `src/server/levers.ts`, flag `router.reasoningBudget`)* (router). Classify each request from the last
      message: first step or plan, after a test failure or edit error → full thinking; after a successful
      read-only tool result → `reasoning_effort: "none"` (or low). Per-step-kind `max_tokens` cap.
      *Check:* generated tokens per solved task drop ≥ 40% and pass rate is not lower.
      **Quality guardrails** (the main risk is skipping thinking that was needed):
      escalate: if a no-think step gives an invalid or repeated tool call, or the next tool result is
      an error, the following steps run with full thinking. Try `low` before `none`. Use M7.0 logs to
      check whether thinking after reads ever changes the next action (if it mostly does not, it is
      safe to skip). Quality is judged on more than pass rate: hidden checks, no tests weakened, diff size,
      and a blind diff review of 5 solved tasks per config. If any of these is worse beyond the run-to-run
      spread, the lever is dropped or narrowed.
- [~] M7.4 **Lever 2: prefill and compaction** *(compactions counted from telemetry `kind`; levers only append / extend the system prompt with a byte-stable block)*: keep the request prefix byte-stable (cache
      hits), count compactions, and compare 32k with the existing 64k bucket on compaction cost against memory.
      *Check:* uncached prefill tokens per solved task drop, and pressure never reaches "critical".
- [~] M7.5 **Lever 3: fewer steps** *(code done: `router.injectContext`, `router.loopHints` incl. edit-miss file excerpt)*: inject `pitcrew context` retrieval into the first request
      (finishes M2.4). Detect loops of repeated identical tool calls and failed `edit`s (`oldString` not found) and
      add a short corrective hint for the next step.
      *Check:* steps per solved task drop ≥ 25%.
- [ ] M7.6 **Ablation + headline**: baseline, all levers, and all levers minus one (each).
      Headline at 3 repeats. Claim "2×" only if ranges do not overlap.
      Machine time ≈ 10 h (*estimate*: 16 tasks × ~5 min × runs), so runs happen overnight.
- [ ] M7.7 write-up in `docs/BENCHMARKS.md`: time budget before and after, which lever bought what, and limits
      (one machine, one model, in-repo tasks). Report the title-request issue to OpenCode separately.

Out of scope for M7 (per Q&A): speculative decoding (Ollama does not support it), other
models or runtimes, and any cloud model in the loop.

## M8 — Quality vs Claude (goal 1)

Claude is used only as a **yardstick**. It is never inside the local pipeline, which stays local only.
Runs use the user's logged-in Claude Code (`bench/run-claude.sh`, which counts against their usage).

- [ ] M8.1 run Claude Code on A–F and G–P with the Claude 4.5 / 4.6 / 4.7 models still available
      (check the model IDs at run time; the script currently has opus-4-6 and sonnet-4-6). 3 repeats.
- [ ] M8.2 quality score beyond pass/fail: hidden checks, tests not weakened, diff size, and a blind
      review of the diffs (reviewer does not know which agent produced them). The same rubric applies to every agent.
- [~] M8.3 local quality levers *(code: `router.testRepair`, `router.planFirst`)* (each one also measured for time cost):
      test-driven repair (after an edit, failing test output goes back to the model with thinking on);
      plan first (one planning step with full thinking, then execution); retrieval at the start (M2.4);
      repository LoRA from reviewed examples (M5.4, only with a significant gain).
- [ ] M8.4 report: local vs each Claude version, as pass rate, review score and time per task, split
      into routine (A–F) and hard (G–P). *Target:* parity on routine tasks, and at least half the hard-task gap
      closed relative to the fair baseline (*aspiration*, unknown until measured).

## M9 — Many models without eating RAM (goal 3)

Budget: 24 GB total. macOS + apps ≈ 12 GB, so ≈ 10–12 GB is left for models, and swap is already near full.

| model | size (*estimate* until calibrated) | policy |
|---|---|---|
| coder `qwen3.5:9b` | 8 GB at load → 17 GB observed | primary; growth capped (M9.1) |
| helper `qwen3.5:0.8b` | 1.2 GB | stays loaded |
| speech-to-text (whisper small) | ≈ 0.5–1 GB | stays loaded |
| text-to-speech (e.g. Kokoro) | ≈ 0.5 GB | stays loaded |
| image (mflux, 4-bit) | ≈ 8–10 GB | queued; runs when the coder is idle or unloaded |
| video (e.g. LTX-Video / Wan small) | ≈ 8–16 GB | queued; background only; coder unloaded first |

- [~] M9.1 **cap coder memory growth** *(code done 11-04: `maxResidentGiB` + idle recycle + learned growth reservation; `bench/tools/growth.mjs`; static look at Ollama 0.40.11: MLX runner keeps KV prefix snapshots and calls mlx_set_cache_limit internally, but exposes no env knob → the idle recycle is the fix; passive sampling of the running baseline: 9.0 → 11.4 → **16.7 GB** during A–F)* (8 → 17 GB): find the cause (MLX prompt cache vs KV at
      32k), then fix it with a context bucket, a periodic reload when the coder is idle, or runner options. *Check:* steady-state
      resident size ≤ 10 GB through task F, pass rate unchanged.
- [~] M9.2 calibrate *(code: persisted `job-calibration.json`, max(RSS, available-memory drop); voice: mlx-whisper small + Kokoro-82M already in HF cache, runners resolved via uv)* real peak memory for STT, TTS, image (`jobs.ts` already measures peak RSS).
- [~] M9.3 add a `video` job endpoint *(code: `/v1/videos`, `deferrable` priority, ballast stand-in `bench/tools/ballast.mjs`)* (same job adapter; background priority; preemptible queue).
- [~] M9.4 mixed-load scenario S3 *(script `bench/load/s3.ts`, config `examples/pitcrew.multimodel.json`)*: coder runs a task while STT/TTS requests arrive and an
      image/video job is queued. *Check:* pressure never "critical", app swap-out rate under the
      thrash threshold, coder pass rate and time within the run-to-run spread, and video finishes after the coder
      goes idle.
- [~] M9.5 dashboard *(why-resident column, growth/cap, job peaks, responsiveness)*: who is loaded, who is queued and why, memory headroom.

**Order of work:** M7.0 (instrument) → M9.1 (memory cap, helps all three goals) → M7.1 harder
tasks → M7.2 fair baseline + M8.1 Claude runs on the same tasks → speed levers (M7.3–7.5) and quality
levers (M8.3), each judged on all three metrics → M9.2–9.5 → M7.6/M8.4 write-up.

## Launch — public repo, npm, demo (parallel track, 2026-11-04)

> LAUNCH NEXT → user: `gh auth login` + `npm login`. Then, each only after the user says go: push → CI + Pages green → create the 5 good first issues (drafts in `.launch/good-first-issues.md`, untracked) → `gh repo edit` (description, homepage, topics, Discussions) → tag + release v0.1.0 → `npm publish`. User uploads `docs/img/social-preview.png` in Settings → Social preview.

- [x] L1 demo recording: `scripts/demo/record.mjs` (mock backend, simulated 24 GB Mac; `--ollama` for real) → `site/trace.json`; `site/replay.js` replays it into the unmodified dashboard; `scripts/demo/build-site.mjs` builds `site/index.html` from `src/server/gui.html` — check: replay animates in headless Chrome
- [x] L2 `docs/img/demo.gif` (`npm run demo:gif`, 900 px, 0.74 MB) and `docs/img/social-preview.png` (1280×640, `scripts/demo/social-card.html`)
- [x] L3 README top (pitch, badges, GIF, `npx pitcrew-ai serve`, live demo), quick start via npx, clone URL fixed
- [x] L4 package.json: repository/homepage/bugs, `prepack` builds, no source maps — check: tarball installs in an empty dir, `pitcrew --help` and `audit` run
- [x] L5 CONTRIBUTING (project map, mock backend, PR flow), issue forms (bug, hardware report, feature), PR template, CHANGELOG
- [x] L6 CI: `package` job (install tarball, run it), `secrets` job (gitleaks 8.30.1, full history); `.gitleaks.toml` allows only the two fake keys in `test/learn.test.ts` — check: gitleaks 0 findings on 27 commits
- [ ] L7 push; CI + Pages green (`gh run watch`); enable Pages (source: Actions)
- [ ] L8 repo settings: description, homepage, topics, Discussions on; labels `hardware report`
- [ ] L9 5 good first issues created with the label
- [ ] L10 tag + GitHub release v0.1.0 (notes = CHANGELOG section); `npm publish`; `npx pitcrew-ai --help` works
- [ ] L11 social preview uploaded (user) and visible

## Execution order (breakthrough branch, plan of 11-04)

Local commits per milestone on branch `breakthrough`; never pushed.

| step | milestone | what | machine time |
|---|---|---|---|
| 0 | housekeeping | git init, branch, this plan | — |
| 1 | **M10** | load-test fixes + v2 load test, 3 repeats | ~15 min |
| 2 | M7.0 | SSE telemetry → `~/.pitcrew/requests.jsonl`, time budget per task (gate: sums within 5%) | A–F rerun ~40 min |
| 3 | M9.1 | coder growth diagnosis + idle reload cap (`maxResidentGiB`) | ~30 min |
| 4 | M7.1 | harness fixes, tasks G–P, `selftest.mjs`, calibration run | ~1 h |
| 5 | M7.2 + M8.1 | fair baseline ×3, Claude Opus 4.5/4.6/4.7 ×3, Pit Crew "before levers" ×3 | overnight |
| 6 | M7.3–7.5 + M8.3 | levers (reasoning budget, prefix/compaction, retrieval, loop hints, test-driven repair) with ablations | ~6 h |
| 7 | M8.2 | quality score + blind pack | — |
| 8 | M9.2–9.5 | ballast jobs, whisper/Kokoro, `video` + `deferrable`, dashboard, S3 | ~2 h |
| 9 | M7.6/7.7, M8.4 | ablation + headline (overnight), `docs/BENCHMARKS.md`, `docs/opencode-issue.md` (filing = user's call) | overnight |

---

## Decisions log

| decision | why |
|---|---|
| Governor = OpenAI-compatible proxy in front of Ollama | OpenCode supports custom OpenAI-compatible providers; keeps OpenCode's tools/approvals intact |
| Node ≥ 22 + TypeScript, zero runtime deps | auditable; runs via `--experimental-strip-types` without a build |
| Derived models per context bucket | Ollama's OpenAI API cannot set `num_ctx` per request; derived models share blobs |
| Swap-out *rate*, not swap *used*, as thrash signal | swap is ~95% used before any model loads |
| Deterministic analysis first, LLM for synthesis only | facts from code are cheaper and verifiable; small models hallucinate structure |
| No app is closed, no global config edited | not authorised; the system must cope with a busy machine |
| Image/TTS job support kept as optional extension | built earlier on request; not on the coding critical path |
| Breakthrough axis = throughput (solved tasks/hour), local-only, Ollama + qwen3.5 fixed (2026-11-03 Q&A) | decode is bandwidth-bound; most defensible claim that is not an upstream bug fix; no slow downloads |
| Fair baseline includes the title fix | otherwise the headline is just the OpenCode title bug |
| Loaded models bypass the degraded cap (fast lane) (11-04) | holding a request that needs no memory only adds latency; loads stay held |
| Background gated on critical + swap-out rate, not kernel "warn" (11-04) | this Mac reports warn while idle; warn-gating starved background for 60 s |

## Progress log

- 11-02 ~22:57 audit; Ollama confirmed on :11434
- 11-02 ~23:00 `qwen3.5:9b` pull started (1–4 MB/s)
- 11-02 agent fixture + hidden verifiers validated (reference 18/18, baseline fails 10/11)
- 11-02 architecture doc; scheduler (12/12 tests); job adapter (5/5 tests)
- 11-02 23:26 mission expanded to OpenCode-first platform (M1–M6); plan rewritten; Docker VM observed stopped
- 11-02 project renamed to **Pit Crew** (`pitcrew-ai`, CLI `pitcrew`, state `~/.pitcrew`) per user via parallel session; folder moving to `~/personal/pitcrew` — no absolute paths in repo
- 11-02 M1.3 done: OpenCode base prompt ≈24.3k tok default → ≈7.5k tok with local profile; 32k ctx chosen. Local profile + `bin/opencode-local` verified (only `local/coder` listed; model id mapping works)
- 11-03 overnight: pull failed 8× (DNS / machine offline); resumed 13:21 at 9 MB/s — `qwen3.5:9b` installed (7.6 GB, **NVFP4 safetensors on Ollama's MLX runner**, not GGUF → llama.cpp cannot load it; metadata lacks KV layout → footprint falls back to conservative guess + calibration)
- 11-03 M3.3 gateway done: 10/10 integration tests (mock Ollama); typecheck clean; 29/29 tests total
- 11-03 M1.4/M1.6 measured: load 5.9 s; resident 7.62 GB → 8.06 GB after a 5.9k-token prompt at 32k ctx; loading pushed ~5.7 GB of apps to swap (swap file 16.3→22.1 GB); OpenCode local-profile prompt = **5,858 real tokens** (4.12 chars/token); cold prefill 10.0 s (584 tok/s), warm prefill ≈0 s (prefix cache); decode 23–36 tok/s; correct `glob` tool call ✅
- 11-03 M1.7 task A PASS (8/8) but 340 s of 385 s blocked by OpenCode's title request (thinking runaway, 5 min, HTTP 500) on the same model → motivates router; task B PASS (16 tool calls, 0 errors)
- 11-03 M2 product intelligence: `src/intel/` (scan, symbols, import graph, profile, BM25 + symbol + dependency retrieval), `pitcrew scout|context`, artifacts in ~/.pitcrew/projects/<id>/; 7 tests incl. retrieval precision on fixture tasks
- 11-03 M3.4 router (`auto` model; modes A/B/C; helper output cap), M3.5 CLI (serve/audit/garage/scout/context/status/clean), M6.1 dashboard HTML (needs screenshot); 41/41 tests, typecheck clean
- 11-03 M1 baseline done: 5/6 pass; 69% of wall time blocked by title request; 9B resident grew 8→17 GB; `reasoning_effort:none` makes helper titles 0.2 s (was 14.4 s, empty) → router patch added; models unloaded, pressure back to normal
- 11-03 gateway first real run stalled: coder estimate 11.7 GB (unknown-arch guess) vs 5.5 GB headroom → refused forever. Added `primary: true` alias policy (aggressive admission for the chosen coder; others stay balanced; critical pressure still blocks)
- 11-03 M4 mode C (single run): A PASS 123 s (M1: 385 s), first-step wait 26 s (M1: 343 s); B PASS 161 s (M1: 170 s); C PASS 514 s (M1: 488 s; more steps, 4 tool errors, thrash controller engaged)
- 11-03 M5 learning pipeline: collect (opt-in, temp-index diff incl. new files, tests must pass, secret + e-mail scan, provenance), export to MLX-LM chat JSONL, `tune plan` (never runs); bugs found+fixed: untracked files missing from diff, NODE_TEST_CONTEXT leak made failing tests look green. 47/47 tests
- 11-03 docs: README, MODELS, SECURITY, TROUBLESHOOTING, CONTRIBUTING, LICENSE, CI workflow; `npm run build` verified
- 11-03 M4 single runs done: mode A 5/6 1,166 s · B 6/6 1,257 s · C 6/6 1,535 s vs M1 5/6 2,390 s; gain = title wait removed, work time not improved → task set saturated
- 11-03 Q&A: breakthrough axis = throughput, local-only, Ollama+qwen3.5 fixed, harder in-repo tasks → M7 plan written
- 11-03 goals set by user: (1) quality comparable to Claude 4.5/4.6/4.7, (2) faster than plain OpenCode+Ollama, (3) coding+voice+image/video models without eating RAM → Goals table, M8, M9 added; observed coder at 17 GB, swap 36.8/37.9 GB
- 11-04 Phase 0: git init, initial commit on `main`, branch `breakthrough`. M10.1–M10.5 implemented (55/55 tests). Live probe: Ollama.app serves 1 request per model at a time. Found `bench/run-all.sh` (previous session) still running agent repeat 3; a gateway smoke test at 11:09 briefly evicted its coder once (r3 task A/B timing slightly affected) → foreign-eviction bug fixed. Load runs wait until it finishes.
- 11-04 code-only work while the old run finished: M7.0 telemetry, M9.1 cap, levers (M7.3–7.5, M8.3), M9.2–9.5, fair-baseline profile, run-claude.sh (Opus 4.5/4.6/4.7 + probe), OpenCode issue draft (`docs/opencode-issue.md`, not filed). 72/72 tests. Captured OpenCode's tool-result/error formats with `bench/tools/script-server.mjs` (no model). Note: `qwen3.5:9b` carries `draft_num_predict 3` in Ollama 0.40 — speculative/MTP decoding may exist now; not explored (out of scope for M7).
- 11-04 ⚠ the previous session's `bench/run-all.sh` could not be stopped from this session (permission), so its final step `m4-modeC-qwen35-9b-r3` runs on the **breakthrough** gateway code (fast lane, warm helper, telemetry) — not comparable with M4 r1/r2; treat it as an extra 'Pit Crew today' A–F data point.
- 11-03 (17:53–18:15 IST, Mac awake) M10 done: load test round 1 missed 2 targets; fixes; round 2 met all 6 (details in M10.6). Live: Ollama /v1 streams thinking as `delta.reasoning`; on qwen3.5 `reasoning_effort: "low"` does **not** reduce thinking (951 vs 795 reasoning chars default) — only `"none"` does → reasoning-budget lever must use `none` (escalation rules are the guardrail). First time budget (m4-modeC-r3, A–F): reasoning decode 24.7% of wall overall, 42–78% on C/D/E; sums to 100% ✔.
- 11-04 M9.1 diagnosis (`bench/tools/growth.mjs`, `bench/results/growth/growth-…12-45-50`): loaded 7.62 GB. One growing session (shared prefix) 6k→31k tokens: 7.94→**10.07 GB** (~80 KB/token; cached prefill 3–6 s). Same sizes with distinct prefixes: 7.94→**15.91 GB** (uncached prefill up to 43 s). Reload → 7.62 GB both times. ⇒ the 17 GB is the MLX runner keeping **every distinct prompt cached** (no env knob to limit it), not KV at the window. Fix = idle recycle at `maxResidentGiB` (drops stale prompts; costs one re-prefill of the live conversation ≈ tokens ÷ 584 tok/s, measured next on A–F).
- 11-04 M9.2 voice verified with cached weights: Kokoro-82M TTS 2.9 s, 0.93 GB peak RSS; whisper-small STT 3.7 s, 0.99 GB; exact transcript. Downloads: a few Python wheels (torch, spacy, pydantic-core) and en_core_web_sm (12 MB); no model weights.
- 11-04 `pitcrew-cap-r1` (A–F, cap 10 GB): 3/6 — **invalid as a pass-rate measurement**: Docker VM 4.5 GB started ~15:30, swap 31.6/32 GB, 'memory critical' for minutes; each failed task had one request at ~0.1 tok/s for 900+ s. Recycle fired once (11.1→7.1 GB in 3.5 s). The gateway kept its 11 GB coder loaded after the run (keep_alive −1) → run scripts now unload at the end; thrash relief now also sheds pinned helpers (as documented). Switched to interleaved runs (`bench/agent/interleave.sh`) so configurations share machine conditions.
- 11-04 **Correction:** the 'stalls' blamed on Docker/thrash were the Mac in **clamshell sleep** (lid closed 18:22 → next morning, ~45 s DarkWakes every ~15 min; `pmset -g log`). Ollama logged `took=43.8s` for a request spanning 15 min of wall time (monotonic clock stops in sleep). Repro of a 22k-token prompt, speculative decoding on vs off, 3 trials each: 0/6 hung. 46 results overlapped sleep (all of stage 1, most of pitcrew-cap-r1, 25 of the other session's Claude runs) → marked invalid (`bench/tools/mark-slept.mjs`) and excluded; run.mjs now detects sleep itself (wall vs monotonic). Load tests, growth replay and voice tests ran while awake (valid).
- 11-04 Launch track L1–L6 (local only, nothing pushed): demo recorded on the mock backend because stage 1 was using Ollama; Chrome/ffmpeg/tests ran at background QoS (`taskpolicy -b`) during stage 1 run K.
