#!/usr/bin/env node
// Benchmark harness: runs OpenCode headlessly against a disposable copy of the
// fixture repo for each task, samples memory/swap, and verifies results with
// hidden tests the agent never sees.
//
// usage: node run.mjs --model ollama/<name> --label <label> [--tests A,B,C,D,E,F] [--timeout 900]

import { spawn, execSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const MODEL = args.model;
// "opencode" (default) or "claude" (Claude Code CLI, isolated from user plugins/hooks/MCP).
const AGENT = args.agent ?? "opencode";
// Claude Code runs without any permission bypass: only these tools are pre-approved and every
// other request is denied automatically (dontAsk). Edits stay inside the temp repo (cwd).
const CLAUDE_ALLOWED = [
  "Read", "Glob", "Grep", "Edit", "Write", "TodoWrite",
  "Bash(npm test)", "Bash(npm test:*)", "Bash(node --experimental-strip-types:*)",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
  "Bash(ls:*)", "Bash(wc:*)", "Bash(cat:*)", "Bash(head:*)",
];
/** Read-only git commands addressed to this task's own temp repo by absolute path (`git -C <dir> …`). */
function claudeAllowed(dir) {
  const dirs = [dir, dir.startsWith("/tmp/") ? `/private${dir}` : dir];
  return [...CLAUDE_ALLOWED, ...dirs.flatMap((d) => ["status", "diff", "log"].map((c) => `Bash(git -C ${d} ${c}:*)`))];
}
const LABEL = args.label ?? MODEL.replace(/\W+/g, "_");
const TESTS = (args.tests ?? "A,B,C,D,E,F").split(",");
const TIMEOUT_S = Number(args.timeout ?? 900);
if (!MODEL) throw new Error("--model required");

const TASKS = {
  A: {
    name: "Basic code generation",
    prompt:
      "Create src/utils/chunk.ts exporting `chunk<T>(items: T[], size: number): T[][]` that splits `items` into consecutive groups of `size` (the last group may be shorter; empty input returns []; the input array must not be mutated). It must throw a RangeError if `size` is not a positive integer. Add tests in tests/chunk.test.ts following the existing test conventions, then run the test suite and make sure everything passes.",
    verify: "A_chunk.verify.ts",
  },
  B: {
    name: "Repository understanding",
    prompt:
      "Do not modify any files. Explore this repository and explain: (1) language, runtime and web framework (if any), (2) overall architecture and layers, (3) how HTTP routing works, (4) where application state lives, (5) the API client layer, (6) testing conventions and how tests are run. Be concise and cite file paths.",
    rubric: [
      ["no framework / node:http", /node:http|no (web )?framework|zero[- ]dependenc|without (a|any) (web )?framework/i],
      ["Router class + :param regex", /Router/],
      ["TaskStore in-memory Map", /TaskStore/],
      ["in-memory state", /in-memory|Map/i],
      ["TaskClient uses fetch", /TaskClient/],
      ["fetch", /fetch/],
      ["node:test runner", /node:test|node --test|built-in test/i],
      ["strip-types", /strip-types/i],
      ["tests call router.handle directly", /router\.handle|handle\(/],
    ],
  },
  C: {
    name: "Multi-file feature",
    prompt:
      'Add a task priority feature. Requirements: (1) in src/types/task.ts add `export type TaskPriority = "low" | "medium" | "high"`, add `priority: TaskPriority` to Task and an optional `priority` to NewTaskInput; (2) the store defaults priority to "medium"; (3) POST /tasks accepts an optional priority and returns 400 with {"error":"invalid priority"} for invalid values; (4) GET /tasks supports a `priority` query filter that can be combined with `status`, returning 400 for an invalid priority; (5) TaskClient.list accepts a `priority` option and sends it as a query parameter. Add tests for the new behaviour, run the test suite and make sure everything passes.',
    verify: "C_priority.verify.ts",
  },
  D: {
    name: "Debugging",
    setup: (dir) => cpSync(join(HERE, "hidden/slugify.buggy.ts"), join(dir, "src/utils/slugify.ts")),
    prompt:
      "`npm test` is failing. Run it, diagnose the root cause, and fix the bug in the source code. Do not modify any test files. Re-run the tests to confirm the fix.",
    verifyFn: (dir) => {
      const changedTests = sh("git diff --name-only -- tests", dir).trim();
      return { testsUntouched: changedTests === "", changedTests };
    },
  },
  E: {
    name: "Tool execution",
    prompt:
      "Read package.json to find the test command, run the test suite, and tell me exactly how many tests passed and how many failed. Then run `git log --oneline | wc -l` and report the number. Do not modify any files.",
    verifyFn: (dir, text) => ({
      reportsPass9: /\b9\b[^.\n]*pass|pass[^.\n]*\b9\b/i.test(text),
      reportsFail0: /\b0\b[^.\n]*fail|fail[^.\n]*\b0\b|no (tests )?fail/i.test(text),
      reportsCommits1: /\b1\b/.test(text),
      filesUnchanged: sh("git status --porcelain", dir).trim() === "",
    }),
  },
  F: {
    name: "Reliability (multi-step)",
    prompt:
      "Do the following in order: (1) rename the TaskStore method `getAllTasks` to `listTasks` everywhere in the codebase; (2) add a TaskStore method `countByStatus(): Record<TaskStatus, number>` that returns counts for every status (including zeros); (3) expose it as `GET /tasks/stats`, returning that object as JSON; (4) add a test for the new endpoint; (5) run the test suite and fix any failures; (6) run `git diff --stat` and summarize what changed.",
    verify: "F_stats.verify.ts",
  },
};

/** Map Claude Code stream-json events onto the harness metrics. */
function claudeStats(events) {
  const blocks = (type, role) => events.filter((e) => e.type === role).flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === type));
  const tools = blocks("tool_use", "assistant");
  const results = blocks("tool_result", "user");
  const res = events.find((e) => e.type === "result") ?? {};
  const u = res.usage ?? {};
  return {
    text: [...blocks("text", "assistant").map((b) => b.text), res.result ?? ""].join("\n"),
    tools,
    toolErrors: results.filter((r) => r.is_error).map((r) => String(typeof r.content === "string" ? r.content : JSON.stringify(r.content)).slice(0, 160)),
    turns: res.num_turns ?? tools.length,
    tokens: { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, reasoning: 0 },
    errors: res.is_error ? [{ error: res.result ?? res.subtype }] : [],
    costUsd: res.total_cost_usd,
    models: Object.keys(res.modelUsage ?? {}),
    denials: (res.permission_denials ?? []).map((d) => `${d.tool_name}: ${JSON.stringify(d.tool_input).slice(0, 100)}`),
  };
}

