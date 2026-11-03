#!/usr/bin/env node
// Self-test for the agent benchmark (no agent, no model): for every task with a reference,
//   (a) the plain prepared task dir must FAIL its success rule,
//   (b) the prepared dir + reference solution (+ reference answer text) must PASS, and
//   (c) every known-wrong "trap" solution declared by the task must FAIL.
// Uses the same prepareTaskDir/evaluate code as run.mjs. For A–F it also checks that the generic
// rule agrees with the original hard-coded success formula.
//
// usage: node bench/agent/selftest.mjs [--tasks A,G,H] [--keep]

import { rmSync } from "node:fs";
import { prepareTaskDir, evaluate, overlay, sh } from "./lib.mjs";
import { TASKS, REGRESSION } from "./tasks.mjs";

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const KEYS = opt("tasks")?.split(",") ?? Object.keys(TASKS);
const KEEP = argv.includes("--keep");
const ROOT = "/tmp/qbench-selftest";

/** The pre-refactor success formula from run.mjs (L258-262), for A–F agreement checks. */
function legacySuccess(key, r, pre) {
  const ok = (c) => c && c.fail === 0 && c.pass > 0;
  if (["A", "C", "F"].includes(key)) return ok(r.verify) && ok(r.suite);
  if (key === "D") return ok(r.suite) && pre.testsUntouched;
  if (key === "E") return Object.values(r.extra).every(Boolean);
  if (key === "B") return pre.filesUnchanged && Object.values(r.rubric).filter(Boolean).length >= 7;
  return undefined;
}

/** mode: "plain" | "ref" | trap index (number). */
function runCase(key, task, mode) {
  const dir = `${ROOT}/${key}/${typeof mode === "number" ? `trap${mode}` : mode}`;
  const t0 = Date.now();
  const startRev = prepareTaskDir(task, dir);
  let text = "";
  const answer = (a) => (typeof a === "function" ? a(dir, { sh, startRev }) : (a ?? ""));
  if (mode === "ref") {
    if (task.reference.overlay) overlay(dir, task.reference.overlay);
    text = answer(task.reference.answer);
  } else if (typeof mode === "number") {
    const trap = task.traps[mode];
    trap.apply(dir);
    text = answer(trap.answer ?? task.reference.answer);
  }
  // Old checks, computed the old way (before evaluate's intent-to-add), for the agreement test.
  const pre = {
    testsUntouched: sh("git diff --name-only -- tests", dir).trim() === "",
    filesUnchanged: sh("git status --porcelain", dir).trim() === "",
  };
  const r = evaluate(task, dir, text, startRev);
  const legacy = REGRESSION.includes(key) ? legacySuccess(key, r, pre) : undefined;
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
  return { ...r, legacy, ms: Date.now() - t0 };
}

const fmt = (c) => (c ? `${c.pass}/${c.pass + c.fail}` : "-");
const rows = [];
let violations = 0;
console.log(`selftest: ${KEYS.length} tasks → ${ROOT}\n`);
console.log("| task | name | plain | plain failed checks | reference | ref verify | ref suite | ref diff (+/-, tests +/-) | A–F legacy agrees | s |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const key of KEYS) {
  const task = TASKS[key];
  if (!task) throw new Error(`unknown task ${key}`);
  if (!task.reference) {
    console.log(`| ${key} | ${task.name} | (no reference) | | | | | | | |`);
    continue;
  }
  const plain = runCase(key, task, "plain");
  const ref = runCase(key, task, "ref");
  const issues = [];
  if (plain.success) issues.push("plain PASSED");
  const trapRows = (task.traps ?? []).map((trap, i) => {
    const r = runCase(key, task, i);
    if (r.success) issues.push(`trap "${trap.name}" PASSED (verifier does not catch it)`);
    return `trap "${trap.name}": ${r.success ? "PASS ✗" : `FAIL ✓ (${r.failedChecks.join(", ")}; verify ${fmt(r.verify)}, suite ${fmt(r.suite)})`}`;
  });
  if (!ref.success) issues.push(`reference FAILED (${ref.failedChecks.join(",")})`);
  if (!ref.success && ref.verify?.output) issues.push(ref.verify.output.join(" / "));
  let agrees = "n/a";
  if (plain.legacy !== undefined) {
    const same = plain.legacy === plain.success && ref.legacy === ref.success;
    agrees = same ? "yes" : "NO";
    if (!same) issues.push(`legacy disagrees: plain ${plain.legacy}/${plain.success}, ref ${ref.legacy}/${ref.success}`);
  }
  violations += issues.length ? 1 : 0;
  const d = ref.diff;
  console.log(
    `| ${key} | ${task.name} | ${plain.success ? "PASS ✗" : "FAIL ✓"} | ${plain.failedChecks.join(", ")} (verify ${fmt(plain.verify)}, suite ${fmt(plain.suite)}) | ${ref.success ? "PASS ✓" : "FAIL ✗"} | ${fmt(ref.verify)} | ${fmt(ref.suite)} | +${d.added}/-${d.removed}, tests +${d.testsAdded}/-${d.testsRemoved}${d.testsWeakened ? " WEAKENED" : ""} | ${agrees} | ${((plain.ms + ref.ms) / 1000).toFixed(1)} |`,
  );
  for (const t of trapRows) console.log(`    ${key} ${t}`);
  for (const i of issues) console.log(`    !! ${key}: ${i}`);
  rows.push({ key, plain, ref, issues });
}
console.log(`\n${violations ? `SELFTEST FAILED: ${violations} task(s) violate expectations` : `SELFTEST OK: ${rows.length} tasks (plain fails, reference passes, ${rows.reduce((a, r) => a + (TASKS[r.key].traps?.length ?? 0), 0)} traps fail)`}`);
process.exit(violations ? 1 : 0);
