import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { failingTests, type FailingTest } from "../server/levers.ts";
import { EXCLUDE, git, type Worktree } from "./worktree.ts";

/**
 * Judges an attempt with the repository's own tests — never hidden ones. Evidence that the change
 * does what was asked: tests that failed before now pass, or the attempt's new tests fail on the
 * original code and pass with the change (fail-to-pass). Tests passing alone is weak evidence.
 */

export interface TestRun {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  ms: number;
  pass?: number;
  fail?: number;
  failing: FailingTest[];
}

function counts(out: string): { pass?: number; fail?: number } {
  const n = (re: RegExp) => {
    const m = re.exec(out);
    return m ? Number(m[1]) : undefined;
  };
  const pass = n(/^# pass (\d+)/m) ?? n(/Tests:.*?(\d+) passed/) ?? n(/(\d+) passed\b/);
  const fail = n(/^# fail (\d+)/m) ?? n(/Tests:.*?(\d+) failed/) ?? n(/(\d+) failed\b/);
  return { ...(pass !== undefined ? { pass } : {}), ...(fail !== undefined ? { fail } : {}) };
}

/** Runs the test command in `dir` (whole process group killed on timeout). */
export function runTests(dir: string, command: string, timeoutMs: number): Promise<TestRun> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    // NODE_TEST_CONTEXT would turn a nested `node --test` into a child of ours.
    const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
    const child = spawn(command, { cwd: dir, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...env, CI: "1", FORCE_COLOR: "0" } });
    let out = "";
    const take = (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > 2_000_000) out = out.slice(-1_000_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const c = counts(out);
      resolve({ ok: code === 0 && !timedOut, code, timedOut, ms: Date.now() - t0, ...c, failing: failingTests(out) });
    });
  });
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const CASES = /\b(?:test|it)(?:\.only)?\s*\(\s*["'`]|^\s*(?:async\s+)?def test_\w*|^func Test\w*/gm;
const SKIPS = /\b(?:test|it|describe)\.(?:skip|todo)\s*\(|\b(?:test|it|describe)\s*\(\s*(["'`]).*?\1\s*,\s*\{[^}]*\b(?:skip|todo)\s*:(?!\s*false)|\bt\.(?:skip|todo)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bt\.Skip(?:Now|f)?\(/g;

export const isTestFile = (path: string) => TEST_FILE.test(path);

function inventory(text: string): { tests: number; skips: number } {
  return { tests: (text.match(CASES) ?? []).length, skips: (text.match(SKIPS) ?? []).length };
}

export interface Verdict {
  tests: TestRun;
  diff: { files: number; added: number; removed: number };
  testFiles: { added: string[]; modified: string[]; deleted: string[] };
  /** Test cases after minus before, over the test files the attempt touched. */
  testCasesAdded: number;
  /** Fewer test cases or more skip markers in touched test files than before. */
  weakened: boolean;
  /** fixed-failing: the suite failed at the base and passes now; fail-to-pass: the attempt's new tests fail on the base. */
  evidence: "fixed-failing" | "fail-to-pass" | "none";
  /** Tests pass, something changed, no test weakened, no existing test edited or deleted. */
  acceptable: boolean;
  /** Acceptable with evidence: stop trying. */
  strong: boolean;
}

export interface JudgeContext {
  baseRev: string;
  command: string;
  timeoutMs: number;
  /** The suite failed at the base revision. */
  baselineFailed: boolean;
  /** A worktree at the base, used for the fail-to-pass check (reset before and after). */
  baseTree: Worktree;
}

export async function judgeAttempt(wt: Worktree, ctx: JudgeContext): Promise<Verdict> {
  const dir = wt.dir;
  git(dir, ["add", "-A", "-N", "--", ".", ...EXCLUDE]);
  const rows = git(dir, ["diff", "--numstat", "--no-renames", ctx.baseRev, "--", ".", ...EXCLUDE]).out.split("\n").filter(Boolean).map((l) => {
    const [a, r, ...f] = l.split("\t");
    return { added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r), file: f.join("\t") };
  });
  const status = git(dir, ["diff", "--name-status", "--no-renames", ctx.baseRev, "--", ".", ...EXCLUDE]).out.split("\n").filter(Boolean).map((l) => {
    const [s, ...f] = l.split("\t");
    return { s: s![0], file: f.join("\t") };
  });
  const tf = status.filter((x) => isTestFile(x.file));
  const testFiles = {
    added: tf.filter((x) => x.s === "A").map((x) => x.file),
    modified: tf.filter((x) => x.s === "M").map((x) => x.file),
    deleted: tf.filter((x) => x.s === "D").map((x) => x.file),
  };
  const before = { tests: 0, skips: 0 };
  for (const f of [...testFiles.modified, ...testFiles.deleted]) {
    const c = inventory(git(dir, ["show", `${ctx.baseRev}:${f}`]).out);
    before.tests += c.tests;
    before.skips += c.skips;
  }
  const after = { tests: 0, skips: 0, addedTests: 0 };
  for (const f of [...testFiles.modified, ...testFiles.added]) {
    const c = inventory(readFileSync(join(dir, f), "utf8"));
    after.tests += c.tests;
    after.skips += c.skips;
    if (testFiles.added.includes(f)) after.addedTests += c.tests;
  }
  const weakened = after.tests - after.addedTests < before.tests || after.skips > before.skips;
  const tests = await runTests(dir, ctx.command, ctx.timeoutMs);
  const diff = { files: rows.length, added: rows.reduce((s, r) => s + r.added, 0), removed: rows.reduce((s, r) => s + r.removed, 0) };
  const acceptable = tests.ok && diff.files > 0 && !weakened && !testFiles.modified.length && !testFiles.deleted.length;

  let evidence: Verdict["evidence"] = "none";
  if (acceptable && ctx.baselineFailed) evidence = "fixed-failing";
  else if (acceptable && testFiles.added.length) {
    // The new tests, dropped onto the original code: they should fail there.
    ctx.baseTree.reset();
    for (const f of testFiles.added) {
      mkdirSync(dirname(join(ctx.baseTree.dir, f)), { recursive: true });
      copyFileSync(join(dir, f), join(ctx.baseTree.dir, f));
    }
    const onBase = await runTests(ctx.baseTree.dir, ctx.command, ctx.timeoutMs);
    if (!onBase.ok && !onBase.timedOut) evidence = "fail-to-pass";
    for (const f of testFiles.added) if (existsSync(join(ctx.baseTree.dir, f))) rmSync(join(ctx.baseTree.dir, f));
    ctx.baseTree.reset();
  }
  return { tests, diff, testFiles, testCasesAdded: after.tests - before.tests, weakened, evidence, acceptable, strong: acceptable && evidence !== "none" };
}

/** Best first: strong, acceptable, passing; then more evidence, more new test cases, smaller diff. */
export function rank(a: Verdict, b: Verdict): number {
  const key = (v: Verdict) => [v.strong ? 1 : 0, v.acceptable ? 1 : 0, v.tests.ok ? 1 : 0, v.testCasesAdded, -(v.tests.fail ?? (v.tests.ok ? 0 : 1)), -(v.diff.added + v.diff.removed)];
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i]! - ka[i]!;
  return 0;
}
