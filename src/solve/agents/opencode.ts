import { spawn } from "node:child_process";

/** A coding agent that works on a task inside a directory, headless, without asking. */
export interface Agent {
  name: string;
  run(opts: { dir: string; prompt: string; timeoutMs: number; onEvent?: (line: string) => void }): Promise<AgentRun>;
}

export interface AgentRun {
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  /** Last part of the agent's final text (kept local, in the solve report only). */
  text: string;
  error?: string;
  /** Cloud agents only: the cost the agent reports (API-equivalent). */
  costUsd?: number;
}

/**
 * OpenCode in headless mode (`opencode run --format json`), as the benchmark harness runs it:
 * edits and shell allowed inside the worktree, nothing outside it, no web fetches. stdin is
 * closed — `opencode run` otherwise waits for piped stdin to end.
 */
export function opencodeAgent(opts: { model: string; configPath: string; bin?: string }): Agent {
  return {
    name: `opencode:${opts.model}`,
    run({ dir, prompt, timeoutMs, onEvent }) {
      const t0 = Date.now();
      const env = {
        ...process.env,
        OPENCODE_CONFIG: opts.configPath,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: "allow", bash: "allow", webfetch: "deny", external_directory: "deny" } }),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      };
      return new Promise((resolve) => {
        const child = spawn(opts.bin ?? "opencode", ["run", "--pure", "--format", "json", "-m", opts.model, "--dir", dir, prompt], { env, stdio: ["ignore", "pipe", "pipe"] });
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
              const e = JSON.parse(line) as { type?: string; part?: { text?: string; state?: { status?: string } } };
              if (e.type === "step_finish") r.steps++;
              if (e.type === "tool_use") {
                r.toolCalls++;
                if (e.part?.state?.status === "error") r.toolErrors++;
              }
              if (e.type === "text" && e.part?.text) r.text = (r.text + "\n" + e.part.text).slice(-2000);
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
