import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanProject } from "../intel/index.ts";
import type { Agent, AgentRun } from "./agents/opencode.ts";
import { judgeAttempt, rank, runTests, type Verdict } from "./judge.ts";
import { applyPatch, baseOf, createWorktree } from "./worktree.ts";

/**
 * `pitcrew solve`: best-of-N on the local model. Each attempt runs the agent in its own git
 * worktree from the same starting point; the repository's own tests judge it; the first attempt
 * with real evidence ends the search. The user's checkout is only changed with `apply`.
 */

export interface SolveOptions {
  repo: string;
  task: string;
  agent: Agent;
  attempts?: number;
  /** Wall-clock budget for all attempts together (agent + judging). */
  budgetMs?: number;
  /** Defaults to the command the project profile detects (e.g. `npm test`). */
  testCommand?: string;
  testTimeoutMs?: number;
  /** An attempt gets at least this long, or is not started. */
  minAttemptMs?: number;
  /** Ask the agent to add a failing test first (gives the judge fail-to-pass evidence). */
  testFirst?: boolean;
  /** never · passing (default: only an acceptable attempt) · best (whatever ranked first, for benchmarks). */
  apply?: "never" | "passing" | "best";
  outDir: string;
  log?: (line: string) => void;
  /** Raw agent events, for harnesses that read them. */
  onEvent?: (line: string) => void;
  /** Clock for the budget (tests). */
  now?: () => number;
}

export interface AttemptReport {
  n: number;
  timeoutMs: number;
  agent: Omit<AgentRun, "text">;
  verdict?: Omit<Verdict, "tests"> & { tests: Omit<Verdict["tests"], "failing"> & { failing: string[] } };
  patch?: string;
  error?: string;
}

export type SolveStatus = "solved" | "passed-weak" | "needs-review" | "unsolved";

export interface SolveReport {
  repo: string;
  task: string;
  agent: string;
  base: { rev: string; dirty: boolean; untracked: number };
  testCommand: string;
  baseline: { ok: boolean; pass?: number; fail?: number; failing: string[] };
  attempts: AttemptReport[];
  best?: number;
  /** solved: tests pass with evidence · passed-weak: tests pass but passed before too · needs-review: tests pass only with test edits · unsolved. */
  status: SolveStatus;
  applied: boolean;
  applyError?: string;
  budgetMs: number;
  ms: number;
}

const TEST_FIRST = "\n\nWork test-first: add a new test that reproduces the problem or specifies the new behaviour and check that it fails, then change the code until the whole test suite passes. Do not edit, skip or delete existing tests.";

