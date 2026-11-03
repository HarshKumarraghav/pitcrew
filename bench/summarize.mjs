#!/usr/bin/env node
// Turn every result file under bench/ into Markdown tables (agent suite + load benchmark).
//
// Agent results: bench/agent/results/<label>/<TASK>.json. Runs named "<config>-rN" are repeats of
// one configuration and are grouped. Tasks are whatever appears in the results (A–F, G–P, ...).
// Optional display names: bench/agent/results/labels.json = { "<config or prefix>": "Display name" }.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, "agent", "results");
const LOAD = join(HERE, "results", "load");
const REGRESSION = new Set(["A", "B", "C", "D", "E", "F"]);

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : "—");
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—");
const kTok = (x) => (Number.isFinite(x) ? (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : x.toFixed(0)) : "—");
/** "median (min–max)" — just the value when there is one sample. */
const mr = (xs, fmt = f0) => {
  const v = xs.filter(Number.isFinite);
  if (!v.length) return "—";
  if (v.length === 1) return fmt(v[0]);
  return `${fmt(median(v))} (${fmt(Math.min(...v))}–${fmt(Math.max(...v))})`;
};

// ---------------------------------------------------------------------------------------------
// Load agent results

const TASK_FILE = /^([A-Z])\.json$/;
const runDirs = existsSync(AGENT)
  ? readdirSync(AGENT, { withFileTypes: true }).filter((d) => d.isDirectory() && readdirSync(join(AGENT, d.name)).some((f) => TASK_FILE.test(f))).map((d) => d.name).sort()
  : [];
/** config → [{ run, tasks: { A: result, ... } }] */
const configs = new Map();
const taskNames = new Map();
for (const run of runDirs) {
  const cfg = run.replace(/-r\d+$/, "");
  const tasks = {};
  for (const f of readdirSync(join(AGENT, run))) {
    const m = TASK_FILE.exec(f);
    if (!m) continue;
    try {
      tasks[m[1]] = JSON.parse(readFileSync(join(AGENT, run, f), "utf8"));
      if (!taskNames.has(m[1])) taskNames.set(m[1], tasks[m[1]].name);
    } catch {
      /* partial write — ignore */
    }
  }
  if (!configs.has(cfg)) configs.set(cfg, []);
  configs.get(cfg).push({ run, tasks });
}
const TASKS = [...taskNames.keys()].sort();

// ---------------------------------------------------------------------------------------------
// Display names: optional map file first (exact key, then longest matching prefix), then generic rules.

