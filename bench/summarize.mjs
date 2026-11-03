#!/usr/bin/env node
// Turn every result file under bench/ into Markdown tables (agent suite + load benchmark).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, "agent", "results");
const LOAD = join(HERE, "results", "load");
const TASKS = ["A", "B", "C", "D", "E", "F"];
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs) => (xs.length > 1 ? Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2))) : 0);
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : "—");
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—");

// group runs: "m1-qwen35-9b-32k", "m1-qwen35-9b-32k-r2" → config "m1-qwen35-9b-32k"
const runs = existsSync(AGENT) ? readdirSync(AGENT).filter((d) => existsSync(join(AGENT, d, "A.json")) || existsSync(join(AGENT, d, "F.json"))) : [];
const configs = new Map();
for (const r of runs) {
  const cfg = r.replace(/-r\d+$/, "");
  const tasks = {};
  for (const t of TASKS) {
    const p = join(AGENT, r, `${t}.json`);
    if (existsSync(p)) tasks[t] = JSON.parse(readFileSync(p, "utf8"));
  }
  if (!configs.has(cfg)) configs.set(cfg, []);
  configs.get(cfg).push({ run: r, tasks });
}
const label = (c) =>
  c.startsWith("cc-opus-4-6") ? "Claude Code + Opus 4.6 (cloud)" : c.startsWith("cc-sonnet-4-6") ? "Claude Code + Sonnet 4.6 (cloud)" :
  c.startsWith("m1-") ? "Direct (OpenCode → Ollama, same model for titles)" : c.includes("modeA") ? "Pit Crew mode A (single model)" : c.includes("modeB") ? "Pit Crew mode B (sequential light+strong)" : c.includes("modeC") ? "Pit Crew mode C (resource-aware hybrid)" : c;

console.log("## Agent suite (OpenCode, 6 tasks, hidden verifiers)\n");
console.log("| configuration | runs | tasks passed (per run) | mean wall / run | mean wait before 1st step | tool calls / run | tool errors / run | mean swap growth / task | cost / run |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const [cfg, rs] of configs) {
  const passed = rs.map((r) => Object.values(r.tasks).filter((t) => t.success).length);
  const totals = rs.map((r) => Object.values(r.tasks).reduce((a, t) => a + t.wallS, 0));
  const waits = rs.flatMap((r) => Object.values(r.tasks).map((t) => t.timeToFirstOutputS ?? NaN)).filter(Number.isFinite);
  const tools = rs.flatMap((r) => Object.values(r.tasks).map((t) => t.toolCalls));
  const terr = rs.flatMap((r) => Object.values(r.tasks).map((t) => t.toolErrors));
  const swap = rs.flatMap((r) => Object.values(r.tasks).map((t) => (t.mem.maxSwapMB - t.mem.startSwapMB) / 1024));
  const costs = rs.map((r) => Object.values(r.tasks).reduce((a, t) => a + (t.costUsd ?? 0), 0));
  const cost = rs.some((r) => Object.values(r.tasks).some((t) => t.costUsd !== undefined)) ? `$${mean(costs).toFixed(2)} (API-equiv.)` : "$0 (local)";
  console.log(`| ${label(cfg)} | ${rs.length} | ${passed.map((p) => `${p}/6`).join(", ")} | ${f0(mean(totals))} s ± ${f0(sd(totals))} | ${f0(mean(waits))} s | ${f0(mean(tools.length ? [tools.reduce((a, b) => a + b, 0) / rs.length] : []))} | ${f0(terr.reduce((a, b) => a + b, 0) / rs.length)} | ${f1(mean(swap))} GB | ${cost} |`);
}
console.log("\n### Per task: success rate and mean wall time (s)\n");
console.log(`| configuration | ${TASKS.map((t) => `${t}`).join(" | ")} |`);
console.log(`|---|${TASKS.map(() => "---").join("|")}|`);
for (const [cfg, rs] of configs) {
  const cells = TASKS.map((t) => {
    const xs = rs.map((r) => r.tasks[t]).filter(Boolean);
    if (!xs.length) return "—";
    return `${xs.filter((x) => x.success).length}/${xs.length} · ${f0(mean(xs.map((x) => x.wallS)))}`;
  });
  console.log(`| ${label(cfg)} | ${cells.join(" | ")} |`);
}
console.log("\nTasks: A codegen+tests · B repo understanding · C multi-file feature · D debugging · E tool execution · F multi-step (includes a route-shadowing trap).");

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
