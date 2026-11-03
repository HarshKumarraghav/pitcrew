// Shared harness code: task-dir preparation and evaluation. Used by run.mjs (real agent runs)
// and selftest.mjs (reference solutions, no agent) so both exercise exactly the same code path.

import { execSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, appendFileSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));

/** Run a shell command; never throws (returns stdout+stderr on failure, like the original harness). */
export function sh(cmd, cwd, env) {
  try {
    return execSync(cmd, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  } catch (e) {
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

export function testCounts(out) {
  return {
    pass: Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0),
    fail: Number(/^# fail (\d+)/m.exec(out)?.[1] ?? 0),
  };
}

/** Copy a directory under bench/agent (e.g. "setup/H", "reference/H") over the task dir. */
export function overlay(dir, rel) {
  cpSync(join(HERE, rel), dir, { recursive: true });
}

const BENCH_ID = "-c user.email=bench@local -c user.name=bench";
/** Fixed identity + clock for history-building tasks, so commit hashes are reproducible. */
export function fixedGitEnv(dateIso) {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@local",
    GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@local",
    GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso,
  };
}
const BASELINE_DATE = "2026-01-05T09:00:00Z";

/**
 * Prepare a disposable repo for a task: copy fixture, `setup(dir)`, baseline commit,
 * then `setupGit(dir, ctx)` (may add commits). Returns the revision the agent starts from.
 */
export function prepareTaskDir(task, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(join(HERE, task.fixture ?? "fixture"), dir, { recursive: true });
  task.setup?.(dir);
  // Only history tasks get a pinned baseline date; A–F keep the original (wall-clock) baseline commit.
  const env = task.setupGit ? fixedGitEnv(BASELINE_DATE) : undefined;
  sh(`git init -q && git add -A && git ${BENCH_ID} commit -qm baseline`, dir, env);
  // Hidden verifiers are copied into .verify/ after the run; keep them out of every git-based check.
  appendFileSync(join(dir, ".git", "info", "exclude"), "\n.verify/\n");
  task.setupGit?.(dir, { sh, overlay, fixedGitEnv });
  return sh("git rev-parse HEAD", dir).trim();
}

// ---------------------------------------------------------------------------------------------
// Evaluation

const TEST_CALL = /\b(?:test|it)(?:\.only)?\s*\(\s*["'`]/g;
// test.skip(…) / it.todo(…) / t.skip() / test("name", { skip: … }, fn) — the options object must be test()'s 2nd argument.
const SKIP_MARK = /\b(?:test|it|describe)\.(?:skip|todo)\s*\(|\b(?:test|it|describe)\s*\(\s*(["'`]).*?\1\s*,\s*\{[^}]*\b(?:skip|todo)\s*:(?!\s*false)|\bt\.(?:skip|todo)\s*\(/g;

function countIn(text) {
  return { tests: (text.match(TEST_CALL) ?? []).length, skips: (text.match(SKIP_MARK) ?? []).length };
}

function walk(dir, rel = "") {
  const abs = join(dir, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r];
  });
}

/** Static count of test cases and skip/todo markers under tests/, at a revision or in the worktree. */
function testInventory(dir, rev) {
  const files = rev
    ? sh(`git ls-tree -r --name-only ${rev} -- tests`, dir).trim().split("\n").filter(Boolean)
    : walk(dir, "tests");
  const acc = { tests: 0, skips: 0 };
  for (const f of files.filter((f) => /\.[cm]?[jt]s$/.test(f))) {
    const c = countIn(rev ? sh(`git show ${rev}:${f}`, dir) : readFileSync(join(dir, f), "utf8"));
    acc.tests += c.tests;
    acc.skips += c.skips;
  }
  return acc;
}

/** Diff size vs the start revision, including untracked files (intent-to-add must already be done). */
function diffRecord(dir, rev) {
  const rows = sh(`git diff --numstat --no-renames ${rev}`, dir)
    .trim().split("\n").filter(Boolean)
    .map((l) => {
      const [a, r, ...f] = l.split("\t");
      return { added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r), file: f.join("\t") };
    });
  const sum = (xs, k) => xs.reduce((s, x) => s + x[k], 0);
  const tests = rows.filter((x) => x.file.startsWith("tests/"));
  const before = testInventory(dir, rev);
  const after = testInventory(dir, null);
  return {
    files: rows.length,
    added: sum(rows, "added"),
    removed: sum(rows, "removed"),
    testFiles: tests.length,
    testsAdded: sum(tests, "added"),
    testsRemoved: sum(tests, "removed"),
    testCasesBefore: before.tests,
    testCasesAfter: after.tests,
    skipsBefore: before.skips,
    skipsAfter: after.skips,
    // Heuristic for the quality score: fewer test cases or more skip/todo markers than at the start.
    testsWeakened: after.tests < before.tests || after.skips > before.skips,
  };
}

/** Changes under tests/ (plus task-protected paths) vs the start revision, including untracked files. */
function protectedChanges(dir, rev, paths) {
  const quoted = paths.map((p) => `'${p}'`).join(" ");
  return sh(`git diff --name-status --no-renames ${rev} -- ${quoted}`, dir)
    .trim().split("\n").filter(Boolean)
    .map((l) => {
      const [status, ...f] = l.split("\t");
      return { status: status[0], file: f.join("\t") };
    });
}

/** Run all checks for a finished task dir. `text` is the agent's final text. */
export function evaluate(task, dir, text, startRev) {
  // Git-level checks first; intent-to-add makes untracked files visible to `git diff`.
  sh("git add -A -N", dir);
  const changes = protectedChanges(dir, startRev, ["tests", ...(task.protect ?? [])]);
  const checks = {
    filesUnchanged: sh("git status --porcelain", dir).trim() === "",
    testsUntouched: changes.length === 0, // nothing changed, added or deleted
    existingTestsUntouched: changes.every((c) => c.status === "A"), // new test files allowed
    changedTests: changes.map((c) => `${c.status} ${c.file}`),
  };
  const diff = diffRecord(dir, startRev);
  const diffStat = sh(`git diff --stat ${startRev}`, dir).trim().split("\n").slice(-1)[0];

  const suite = testCounts(sh("npm test 2>&1", dir));
  let verify = null;
  if (task.verify) {
    mkdirSync(join(dir, ".verify"), { recursive: true });
    cpSync(join(HERE, "hidden", task.verify), join(dir, ".verify", task.verify.replace(".verify.ts", ".test.ts")));
    const out = sh(`node --experimental-strip-types --no-warnings --test .verify/*.test.ts 2>&1`, dir);
    verify = testCounts(out);
    if (verify.fail || !verify.pass) verify.output = out.split("\n").filter((l) => /not ok|Error|expected|actual/.test(l)).slice(0, 12);
  }
  const extra = task.verifyFn?.(dir, text, { sh, startRev }) ?? {};
  const rubric = task.rubric ? Object.fromEntries(task.rubric.map(([k, re]) => [k, re.test(text)])) : null;

  const r = { suite, verify, extra, rubric, checks, diff, diffStat };
  const { success, failedChecks } = judge(task.success, r);
  return { ...r, success, failedChecks };
}

/**
 * Generic success rule. A task declares e.g.
 *   success: { verify: true, suite: true, testsUntouched: true | "existing", rubricMin: 7, extraAll: true, filesUnchanged: true }
 * testsUntouched: true = no file under tests/ (or task.protect) changed/added/deleted;
 *                 "existing" = no pre-existing test file changed/deleted (new test files allowed).
 */
export function judge(rule, r) {
  if (!rule) throw new Error("task has no success rule");
  const failed = [];
  const ok = (c) => c && c.fail === 0 && c.pass > 0;
  if (rule.verify && !ok(r.verify)) failed.push("verify");
  if (rule.suite && !ok(r.suite)) failed.push("suite");
  if (rule.testsUntouched === true && !r.checks.testsUntouched) failed.push("testsUntouched");
  if (rule.testsUntouched === "existing" && !r.checks.existingTestsUntouched) failed.push("existingTestsUntouched");
  if (rule.filesUnchanged && !r.checks.filesUnchanged) failed.push("filesUnchanged");
  if (rule.rubricMin != null && !(r.rubric && Object.values(r.rubric).filter(Boolean).length >= rule.rubricMin)) failed.push("rubric");
  // Only boolean entries are checks; verifyFn may also return informational values.
  if (rule.extraAll && !Object.values(r.extra).filter((v) => typeof v === "boolean").every(Boolean)) failed.push("extra");
  return { success: failed.length === 0, failedChecks: failed };
}
