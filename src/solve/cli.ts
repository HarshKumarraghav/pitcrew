import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { projectId, scanProject } from "../intel/index.ts";
import { claudeAgent, detectAgents } from "./agents/claude.ts";
import { opencodeAgent, type Agent } from "./agents/opencode.ts";
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
  --agent <name>        local attempts with: opencode (default) or claude (Claude Code on the
                        local models through the gateway, as bin/claude-local)
  --model <id>          model for the local attempts (default pitcrew/auto, through the gateway)
  --escalate <id>       one last attempt with a stronger model if nothing passed with evidence,
                        e.g. pitcrew/big (a models.big alias with "exclusive": true)
  --helper claude       last resort: your own Claude Code login (cloud) gets the task, the failing
                        tests and the best local diff, only if no local attempt produced evidence
                        (config: helper.agent; default off; helper.maxPerDay caps it)
  --no-helper           ignore helper.agent from the config for this run
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

const VALUED = new Set(["repo", "attempts", "budget", "test", "agent", "model", "escalate", "helper", "opencode-config", "out", "format", "config"]);

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
  const testCommand = opt(args, "test") ?? scanProject(repo).index.profile.testCommand;
  // Local attempts: OpenCode, or Claude Code pointed at the gateway (model names → the router).
  const gateway = `http://${config.listen.host}:${config.listen.port}`;
  const local = (m: string): Agent =>
    opt(args, "agent") === "claude"
      ? claudeAgent({
          name: `claude-local:${m}`,
          testCommand,
          env: localClaudeEnv(gateway, m.replace(/^pitcrew\//, "")),
        })
      : opencodeAgent({ model: m, configPath });
  const helperName = args.includes("--no-helper") ? null : (opt(args, "helper") ?? config.helper.agent);
  if (helperName && helperName !== "claude") throw new Error(`unknown helper "${helperName}" (supported: claude)`);
  if (helperName) {
    const c = detectAgents().find((a) => a.name === "claude");
    if (!c?.installed || !c.loggedIn) {
      console.error("pitcrew solve: --helper claude needs Claude Code installed and logged in (`claude auth login`)");
      return 1;
    }
    log(`helper: Claude Code with your own login (cloud). Used only if no local attempt produces evidence; at most ${config.helper.maxPerDay} per day.`);
  }
  const outDir = opt(args, "out") ?? join(config.stateDir, "solve", `${new Date().toISOString().replace(/[:.]/g, "-")}-${projectId(repo)}`);

  const o: SolveOptions = {
    repo,
    task,
    agent: local(model),
    escalate: opt(args, "escalate") ? local(opt(args, "escalate")!) : undefined,
    helper: helperName ? { agent: claudeAgent({ name: "claude (cloud helper)", testCommand }), maxPerDay: config.helper.maxPerDay, usageFile: join(config.stateDir, "helper-usage.json") } : undefined,
    attempts: Number(opt(args, "attempts") ?? 3),
    budgetMs: parseDuration(opt(args, "budget") ?? "15m"),
    testCommand,
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
  if (r.helper) console.log(r.helper.used ? `cloud helper used${r.helper.costUsd !== undefined ? ` (reported ≈ $${r.helper.costUsd.toFixed(2)} API-equivalent)` : ""}` : `cloud helper not used: ${r.helper.reason}`);
  if (r.applied) console.log("applied to your checkout");
  else if (r.applyError) console.log(`not applied: ${r.applyError}`);
  else if (best?.patch && o.apply === "never") console.log(`apply with: git -C ${r.repo} apply ${best.patch}`);
  console.log(`report: ${join(outDir, "report.json")}`);
  return r.status === "solved" || r.status === "passed-weak" ? 0 : 2;
}

/** The environment bin/claude-local sets: Claude Code on local models through the gateway. */
export function localClaudeEnv(gateway: string, model: string, ctx = 32768): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: gateway,
    ANTHROPIC_AUTH_TOKEN: "pitcrew",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(ctx),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(ctx),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
}
