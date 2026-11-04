import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { projectId } from "../intel/index.ts";
import { opencodeAgent } from "./agents/opencode.ts";
import { solve, type SolveOptions } from "./solve.ts";

export const SOLVE_HELP = `  solve "<task>" [--repo dir] [--attempts 3] [--budget 15m] [--apply] [--test "cmd"]
                                  best-of-N attempts in throwaway git worktrees, judged by the
                                  repo's own tests; --apply writes a passing attempt to your checkout`;

const USAGE = `usage: pitcrew solve "<task>" [options]

  --repo <dir>          repository to work on (default: current directory)
  --attempts <n>        attempts at most (default 3); stops at the first one with evidence
  --budget <time>       wall-clock budget for all attempts, e.g. 900s, 15m, 1h (default 15m)
  --test "<command>"    test command (default: detected, e.g. npm test)
  --test-first          ask the agent to add a failing test before fixing
  --apply               apply the best attempt to the checkout if its tests pass and no test was weakened
  --apply-best          apply the best attempt even if it did not pass (benchmarks)
  --model <id>          OpenCode model (default pitcrew/auto, through the running gateway)
  --opencode-config <f> OpenCode profile (default ~/.pitcrew/opencode.json, else the bundled example)
  --out <dir>           where patches and report.json go (default ~/.pitcrew/solve/<run>)
  --json                print the report as JSON at the end (progress on stderr)
  --format json         also stream the agent's events as JSON lines (for harnesses)`;

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** "900", "900s", "15m", "1h" → ms. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration: ${s}`);
  const n = Number(m[1]);
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "s") as "ms" | "s" | "m" | "h"]);
}

const VALUED = new Set(["repo", "attempts", "budget", "test", "model", "opencode-config", "out", "format", "config"]);

export async function solveCli(args: string[]): Promise<number> {
  const task = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && VALUED.has(args[i - 1]!.slice(2))));
  if (!task || args.includes("--help")) {
    console.log(USAGE);
    return task ? 0 : 1;
  }
  const json = args.includes("--json") || opt(args, "format") === "json";
  const stream = opt(args, "format") === "json";
  const log = (l: string) => (json ? console.error(`[solve] ${l}`) : console.log(l));
  const { config } = loadConfig(opt(args, "config"));
  const model = opt(args, "model") ?? `pitcrew/${config.router.name}`;

  if (model.startsWith("pitcrew/")) {
    const url = `http://${config.listen.host}:${config.listen.port}/healthz`;
    const up = await fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
    if (!up) {
      console.error(`pitcrew solve: the gateway is not running at ${url}; start it with \`pitcrew serve\` first`);
      return 1;
    }
  }
  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "opencode", "opencode.pitcrew.json");
  const own = join(homedir(), ".pitcrew", "opencode.json");
  const configPath = opt(args, "opencode-config") ?? (existsSync(own) ? own : bundled);
  const repo = resolve(opt(args, "repo") ?? ".");
  const outDir = opt(args, "out") ?? join(config.stateDir, "solve", `${new Date().toISOString().replace(/[:.]/g, "-")}-${projectId(repo)}`);

  const o: SolveOptions = {
    repo,
    task,
    agent: opencodeAgent({ model, configPath }),
    attempts: Number(opt(args, "attempts") ?? 3),
    budgetMs: parseDuration(opt(args, "budget") ?? "15m"),
    testCommand: opt(args, "test"),
    testFirst: args.includes("--test-first"),
    apply: args.includes("--apply-best") ? "best" : args.includes("--apply") ? "passing" : "never",
    outDir,
    log,
    onEvent: stream ? (line) => console.log(line) : undefined,
  };
  const r = await solve(o);
  if (json) {
    console.log(JSON.stringify(stream ? { type: "pitcrew_solve", report: r } : r));
    return r.status === "solved" || r.status === "passed-weak" ? 0 : 2;
  }
  const best = r.attempts.find((a) => a.n === r.best);
  console.log(`\n${r.status.toUpperCase()} in ${Math.round(r.ms / 1000)} s, ${r.attempts.length} attempt(s)`);
  if (r.status === "passed-weak") console.log("tests pass, but they also passed before the change and no new test failed on the original code: review the diff");
  if (r.status === "needs-review") console.log("tests pass only with edits to existing tests: review before using it");
  if (best?.patch) console.log(`best: attempt ${best.n} → ${best.patch}`);
  if (r.applied) console.log("applied to your checkout");
  else if (r.applyError) console.log(`not applied: ${r.applyError}`);
  else if (best?.patch && o.apply === "never") console.log(`apply with: git -C ${r.repo} apply ${best.patch}`);
  console.log(`report: ${join(outDir, "report.json")}`);
  return r.status === "solved" || r.status === "passed-weak" ? 0 : 2;
}
