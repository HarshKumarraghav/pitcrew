import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { opencodeAgent, type Agent } from "../src/solve/agents/opencode.ts";
import { parseDuration } from "../src/solve/cli.ts";
import { solve } from "../src/solve/solve.ts";

const gitIn = (dir: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });

/** A tiny node:test repo. `bug`: add() subtracts, so the suite fails at the start. */
function repo(bug: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pitcrew-solve-test-")));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(dir, "src", "add.js"), `export const add = (a, b) => a ${bug ? "-" : "+"} b;\n`);
  writeFileSync(join(dir, "tests", "add.test.js"), `import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/add.js";\ntest("adds", () => assert.equal(add(2, 2), 4));\n`);
  gitIn(dir, "init", "-q");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", "base");
  return dir;
}

const FIX = (d: string) => writeFileSync(join(d, "src", "add.js"), "export const add = (a, b) => a + b;\n");
const MUL = (d: string) => writeFileSync(join(d, "src", "mul.js"), "export const mul = (a, b) => a * b;\n");
const MUL_TEST = (d: string) => writeFileSync(join(d, "tests", "mul.test.js"), `import { test } from "node:test";\nimport assert from "node:assert";\nimport { mul } from "../src/mul.js";\ntest("multiplies", () => assert.equal(mul(3, 4), 12));\n`);

/** An agent that runs one scripted edit per attempt. */
function scripted(steps: ((dir: string) => void)[], prompts: string[] = []): Agent {
  let i = 0;
  return {
    name: "scripted",
    async run({ dir, prompt }) {
      prompts.push(prompt);
      steps[i++]?.(dir);
      return { exitCode: 0, timedOut: false, ms: 1, steps: 1, toolCalls: 1, toolErrors: 0, text: "done" };
    },
  };
}

const opts = (dir: string, agent: Agent, extra: Partial<Parameters<typeof solve>[0]> = {}) => ({
  repo: dir, task: "fix it", agent, outDir: join(dir, "..", `out-${Math.random().toString(36).slice(2)}`), minAttemptMs: 1, budgetMs: 120_000, ...extra,
});
const worktrees = (dir: string) => gitIn(dir, "worktree", "list").trim().split("\n").length;

test("solve: stops at the first attempt that fixes the failing suite, then applies it", async () => {
  const dir = repo(true);
  const r = await solve(opts(dir, scripted([() => {}, FIX, FIX]), { apply: "passing" }));
  assert.equal(r.baseline.ok, false);
  assert.deepEqual(r.baseline.failing, ["adds"]);
  assert.equal(r.attempts.length, 2, "stopped after the attempt with evidence");
  assert.equal(r.attempts[0]!.verdict?.diff.files, 0);
  assert.equal(r.attempts[1]!.verdict?.evidence, "fixed-failing");
  assert.equal(r.status, "solved");
  assert.equal(r.best, 2);
  assert.equal(r.applied, true);
  assert.match(readFileSync(join(dir, "src", "add.js"), "utf8"), /a \+ b/);
  assert.equal(worktrees(dir), 1, "worktrees removed");
  assert.ok(existsSync(r.attempts[1]!.patch!));
});

test("solve: deleting, skipping or editing tests never counts, and is never applied", async () => {
  const dir = repo(true);
  const del = (d: string) => rmSync(join(d, "tests", "add.test.js"));
  const skip = (d: string) => writeFileSync(join(d, "tests", "add.test.js"), readFileSync(join(d, "tests", "add.test.js"), "utf8").replace('test("adds"', 'test.skip("adds"'));
  const edit = (d: string) => writeFileSync(join(d, "tests", "add.test.js"), readFileSync(join(d, "tests", "add.test.js"), "utf8").replace("4)", "0)"));
  const r = await solve(opts(dir, scripted([del, skip, edit]), { apply: "passing" }));
  assert.equal(r.attempts.length, 3);
  for (const a of r.attempts) {
    assert.equal(a.verdict?.tests.ok, true, "the suite itself passes");
    assert.equal(a.verdict?.acceptable, false);
  }
  assert.equal(r.attempts[0]!.verdict?.weakened, true);
  assert.equal(r.attempts[1]!.verdict?.weakened, true);
  assert.deepEqual(r.attempts[2]!.verdict?.testFiles.modified, ["tests/add.test.js"]);
  assert.equal(r.status, "needs-review");
  assert.equal(r.applied, false);
  assert.match(readFileSync(join(dir, "src", "add.js"), "utf8"), /a - b/, "checkout untouched");
});