function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

function memSample() {
  const swap = execSync("sysctl -n vm.swapusage", { encoding: "utf8" });
  const used = Number(/used = ([\d.]+)M/.exec(swap)?.[1] ?? NaN);
  const mp = execSync("memory_pressure -Q", { encoding: "utf8" });
  const free = Number(/free percentage: (\d+)%/.exec(mp)?.[1] ?? NaN);
  return { t: Date.now(), swapUsedMB: used, freePct: free };
}

function testCounts(out) {
  return {
    pass: Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0),
    fail: Number(/^# fail (\d+)/m.exec(out)?.[1] ?? 0),
  };
}

async function runTask(key) {
  const task = TASKS[key];
  const dir = `/tmp/qbench/${LABEL}/${key}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(join(HERE, "fixture"), dir, { recursive: true });
  task.setup?.(dir);
  sh('git init -q && git add -A && git -c user.email=bench@local -c user.name=bench commit -qm baseline', dir);

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
  clearTimeout(killer);
  clearInterval(sampler);
  samples.push(memSample());
  const wallS = (Date.now() - t0) / 1000;

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
      a.input = Math.max(a.input, (t.input ?? 0) + (t.cache?.read ?? 0));
      a.output += t.output ?? 0;
      a.reasoning += t.reasoning ?? 0;
      return a;
    },
    { input: 0, output: 0, reasoning: 0 },
  );
  const errors = cc ? cc.errors : events.filter((e) => e.type === "error");

  // Verification.
  const suite = testCounts(sh("npm test 2>&1", dir));
  let verify = null;
  if (task.verify) {
    mkdirSync(join(dir, ".verify"), { recursive: true });
    cpSync(join(HERE, "hidden", task.verify), join(dir, ".verify", task.verify.replace(".verify.ts", ".test.ts")));
    const out = sh(`node --experimental-strip-types --no-warnings --test .verify/*.test.ts 2>&1`, dir);
    verify = testCounts(out);
    if (verify.fail) verify.output = out.split("\n").filter((l) => /not ok|Error|expected|actual/.test(l)).slice(0, 12);
  }
  const extra = task.verifyFn?.(dir, text) ?? {};
  let rubric = null;
  if (task.rubric) {
    rubric = Object.fromEntries(task.rubric.map(([k, re]) => [k, re.test(text)]));
    extra.filesUnchanged = sh("git status --porcelain", dir).trim() === "";
  }

  let success;
  if (task.verify) success = verify.fail === 0 && verify.pass > 0 && suite.fail === 0 && suite.pass > 0;
  else if (key === "D") success = suite.fail === 0 && suite.pass > 0 && extra.testsUntouched;
  else if (key === "E") success = Object.values(extra).every(Boolean);
  else if (key === "B") success = extra.filesUnchanged && Object.values(rubric).filter(Boolean).length >= 7;

  const result = {
    label: LABEL,
    model: MODEL,
    task: key,
    name: task.name,
    success,
    timedOut,
    exitCode,
    wallS,
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
    suiteAfter: suite,
    verify,
    rubric,
    extra,
    mem: {
      minFreePct: Math.min(...samples.map((s) => s.freePct)),
      startSwapMB: samples[0].swapUsedMB,
      maxSwapMB: Math.max(...samples.map((s) => s.swapUsedMB)),
    },
    diffStat: sh("git diff --stat", dir).trim().split("\n").slice(-1)[0],
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
    `[${LABEL}] ${key} ${r.name}: ${r.success ? "PASS" : "FAIL"} | ${r.wallS.toFixed(0)}s | ttfo ${r.timeToFirstOutputS ?? "-"}s | tools ${r.toolCalls} (err ${r.toolErrors}) | verify ${r.verify ? `${r.verify.pass}/${r.verify.pass + r.verify.fail}` : "-"} | suite ${r.suiteAfter.pass}/${r.suiteAfter.pass + r.suiteAfter.fail} | minFree ${r.mem.minFreePct}% swap ${r.mem.startSwapMB}->${r.mem.maxSwapMB}MB${r.timedOut ? " | TIMEOUT" : ""}`,
  );
}
