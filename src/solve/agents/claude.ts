import { spawn, spawnSync } from "node:child_process";
import type { Agent, AgentRun } from "./opencode.ts";

/**
 * Claude Code in headless mode (`claude -p --output-format stream-json`), isolated the way the
 * benchmark runs it: no user settings or MCP servers, no web tools, no saved session, and
 * `dontAsk` permissions with an allow-list (file tools, the project's test command, read-only git).
 *
 * `env` decides where it runs: nothing = the user's own Claude login (a cloud helper); the
 * variables from bin/claude-local = local models through Pit Crew.
 */
export function claudeAgent(opts: { model?: string; bin?: string; env?: Record<string, string>; testCommand?: string; name?: string }): Agent {
  const GIT_READ = ["status", "diff", "log", "show", "blame"];
  const allowed = [
    "Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "TodoWrite",
    ...(opts.testCommand ? [`Bash(${opts.testCommand})`, `Bash(${opts.testCommand}:*)`] : []),
    ...GIT_READ.map((c) => `Bash(git ${c}:*)`),
    "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(wc:*)",
  ];
  return {
    name: opts.name ?? `claude:${opts.model ?? "default"}`,
    run({ dir, prompt, timeoutMs, onEvent }) {
      const t0 = Date.now();
      const args = [
        "-p",
        ...(opts.model ? ["--model", opts.model] : []),
        "--setting-sources", "project,local",
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--no-session-persistence",
        "--output-format", "stream-json", "--verbose",
        "--permission-mode", "dontAsk",
        "--disallowedTools", "WebFetch,WebSearch",
        "--allowedTools", allowed.join(","),
      ];
      return new Promise((resolve) => {
        const child = spawn(opts.bin ?? "claude", args, { cwd: dir, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
        // The prompt goes on stdin: the tool flags are variadic and would swallow it.
        child.stdin.end(prompt);
        const r: AgentRun = { exitCode: null, timedOut: false, ms: 0, steps: 0, toolCalls: 0, toolErrors: 0, text: "" };
        let buf = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => {
          buf += d.toString("utf8");
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            onEvent?.(line);
            try {
              const e = JSON.parse(line) as { type?: string; message?: { content?: { type?: string; text?: string; is_error?: boolean }[] }; num_turns?: number; result?: string; total_cost_usd?: number; is_error?: boolean };
              for (const b of e.message?.content ?? []) {
                if (e.type === "assistant" && b.type === "tool_use") r.toolCalls++;
                if (e.type === "assistant" && b.type === "text" && b.text) r.text = (r.text + "\n" + b.text).slice(-2000);
                if (e.type === "user" && b.type === "tool_result" && b.is_error) r.toolErrors++;
              }
              if (e.type === "result") {
                r.steps = e.num_turns ?? r.steps;
                if (typeof e.total_cost_usd === "number") r.costUsd = e.total_cost_usd;
                if (e.is_error && !r.error) r.error = String(e.result ?? "error").slice(0, 300);
              }
            } catch {
              // not an event line
            }
          }
        });
        child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-2000)));
        const timer = setTimeout(() => {
          r.timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
        }, timeoutMs);
        let done = false;
        const finish = (code: number | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          r.exitCode = code;
          r.ms = Date.now() - t0;
          if (code !== 0 && !r.timedOut && !r.error) r.error = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300) || `exit ${code}`;
          resolve(r);
        };
        child.on("error", (e) => {
          r.error = e.message;
          finish(null);
        });
        child.on("close", finish);
      });
    },
  };
}

export interface InstalledAgent {
  name: "claude" | "codex" | "gemini" | "opencode" | "aider";
  installed: boolean;
  version?: string;
  /** Claude Code only (from `claude auth status`; credentials are never read). */
  loggedIn?: boolean;
  authMethod?: string;
  /** What Pit Crew can do with it. */
  roles: string[];
}

const run = (bin: string, args: string[]) => {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

/** Installed coding agents and how Pit Crew can use each. Reads versions and login state only. */
export function detectAgents(): InstalledAgent[] {
  const out: InstalledAgent[] = [];
  const version = (bin: string) => run(bin, ["--version"])?.split("\n")[0];
  const claude: InstalledAgent = { name: "claude", installed: false, roles: [] };
  claude.version = version("claude");
  if (claude.version) {
    claude.installed = true;
    try {
      const s = JSON.parse(run("claude", ["auth", "status", "--json"]) ?? "{}") as { loggedIn?: boolean; authMethod?: string };
      claude.loggedIn = Boolean(s.loggedIn);
      claude.authMethod = s.authMethod;
    } catch {
      claude.loggedIn = false;
    }
    claude.roles = ["front-end on local models (bin/claude-local)", ...(claude.loggedIn ? ["cloud helper for `solve --helper claude` (off unless asked)"] : [])];
  }
  out.push(claude);
  for (const [name, roles] of [
    ["opencode", ["front-end on local models (default)", "solve attempts"]],
    ["codex", ["front-end via /v1/responses (not verified on this machine)"]],
    ["gemini", ["not supported yet (needs a Gemini-API translating proxy)"]],
    ["aider", ["front-end via the OpenAI-compatible API (docs only)"]],
  ] as const) {
    const v = version(name);
    out.push({ name, installed: Boolean(v), version: v, roles: v ? [...roles] : [] });
  }
  return out;
}