const NAME_MAP = (() => {
  const p = join(AGENT, "labels.json");
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  } catch {
    return {};
  }
})();
const FAMILY = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
function label(c) {
  if (NAME_MAP[c]) return NAME_MAP[c];
  const prefix = Object.keys(NAME_MAP).filter((k) => c.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (prefix) return NAME_MAP[prefix];
  let m;
  if ((m = /^cc-(opus|sonnet|haiku)-(\d+)-(\d+)(.*)$/.exec(c))) return `Claude Code + ${FAMILY[m[1]]} ${m[2]}.${m[3]} (cloud)${m[4] ? ` ${m[4].replace(/^-/, "")}` : ""}`;
  if ((m = /^cc-(.+)$/.exec(c))) return `Claude Code + ${m[1]} (cloud)`;
  if ((m = /^baseline(?:-(.+))?$/.exec(c))) return `Fair baseline (OpenCode → Ollama)${m[1] ? ` ${m[1]}` : ""}`;
  if ((m = /^pitcrew-(.+)$/.exec(c))) return `Pit Crew ${m[1]}`;
  if (c.startsWith("m1-")) return "Direct (OpenCode → Ollama, same model for titles)";
  if (c.includes("modeA")) return "Pit Crew mode A (single model)";
  if (c.includes("modeB")) return "Pit Crew mode B (sequential light+strong)";
  if (c.includes("modeC")) return "Pit Crew mode C (resource-aware hybrid)";
  return c;
}
const show = (c) => (label(c) === c ? `\`${c}\`` : `${label(c)} \`${c}\``);

// ---------------------------------------------------------------------------------------------
// Per-result helpers

const all = (rs) => rs.flatMap((r) => Object.values(r.tasks));
/** Largest single-request prompt. Old Claude results stored the session total in `input`, so skip those. */
const inputPeak = (t) => t.tokens?.inputPeak ?? (t.agent === "claude" ? NaN : t.tokens?.input ?? NaN);
const outTok = (t) => (t.tokens?.output ?? 0) + (t.tokens?.reasoning ?? 0);
/** Solved tasks per hour = passes ÷ total wall hours (failed tasks cost their full time). */
const solvedPerHour = (ts) => {
  const h = sum(ts.map((t) => t.wallS)) / 3600;
  return h > 0 ? ts.filter((t) => t.success).length / h : NaN;
};

// ---------------------------------------------------------------------------------------------
// Overview

console.log(`## Agent suite (${TASKS.length} tasks: ${TASKS.join(" ")}, hidden verifiers)\n`);
console.log("Medians over repeats with (min–max). Pass rate = passes / attempts over all runs. Solved / h = passes ÷ total wall hours.\n");
console.log("| configuration | runs | pass rate | passed per run | wall / run (s) | solved / h | solved / h A–F | solved / h hard | wait before 1st step | out tokens / run | peak prompt / task | tool calls / run | tool errors / run | mean swap growth / task | cost / run |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [cfg, rs] of configs) {
  const ts = all(rs);
  const cfgTasks = new Set(ts.map((t) => t.task));
  const full = rs.filter((r) => Object.keys(r.tasks).length === cfgTasks.size);
  const partial = rs.length - full.length;
  const passes = ts.filter((t) => t.success).length;
  const passedPerRun = rs.map((r) => `${Object.values(r.tasks).filter((t) => t.success).length}/${Object.keys(r.tasks).length}`);
  const walls = full.map((r) => sum(Object.values(r.tasks).map((t) => t.wallS)));
  const outs = full.map((r) => sum(Object.values(r.tasks).map(outTok)));
  const waits = ts.map((t) => t.timeToFirstOutputS ?? NaN);
  const swap = ts.map((t) => (t.mem ? (t.mem.maxSwapMB - t.mem.startSwapMB) / 1024 : NaN)).filter(Number.isFinite);
  const hasCost = ts.some((t) => t.costUsd !== undefined);
  const cost = hasCost ? `$${mean(full.map((r) => sum(Object.values(r.tasks).map((t) => t.costUsd ?? 0)))).toFixed(2)} (API-equiv.)` : "$0 (local)";
  const reg = ts.filter((t) => REGRESSION.has(t.task));
  const hard = ts.filter((t) => !REGRESSION.has(t.task));
  console.log(
    `| ${show(cfg)} | ${rs.length}${partial ? ` (${partial} partial)` : ""} | ${passes}/${ts.length} (${f0((100 * passes) / ts.length)}%) | ${passedPerRun.join(", ")} | ${mr(walls)} | ${f1(solvedPerHour(ts))} | ${reg.length ? f1(solvedPerHour(reg)) : "—"} | ${hard.length ? f1(solvedPerHour(hard)) : "—"} | ${f0(median(waits))} s | ${mr(outs, kTok)} | ${kTok(median(ts.map(inputPeak)))} | ${f0(sum(ts.map((t) => t.toolCalls ?? 0)) / rs.length)} | ${f0(sum(ts.map((t) => t.toolErrors ?? 0)) / rs.length)} | ${f1(mean(swap))} GB | ${cost} |`,
  );
}

// ---------------------------------------------------------------------------------------------
// Per task

console.log("\n### Per task: passes / runs · median wall in s (min–max)\n");
console.log(`| configuration | ${TASKS.join(" | ")} |`);
console.log(`|---|${TASKS.map(() => "---").join("|")}|`);
for (const [cfg, rs] of configs) {
  const cells = TASKS.map((k) => {
    const xs = rs.map((r) => r.tasks[k]).filter(Boolean);
    if (!xs.length) return "—";
    return `${xs.filter((x) => x.success).length}/${xs.length} · ${mr(xs.map((x) => x.wallS))}`;
  });
  console.log(`| ${show(cfg)} | ${cells.join(" | ")} |`);
}

console.log("\n### Per task: output tokens (median) · peak prompt (median)\n");
console.log(`| configuration | ${TASKS.join(" | ")} |`);
console.log(`|---|${TASKS.map(() => "---").join("|")}|`);
for (const [cfg, rs] of configs) {
  const cells = TASKS.map((k) => {
    const xs = rs.map((r) => r.tasks[k]).filter(Boolean);
    return xs.length ? `${kTok(median(xs.map(outTok)))} · ${kTok(median(xs.map(inputPeak)))}` : "—";
  });
  console.log(`| ${show(cfg)} | ${cells.join(" | ")} |`);
}

// Quality signals recorded by the harness (newer results only): tests weakened / diff size.
const withDiff = [...configs].filter(([, rs]) => all(rs).some((t) => t.diff));
if (withDiff.length) {
  console.log("\n### Diff size and test hygiene (results with diff records)\n");
  console.log("| configuration | median lines +/- per task | median test lines +/- | tests weakened | tests/ touched where forbidden |");
  console.log("|---|---|---|---|---|");
  for (const [cfg, rs] of withDiff) {
    const ts = all(rs).filter((t) => t.diff);
    const forbidden = ts.filter((t) => (t.failedChecks ?? []).some((c) => /TestsUntouched|testsUntouched/.test(c))).length;
    console.log(
      `| ${show(cfg)} | +${f0(median(ts.map((t) => t.diff.added)))}/-${f0(median(ts.map((t) => t.diff.removed)))} | +${f0(median(ts.map((t) => t.diff.testsAdded)))}/-${f0(median(ts.map((t) => t.diff.testsRemoved)))} | ${ts.filter((t) => t.diff.testsWeakened).length}/${ts.length} | ${forbidden}/${ts.length} |`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// HOOK (M7.0): per-task time budget.
// Join each result's [startedAtMs, endedAtMs] window (+ label/task) with the gateway request log
// (~/.pitcrew/requests.jsonl) and split wall time into prefill / decode / tool / idle per task.
// Return Markdown lines to print, or [] to print nothing. Called once with all configurations.
function timeBudgetSection(configs, tasks) {
  return []; // TODO(M7.0): implement; check that the budget sums to within 5% of wallS.
}
const budget = timeBudgetSection(configs, TASKS);
if (budget.length) console.log(`\n### Time budget per task\n\n${budget.join("\n")}`);

console.log(`\nTasks: ${TASKS.map((k) => `${k} ${taskNames.get(k) ?? ""}`.trim()).join(" · ")}.`);

// ---------------------------------------------------------------------------------------------
// Load benchmark (unchanged)

if (existsSync(LOAD)) {
  const files = readdirSync(LOAD).filter((f) => f.endsWith(".json")).sort();
  const latest = new Map();
  for (const f of files) latest.set(f.split("-20")[0], JSON.parse(readFileSync(join(LOAD, f), "utf8")));
  console.log("\n## Load benchmark (6 concurrent clients × 3 rounds over 3 models)\n");
  console.log("2 agent clients → 9B coder (real 5.9k-token OpenCode request) · 2 chat → 2B · 2 title → 0.8B.\n");
  console.log("| mode | ok / requests | truncated | agent p50 / p95 | chat p50 | title p50 | wall | model loads | peak resident | min available | swapped out | s at pressure ≥ warn |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [mode, r] of latest) {
    const c = r.byCls;
    console.log(`| ${mode} | ${r.success}/${r.requests} | ${Object.values(c).reduce((a, x) => a + x.truncated, 0)} | ${f1(c.agent.p50s)} / ${f1(c.agent.p95s)} s | ${f1(c.chat.p50s)} s | ${f1(c.title.p50s)} s | ${f0(r.wallS)} s | ${r.totalLoads} | ${r.peakResidentGB} GB | ${r.memory.minAvailableGB} GB | ${r.memory.swappedOutGB} GB | ${r.memory.secondsAtWarnOrWorse}/${r.memory.samples} |`);
  }
  for (const [mode, r] of latest) {
    const errs = Object.entries(r.byCls).flatMap(([k, v]) => v.errors.map((e) => `${k}: ${e}`));
    if (errs.length) console.log(`\n${mode} errors: ${[...new Set(errs)].slice(0, 5).join(" · ")}`);
    const pt = r.byCls.agent.promptTokens;
    console.log(`\n${mode}: agent prompt tokens seen by the model: ${pt.join(", ")}`);
  }
}