test("solve: on a passing suite, only a new test that fails on the original code is evidence", async () => {
  const dir = repo(false);
  const trivial = (d: string) => {
    MUL(d);
    writeFileSync(join(d, "tests", "trivial.test.js"), `import { test } from "node:test";\ntest("ok", () => {});\n`);
  };
  const r = await solve(opts(dir, scripted([MUL, trivial, (d) => (MUL(d), MUL_TEST(d)), FIX]), { attempts: 4 }));
  assert.equal(r.baseline.ok, true);
  assert.deepEqual(r.attempts.map((a) => a.verdict?.evidence), ["none", "none", "fail-to-pass"]);
  assert.deepEqual(r.attempts.map((a) => a.verdict?.acceptable), [true, true, true]);
  assert.equal(r.attempts[2]!.verdict?.testCasesAdded, 1);
  assert.equal(r.status, "solved");
  assert.equal(r.best, 3);
  assert.equal(r.applied, true, "apply defaults to passing");
  assert.ok(existsSync(join(dir, "tests", "mul.test.js")));
});

test("solve: weak passes are reported as such; test-first adds an instruction", async () => {
  const dir = repo(false);
  const prompts: string[] = [];
  const r = await solve(opts(dir, scripted([MUL, MUL], prompts), { attempts: 2, testFirst: true, apply: "never" }));
  assert.equal(r.status, "passed-weak");
  assert.equal(r.attempts.length, 2, "a weak pass does not end the search");
  assert.match(prompts[0]!, /^fix it\n\nWork test-first/);
  assert.equal(existsSync(join(dir, "src", "mul.js")), false, "apply: never");
});

test("solve: the budget is split across attempts and stops early when spent", async () => {
  const dir = repo(true);
  // A fake clock that only the agent advances, so test-run time on a busy machine cannot matter.
  let clock = 0;
  const slow: Agent = { name: "slow", run: async () => ((clock += 1600), { exitCode: 0, timedOut: false, ms: 1600, steps: 1, toolCalls: 0, toolErrors: 0, text: "" }) };
  // Attempt 1 gets max(minAttempt, remaining / 3); after it, less than minAttempt is left.
  const r = await solve(opts(dir, slow, { attempts: 3, budgetMs: 4000, minAttemptMs: 2500, now: () => clock }));
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0]!.timeoutMs, 2500);
  assert.equal(r.status, "unsolved");
});

test("solve: uncommitted edits are the starting point; the checkout itself is not touched", async () => {
  const dir = repo(true);
  FIX(dir); // the user already fixed it but did not commit; attempts start from that state
  const seen: string[] = [];
  const r = await solve(opts(dir, { name: "peek", run: async ({ dir: d }) => (seen.push(readFileSync(join(d, "src", "add.js"), "utf8")), { exitCode: 0, timedOut: false, ms: 1, steps: 0, toolCalls: 0, toolErrors: 0, text: "" }) }, { attempts: 1 }));
  assert.equal(r.base.dirty, true);
  assert.equal(r.baseline.ok, true);
  assert.match(seen[0]!, /a \+ b/);
  assert.equal(gitIn(dir, "status", "--porcelain").trim(), "M src/add.js", "checkout as it was");
  assert.equal(gitIn(dir, "stash", "list").trim(), "", "no stash entry created");
});

test("opencode adapter: headless flags, closed stdin, events parsed and passed on", async () => {
  const bin = join(realpathSync(mkdtempSync(join(tmpdir(), "pitcrew-fake-oc-"))), "opencode");
  // Waits for stdin like the real `opencode run` does: only returns because stdin is closed.
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\nfor a; do last="$a"; done\necho "$@" > "$OPENCODE_FAKE_ARGS"\necho '{"type":"step_start"}'\necho '{"type":"tool_use","part":{"state":{"status":"completed"}}}'\necho '{"type":"tool_use","part":{"state":{"status":"error"}}}'\necho '{"type":"text","part":{"text":"all done"}}'\necho '{"type":"step_finish"}'\n`);
  chmodSync(bin, 0o755);
  process.env.OPENCODE_FAKE_ARGS = `${bin}.args`;
  const lines: string[] = [];
  const r = await opencodeAgent({ model: "pitcrew/auto", configPath: "/x/opencode.json", bin }).run({ dir: "/tmp/wt", prompt: "do it", timeoutMs: 10_000, onEvent: (l) => lines.push(l) });
  assert.equal(r.exitCode, 0);
  assert.deepEqual([r.steps, r.toolCalls, r.toolErrors], [1, 2, 1]);
  assert.match(r.text, /all done/);
  assert.equal(lines.length, 5);
  assert.equal(readFileSync(`${bin}.args`, "utf8").trim(), "run --pure --format json -m pitcrew/auto --dir /tmp/wt do it");
  const missing = await opencodeAgent({ model: "m", configPath: "c", bin: "/nonexistent/opencode" }).run({ dir: "/tmp", prompt: "x", timeoutMs: 1000 });
  assert.match(missing.error ?? "", /ENOENT/);
});

test("durations", () => {
  assert.equal(parseDuration("900"), 900_000);
  assert.equal(parseDuration("15m"), 900_000);
  assert.equal(parseDuration("1.5h"), 5_400_000);
  assert.throws(() => parseDuration("soon"));
});
