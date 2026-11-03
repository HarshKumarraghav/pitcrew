#!/usr/bin/env node
// Benchmark harness: runs OpenCode (or Claude Code) headlessly against a disposable copy of the
// fixture repo for each task, samples memory/swap, and verifies results with hidden tests the
// agent never sees. Task definitions live in tasks.mjs; preparation + evaluation in lib.mjs
// (shared with selftest.mjs, which checks every task's reference solution without an agent).
//
// usage: node run.mjs --model <id> [--label <label>] [--repeat N] [--tests A,B,...|hard|all]
//                     [--timeout 900] [--agent opencode|claude]
//   --repeat N   appends "-rN" to the label (results dir and /tmp dir)

import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, prepareTaskDir, evaluate } from "./lib.mjs";
import { TASKS, HARD, REGRESSION } from "./tasks.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const MODEL = args.model;
if (!MODEL) throw new Error("--model required");
// "opencode" (default) or "claude" (Claude Code CLI, isolated from user plugins/hooks/MCP).
const AGENT = args.agent ?? "opencode";
// Claude Code runs without any permission bypass: only these tools are pre-approved and every
// other request is denied automatically (dontAsk). Edits stay inside the temp repo (cwd).
// Read-only git subcommands only (P needs history inspection: log/show/blame).
const GIT_READ = ["status", "diff", "log", "show", "blame"];
const CLAUDE_ALLOWED = [
  "Read", "Glob", "Grep", "Edit", "Write", "TodoWrite",
  "Bash(npm test)", "Bash(npm test:*)", "Bash(node --experimental-strip-types:*)",
  ...GIT_READ.map((c) => `Bash(git ${c}:*)`),
  "Bash(ls:*)", "Bash(wc:*)", "Bash(cat:*)", "Bash(head:*)",
];
/** Read-only git commands addressed to this task's own temp repo by absolute path (`git -C <dir> …`). */
function claudeAllowed(dir) {
  const dirs = [dir, dir.startsWith("/tmp/") ? `/private${dir}` : dir];
  return [...CLAUDE_ALLOWED, ...dirs.flatMap((d) => GIT_READ.map((c) => `Bash(git -C ${d} ${c}:*)`))];
}
const LABEL = (args.label ?? MODEL.replace(/\W+/g, "_")) + (args.repeat ? `-r${args.repeat}` : "");
const TESTS = args.tests === "all" ? [...REGRESSION, ...HARD] : args.tests === "hard" ? HARD : (args.tests ?? REGRESSION.join(",")).split(",");
const TIMEOUT_S = Number(args.timeout ?? 900);
for (const k of TESTS) if (!TASKS[k]) throw new Error(`unknown task ${k}`);

/** Map Claude Code stream-json events onto the harness metrics. */
function claudeStats(events) {
  const blocks = (type, role) => events.filter((e) => e.type === role).flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === type));
  const tools = blocks("tool_use", "assistant");
  const results = blocks("tool_result", "user");
  const res = events.find((e) => e.type === "result") ?? {};
  const u = res.usage ?? {};
  const prompt = (x) => (x?.input_tokens ?? 0) + (x?.cache_read_input_tokens ?? 0) + (x?.cache_creation_input_tokens ?? 0);
  // Per-request prompt size: each assistant event carries its request's usage (repeated per content
  // block of the same message, which does not affect the max).
  const inputPeak = Math.max(0, ...events.filter((e) => e.type === "assistant").map((e) => prompt(e.message?.usage)));
  const inputTotal = prompt(u);
  return {
    text: [...blocks("text", "assistant").map((b) => b.text), res.result ?? ""].join("\n"),
    tools,
    toolErrors: results.filter((r) => r.is_error).map((r) => String(typeof r.content === "string" ? r.content : JSON.stringify(r.content)).slice(0, 160)),
    turns: res.num_turns ?? tools.length,
    // `input` = inputPeak for both agents (was the session total for Claude before; see opencode below).
    tokens: { input: inputPeak, inputPeak, inputTotal, output: u.output_tokens ?? 0, reasoning: 0 },
    errors: res.is_error ? [{ error: res.result ?? res.subtype }] : [],
    costUsd: res.total_cost_usd,
    models: Object.keys(res.modelUsage ?? {}),
    denials: (res.permission_denials ?? []).map((d) => `${d.tool_name}: ${JSON.stringify(d.tool_input).slice(0, 100)}`),
  };
}

