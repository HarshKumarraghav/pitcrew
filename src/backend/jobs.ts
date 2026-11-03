import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Priority } from "../config.ts";

export type JobEndpoint = "images" | "speech" | "transcriptions" | "video";

export interface JobSpec {
  kind: "job";
  endpoint: JobEndpoint;
  /** argv; `{name}` placeholders are filled from the request. No shell is involved. */
  command: string[];
  /** Peak memory estimate in GiB until measured. */
  memoryGiB: number;
  /** Default: background; video jobs default to deferrable. */
  priority?: Priority;
  timeoutMs?: number;
  /** File extension the command writes to `{out}` (png, wav, txt…). */
  outputExt: string;
  /** Defaults for placeholders not supplied by the request. */
  defaults?: Record<string, string | number>;
  env?: Record<string, string>;
}

export interface JobResult {
  data: Buffer;
  ext: string;
  ms: number;
  peakRssBytes: number;
  stderrTail: string;
}

const PLACEHOLDER = /\{([a-zA-Z_]+)\}/g;

/** Fill `{name}` placeholders. Each argv element stays one argument, so input cannot inject flags or commands. */
export function renderArgv(command: string[], vars: Record<string, string | number | undefined>): string[] {
  return command.map((part) =>
    part.replace(PLACEHOLDER, (_, k: string) => {
      const v = vars[k];
      if (v === undefined) throw new Error(`missing value for {${k}}`);
      return String(v);
    }),
  );
}

/** Sum RSS over a process group (the job and any children it spawns). */
function groupRss(pgid: number): Promise<number> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pgid=,rss="], { timeout: 3000 }, (_e, out) => {
      let kb = 0;
      for (const line of String(out ?? "").split("\n")) {
        const [g, r] = line.trim().split(/\s+/);
        if (Number(g) === pgid) kb += Number(r) || 0;
      }
      resolve(kb * 1024);
    });
  });
}

export async function runJob(
  spec: JobSpec,
  vars: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<JobResult> {
  const dir = await mkdtemp(join(tmpdir(), "pitcrew-job-"));
  const out = join(dir, `out.${spec.outputExt}`);
  const argv = renderArgv(spec.command, { ...spec.defaults, ...vars, out, dir });
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("job command is empty");
  const t0 = Date.now();
  let peak = 0;
  let stderr = "";
  try {
    const child = spawn(cmd, args, {
      cwd: dir,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group → we can measure and kill the whole tree
    });
    const pgid = child.pid ?? 0;
    const sampler = setInterval(() => {
      void groupRss(pgid).then((b) => (peak = Math.max(peak, b)));
    }, 500);
    let stdout = "";
    child.stdout?.on("data", (d) => (stdout = (stdout + d).slice(-1_000_000)));
    child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    const kill = () => {
      try {
        process.kill(-pgid, "SIGTERM");
      } catch {
        // already gone
      }
    };
    signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, spec.timeoutMs ?? 10 * 60_000);
    const code: number | null = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    clearInterval(sampler);
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
    if (signal?.aborted) throw new Error("client aborted");
    if (code !== 0) throw new Error(`job exited with ${code}: ${stderr.slice(-600)}`);

    let data: Buffer;
    try {
      data = await readFile(out);
    } catch {
      // Some CLIs pick their own file name; take the newest matching file in the job dir.
      const files = (await readdir(dir)).filter((f) => f.endsWith(`.${spec.outputExt}`));
      const f = files.sort().pop();
      if (f) data = await readFile(join(dir, f));
      else if (spec.outputExt === "txt" && stdout.trim()) data = Buffer.from(stdout.trim());
      else throw new Error(`job produced no .${spec.outputExt} output: ${stderr.slice(-400)}`);
    }
    return { data, ext: spec.outputExt, ms: Date.now() - t0, peakRssBytes: peak, stderrTail: stderr.slice(-400) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