export async function solve(o: SolveOptions): Promise<SolveReport> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const log = o.log ?? (() => {});
  const attempts = Math.max(1, o.attempts ?? 3);
  const budgetMs = o.budgetMs ?? 15 * 60_000;
  const testTimeoutMs = o.testTimeoutMs ?? 5 * 60_000;
  const minAttemptMs = o.minAttemptMs ?? 60_000;
  const base = baseOf(o.repo);
  const testCommand = o.testCommand ?? scanProject(base.root).index.profile.testCommand;
  if (!testCommand) throw new Error("no test command found for this project; pass one with --test \"<command>\"");
  if (base.untracked.length) log(`note: ${base.untracked.length} untracked file(s) are not visible to the attempts (commit or stage them to include them)`);
  mkdirSync(o.outDir, { recursive: true });

  const baseTree = createWorktree(base, "base");
  const report: SolveReport = {
    repo: base.root,
    task: o.task,
    agent: o.agent.name,
    base: { rev: base.rev, dirty: base.dirty, untracked: base.untracked.length },
    testCommand,
    baseline: { ok: false, failing: [] },
    attempts: [],
    status: "unsolved",
    applied: false,
    budgetMs,
    ms: 0,
  };
  const verdicts = new Map<number, { v: Verdict; patch: string }>();
  try {
    const b = await runTests(baseTree.dir, testCommand, testTimeoutMs);
    report.baseline = { ok: b.ok, pass: b.pass, fail: b.fail, failing: b.failing.map((t) => t.name) };
    log(`baseline: \`${testCommand}\` ${b.ok ? "passes" : `fails (${b.failing.length || b.fail || "?"} failing)`} at ${base.rev.slice(0, 8)}${base.dirty ? " (incl. uncommitted edits)" : ""}`);
    const ctx = { baseRev: base.rev, command: testCommand, timeoutMs: testTimeoutMs, baselineFailed: !b.ok, baseTree };

    for (let n = 1; n <= attempts; n++) {
      const remaining = budgetMs - (now() - t0);
      if (remaining < minAttemptMs) {
        log(`budget spent: ${Math.round(remaining / 1000)} s left, stopping before attempt ${n}`);
        break;
      }
      // Split what is left evenly, so a slow first attempt cannot use up every later one.
      const timeoutMs = Math.max(minAttemptMs, Math.floor(remaining / (attempts - n + 1)));
      const wt = createWorktree(base, `attempt-${n}`);
      const a: AttemptReport = { n, timeoutMs, agent: { exitCode: null, timedOut: false, ms: 0, steps: 0, toolCalls: 0, toolErrors: 0 } };
      report.attempts.push(a);
      try {
        log(`attempt ${n}/${attempts}: ${o.agent.name}, up to ${Math.round(timeoutMs / 1000)} s`);
        o.onEvent?.(JSON.stringify({ type: "pitcrew_attempt", n }));
        const { text: _text, ...run } = await o.agent.run({ dir: wt.dir, prompt: o.task + (o.testFirst ? TEST_FIRST : ""), timeoutMs, onEvent: o.onEvent });
        a.agent = run;
        const v = await judgeAttempt(wt, ctx);
        const patch = wt.patch();
        a.patch = join(o.outDir, `attempt-${n}.patch`);
        writeFileSync(a.patch, patch);
        a.verdict = { ...v, tests: { ...v.tests, failing: v.tests.failing.map((t) => t.name) } };
        verdicts.set(n, { v, patch });
        log(`attempt ${n}: ${describe(v)} · ${Math.round(run.ms / 1000)} s, ${run.toolCalls} tool calls${run.timedOut ? ", timed out" : ""}`);
        if (v.strong) break;
      } catch (e) {
        a.error = (e as Error).message;
        log(`attempt ${n}: error: ${a.error}`);
      } finally {
        wt.remove();
      }
    }

    const ranked = [...verdicts.entries()].sort((x, y) => rank(x[1].v, y[1].v));
    const top = ranked[0];
    if (top) {
      const [n, { v, patch }] = top;
      report.best = n;
      report.status = v.strong ? "solved" : v.acceptable ? "passed-weak" : v.tests.ok && v.diff.files ? "needs-review" : "unsolved";
      const mode = o.apply ?? "passing";
      if (patch && (mode === "best" || (mode === "passing" && v.acceptable))) {
        const r = applyPatch(base.root, patch, join(o.outDir, "applied.patch"));
        report.applied = r.ok;
        if (!r.ok) report.applyError = r.out.trim().slice(0, 500);
      }
    }
  } finally {
    baseTree.remove();
    report.ms = now() - t0;
    writeFileSync(join(o.outDir, "report.json"), JSON.stringify(report, null, 2));
  }
  return report;
}

export function describe(v: Verdict): string {
  const t = v.tests.ok ? "tests pass" : v.tests.timedOut ? "tests timed out" : `tests fail${v.tests.failing.length ? ` (${v.tests.failing.length})` : ""}`;
  const flags = [
    v.diff.files ? `${v.diff.files} file(s) +${v.diff.added}/-${v.diff.removed}` : "no changes",
    v.testCasesAdded > 0 ? `+${v.testCasesAdded} test case(s)` : "",
    v.evidence !== "none" ? `evidence: ${v.evidence}` : "",
    v.weakened ? "tests weakened" : "",
    v.testFiles.modified.length || v.testFiles.deleted.length ? "existing tests edited" : "",
  ].filter(Boolean);
  return `${t}, ${flags.join(", ")}`;
}