function memSample() {
  const swap = execSync("sysctl -n vm.swapusage", { encoding: "utf8" });
  const used = Number(/used = ([\d.]+)M/.exec(swap)?.[1] ?? NaN);
  const mp = execSync("memory_pressure -Q", { encoding: "utf8" });
  const free = Number(/free percentage: (\d+)%/.exec(mp)?.[1] ?? NaN);
  return { t: Date.now(), swapUsedMB: used, freePct: free };
}

async function runTask(key) {
  const task = TASKS[key];
  const dir = `/tmp/qbench/${LABEL}/${key}`;
  const startRev = prepareTaskDir(task, dir);

  const samples = [memSample()];
  const sampler = setInterval(() => samples.push(memSample()), 2000);

  const env = {
    ...process.env,
    OPENCODE_CONFIG: process.env.PITCREW_OPENCODE_PROFILE ?? join(HERE, "..", "..", "examples", "opencode", "opencode.local.json"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: { edit: "allow", bash: "allow", webfetch: "deny", external_directory: "deny" },
    }),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  };
  const t0 = Date.now();
  // The monotonic clock stops while the Mac sleeps; the wall clock does not. Their difference is time asleep.
  const mono0 = performance.now();
  let firstOutputAt = null;
  const events = [];
  let buf = "";
  const child =
    AGENT === "claude"
      ? spawn(
          "claude",
          [
            "-p",
            "--model", MODEL,
            // Isolation: skip user settings (plugins, hooks), load no MCP servers, keep no session.
            "--setting-sources", "project,local",
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--no-session-persistence",
            "--output-format", "stream-json", "--verbose",
            "--permission-mode", "dontAsk",
            "--disallowedTools", "WebFetch,WebSearch",
            "--allowedTools", claudeAllowed(dir).join(","),
          ],
          { cwd: dir, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
        )
      : spawn("opencode", ["run", "--pure", "--format", "json", "-m", MODEL, "--dir", dir, task.prompt], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
  if (AGENT === "claude") child.stdin.end(task.prompt); // prompt via stdin (tool flags are variadic)
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        ev._t = Date.now() - t0;
        events.push(ev);
        if (firstOutputAt === null && (AGENT === "claude" ? ev.type === "assistant" : ev.type !== "step_start")) firstOutputAt = ev._t;
      } catch {
        events.push({ type: "raw", line, _t: Date.now() - t0 });
      }
    }
  });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, TIMEOUT_S * 1000);
  const exitCode = await new Promise((r) => child.on("close", r));
  const t1 = Date.now(); // agent process wall clock ends here; verification is excluded
  clearTimeout(killer);
  clearInterval(sampler);
  samples.push(memSample());
  const wallS = (t1 - t0) / 1000;
  const sleptS = Math.max(0, Math.round(wallS - (performance.now() - mono0) / 1000));

  // Extract agent text + tool stats from the event stream.
  const cc = AGENT === "claude" ? claudeStats(events) : null;
  const text = cc ? cc.text : events
    .filter((e) => e.type === "text")
    .map((e) => e.part?.text ?? "")
    .join("\n");
  const tools = cc ? cc.tools : events.filter((e) => e.type === "tool_use");
  const toolErrors = cc ? cc.toolErrors : tools.filter((e) => e.part?.state?.status === "error");
  const steps = cc ? { length: cc.turns } : events.filter((e) => e.type === "step_finish");
  const tokens = cc ? cc.tokens : steps.reduce(
    (a, e) => {
      const t = e.part?.tokens ?? {};
      const prompt = (t.input ?? 0) + (t.cache?.read ?? 0);
      a.inputPeak = Math.max(a.inputPeak, prompt);
      a.inputTotal += prompt;
      a.input = a.inputPeak; // `input` keeps its old meaning: largest single-request prompt
      a.output += t.output ?? 0;
      a.reasoning += t.reasoning ?? 0;
      return a;
    },
    { input: 0, inputPeak: 0, inputTotal: 0, output: 0, reasoning: 0 },
  );
  const errors = cc ? cc.errors : events.filter((e) => e.type === "error");

  // Verification (shared with selftest.mjs).
  const ev = evaluate(task, dir, text, startRev);

  const result = {
    label: LABEL,
    model: MODEL,
    task: key,
    name: task.name,
    success: ev.success,
    failedChecks: ev.failedChecks,
    timedOut,
    exitCode,
    wallS,
    // A run during which the machine slept (lid closed, idle sleep) measures nothing: excluded from tables.
    sleptS,
    sleptBy: "clock",
    invalid: sleptS > 5 ? `machine slept ${sleptS} s` : undefined,
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date(t1).toISOString(),
    startedAtMs: t0,
    endedAtMs: t1,
    repeat: args.repeat ? Number(args.repeat) : undefined,
    timeToFirstOutputS: firstOutputAt === null ? null : firstOutputAt / 1000,
    steps: steps.length,
    toolCalls: tools.length,
    toolErrors: toolErrors.length,
    toolErrorSamples: cc ? toolErrors.slice(0, 3) : toolErrors.slice(0, 3).map((e) => `${e.part?.tool}: ${String(e.part?.state?.error).slice(0, 160)}`),
    agent: AGENT,
    costUsd: cc?.costUsd,
    modelsUsed: cc?.models,
    permissionDenials: cc?.denials,
    tokens,
    agentErrors: errors.map((e) => JSON.stringify(e.error ?? e).slice(0, 300)),
    suiteAfter: ev.suite,
    verify: ev.verify,
    rubric: ev.rubric,
    extra: ev.extra,
    checks: ev.checks,
    diff: ev.diff,
    baseRev: startRev,
    mem: {
      minFreePct: Math.min(...samples.map((s) => s.freePct)),
      startSwapMB: samples[0].swapUsedMB,
      maxSwapMB: Math.max(...samples.map((s) => s.swapUsedMB)),
    },
    diffStat: ev.diffStat,
    finalText: text.slice(-1500),
    stderrTail: stderr.slice(-500),
  };
  const outDir = join(HERE, "results", LABEL);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${key}.json`), JSON.stringify(result, null, 2));
  writeFileSync(join(outDir, `${key}.events.jsonl`), events.map((e) => JSON.stringify(e)).join("\n"));
  return result;
}

for (const key of TESTS) {
  const r = await runTask(key);
  console.log(
    `[${LABEL}] ${key} ${r.name}: ${r.success ? "PASS" : `FAIL (${r.failedChecks.join(",")})`} | ${r.wallS.toFixed(0)}s | ttfo ${r.timeToFirstOutputS ?? "-"}s | tools ${r.toolCalls} (err ${r.toolErrors}) | verify ${r.verify ? `${r.verify.pass}/${r.verify.pass + r.verify.fail}` : "-"} | suite ${r.suiteAfter.pass}/${r.suiteAfter.pass + r.suiteAfter.fail} | minFree ${r.mem.minFreePct}% swap ${r.mem.startSwapMB}->${r.mem.maxSwapMB}MB${r.timedOut ? " | TIMEOUT" : ""}${r.invalid ? ` | INVALID: ${r.invalid}` : ""}`,
  );
}
