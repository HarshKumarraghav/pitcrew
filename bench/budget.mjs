#!/usr/bin/env node
// Time budget per agent task: joins a run's results (startedAtMs/endedAtMs + OpenCode events) with
// the gateway's request log (~/.pitcrew/requests.jsonl) and splits wall time into
//   startup · queue/load · prefill · reasoning decode · content decode · other decode · tools ·
//   client overhead (gaps between requests not covered by a tool) · shutdown.
// Components are plain sums, not a catch-all, so `sumPct` ≈ 100 only if the clocks line up and
// nothing is double counted (the M7.0 gate: within 5%). Helper requests run beside the agent and
// are reported separately.
//
// usage: node bench/budget.mjs <results-dir> [<results-dir>…] [--log ~/.pitcrew/requests.jsonl] [--json]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function loadRequests(path = join(homedir(), ".pitcrew", "requests.jsonl")) {
  const files = [`${path}.1`, path].filter(existsSync);
  return files.flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean),
  );
}

function union(intervals) {
  const s = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur;
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/** result: one task result JSON; events: its OpenCode events; requests: all request records. */
export function timeBudget(result, events, requests) {
  const t0 = result.startedAtMs;
  const t1 = result.endedAtMs;
  if (!t0 || !t1) return undefined;
  const inWin = requests.filter((r) => r.tMs >= t0 - 500 && r.tMs <= t1);
  const agent = inWin.filter((r) => r.kind !== "helper").sort((a, b) => a.tMs - b.tMs);
  const helpers = inWin.filter((r) => r.kind === "helper");
  const ms = { startup: 0, queue: 0, prefill: 0, reasoning: 0, content: 0, otherDecode: 0, tools: 0, client: 0, shutdown: 0 };
  const tools = events
    .filter((e) => e.type === "tool_use" && e.part?.state?.time)
    .map((e) => [e.part.state.time.start, e.part.state.time.end ?? e.part.state.time.start]);
  for (const r of agent) {
    const lease = r.leaseMs ?? 0;
    ms.queue += lease;
    ms.prefill += r.prefillMs ?? 0;
    const dec = r.decodeMs ?? 0;
    const rd = r.reasoningDecodeMs ?? 0;
    const cd = r.contentDecodeMs ?? 0;
    ms.reasoning += rd;
    ms.content += cd;
    ms.otherDecode += Math.max(0, dec - rd - cd);
  }
  const ends = agent.map((r) => r.tMs + (r.endMs ?? 0));
  if (agent.length) {
    ms.startup = Math.max(0, agent[0].tMs - t0);
    ms.shutdown = Math.max(0, t1 - ends[ends.length - 1]);
    for (let i = 1; i < agent.length; i++) {
      const a = ends[i - 1];
      const b = agent[i].tMs;
      if (b <= a) continue;
      const inGap = union(tools.map(([x, y]) => [Math.max(x, a), Math.min(y, b)]));
      ms.tools += inGap;
      ms.client += b - a - inGap;
    }
    // Tools after the last request (rare: killed mid-tool) count as tools, not shutdown.
    const tail = union(tools.map(([x, y]) => [Math.max(x, ends[ends.length - 1]), Math.min(y, t1)]));
    ms.tools += tail;
    ms.shutdown -= tail;
  } else ms.startup = t1 - t0;
  const wall = t1 - t0;
  const sum = Object.values(ms).reduce((a, b) => a + b, 0);
  const s = (x) => Math.round(x / 100) / 10;
  return {
    task: result.task,
    label: result.label,
    success: result.success,
    wallS: s(wall),
    ...Object.fromEntries(Object.entries(ms).map(([k, v]) => [`${k}S`, s(v)])),
    sumPct: Math.round((sum / wall) * 1000) / 10,
    reasoningSharePct: Math.round((ms.reasoning / wall) * 1000) / 10,
    agentRequests: agent.length,
    compactions: agent.filter((r) => r.kind === "compaction").length,
    helperRequests: helpers.length,
    helperS: s(helpers.reduce((a, r) => a + (r.endMs ?? 0), 0)),
    promptTokensPeak: Math.max(0, ...agent.map((r) => r.promptTokens ?? 0)),
    estUncachedPromptTokens: agent.reduce((a, r) => a + (r.estUncachedPromptTokens ?? 0), 0),
    completionTokens: agent.reduce((a, r) => a + (r.completionTokens ?? 0), 0),
  };
}

export function budgetsForDir(dir, requests) {
  return readdirSync(dir)
    .filter((f) => /^[A-Z]\.json$/.test(f))
    .sort()
    .map((f) => {
      const result = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const evFile = join(dir, f.replace(".json", ".events.jsonl"));
      const events = existsSync(evFile)
        ? readFileSync(evFile, "utf8").split("\n").filter(Boolean).map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return {};
            }
          })
        : [];
      return timeBudget(result, events, requests) ?? { task: result.task, label: result.label, missing: "no startedAtMs/endedAtMs (run predates M7.0)" };
    });
}

const COLS = ["task", "success", "wallS", "startupS", "queueS", "prefillS", "reasoningS", "contentS", "otherDecodeS", "toolsS", "clientS", "shutdownS", "sumPct", "reasoningSharePct", "agentRequests", "compactions"];

export function formatBudgets(rows) {
  const lines = [`| ${COLS.join(" | ")} |`, `|${COLS.map(() => "---").join("|")}|`];
  for (const r of rows) lines.push(`| ${COLS.map((c) => (r.missing && c !== "task" ? (c === "success" ? r.missing : "") : r[c] ?? "")).join(" | ")} |`);
  const ok = rows.filter((r) => !r.missing);
  if (ok.length) {
    const tot = (k) => ok.reduce((a, r) => a + (r[k] ?? 0), 0);
    const wall = tot("wallS");
    const share = ["queueS", "prefillS", "reasoningS", "contentS", "otherDecodeS", "toolsS", "clientS", "startupS", "shutdownS"]
      .map((k) => [k.replace(/S$/, ""), Math.round((tot(k) / wall) * 1000) / 10])
      .sort((a, b) => b[1] - a[1]);
    lines.push("", `share of wall time (all tasks): ${share.map(([k, v]) => `${k} ${v}%`).join(" · ")}`);
    const bad = ok.filter((r) => Math.abs(r.sumPct - 100) > 5);
    lines.push(bad.length ? `⚠ budget does not add up (±5%) for: ${bad.map((r) => `${r.task} ${r.sumPct}%`).join(", ")}` : "✔ every task's budget sums to within 5% of wall time");
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const li = argv.indexOf("--log");
  const log = li >= 0 ? argv[li + 1] : undefined;
  const dirs = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--log");
  const requests = loadRequests(log);
  for (const d of dirs) {
    const rows = budgetsForDir(d, requests);
    if (argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
    else console.log(`\n### ${d}\n\n${formatBudgets(rows)}`);
  }
}
