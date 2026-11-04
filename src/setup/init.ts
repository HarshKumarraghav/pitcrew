import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import type { OllamaClient } from "../backend/ollama.ts";
import { DERIVED_NS } from "../models/registry.ts";
import type { MemoryProbe, MemorySnapshot } from "../system/memory.ts";
import { recommend, type Recommendation } from "./catalog.ts";

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

export interface Detected {
  platform: string;
  arch: string;
  node: string;
  memory: MemorySnapshot;
  ollama: { installed: boolean; cliVersion?: string; running: boolean; serverVersion?: string; url: string };
  opencode: { installed: boolean; version?: string };
  /** Local models (no cloud, no Pit Crew-derived variants). */
  pulled: { name: string; size: number }[];
  cloud: string[];
}

export interface InitDeps {
  probe: MemoryProbe;
  client: OllamaClient;
  /** Version string of a command-line tool, or undefined when it is not installed. */
  toolVersion: (cmd: string) => string | undefined;
}

export async function detect(deps: InitDeps): Promise<Detected> {
  const memory = await deps.probe.read();
  const cliVersion = deps.toolVersion("ollama");
  const opencodeVersion = deps.toolVersion("opencode");
  let serverVersion: string | undefined;
  let pulled: Detected["pulled"] = [];
  let cloud: string[] = [];
  try {
    serverVersion = (await deps.client.version()).version;
    const tags = await deps.client.tags();
    pulled = tags.filter((t) => !t.remote_host && !t.name.startsWith(DERIVED_NS) && !/[:-]cloud$/.test(t.name)).map((t) => ({ name: t.name, size: t.size }));
    cloud = tags.filter((t) => t.remote_host || /[:-]cloud$/.test(t.name)).map((t) => t.name);
  } catch {
    // not running
  }
  return {
    platform: platform(),
    arch: arch(),
    node: process.version,
    memory,
    ollama: { installed: cliVersion !== undefined || serverVersion !== undefined, cliVersion, running: serverVersion !== undefined, serverVersion, url: deps.client.url },
    opencode: { installed: opencodeVersion !== undefined, version: opencodeVersion },
    pulled,
    cloud,
  };
}

export interface FileAction {
  path: string;
  action: "create" | "overwrite" | "keep";
  content: string;
}

export interface InitPlan {
  detected: Detected;
  recommendation: Recommendation;
  pulls: string[];
  files: FileAction[];
  /** Things that stop part of the setup (e.g. pulls) until the user fixes them. */
  blockers: string[];
  next: string[];
}

export interface InitOptions {
  /** Where config.json and opencode.json go (default ~/.pitcrew). */
  dir: string;
  port?: number;
  coder?: string;
  light?: string;
  /** Overwrite existing files. */
  force?: boolean;
  /** Directory the user runs `serve` from (a ./pitcrew.config.json there wins). */
  cwd?: string;
}

export function buildConfig(rec: Recommendation, opts: { port: number; backendUrl: string }): Record<string, unknown> {
  const qwen = rec.coder.name.startsWith("qwen");
  return {
    listen: { host: "127.0.0.1", port: opts.port },
    backend: { url: opts.backendUrl, managed: false, parallel: "auto" },
    memory: { policy: "balanced", osReserveGiB: 4, minFreeGiB: 1, thrashSwapoutMiBps: 40 },
    context: { buckets: [8192, 16384, 32768, 65536] },
    router: { name: "auto", mode: "C", coder: "coder", light: "small" },
    models: {
      coder: {
        model: rec.coder.name,
        primary: true,
        parallel: 1,
        minCtx: rec.minCtx,
        maxCtx: rec.maxCtx,
        priority: "interactive",
        maxResidentGiB: rec.coderMaxResidentGiB,
        // Qwen's recommended sampling for coding with thinking on.
        ...(qwen ? { parameters: { temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 0 } } : {}),
      },
      small: { model: rec.light.name, maxCtx: rec.lightMaxCtx, priority: "interactive", warm: true, parallel: 2 },
    },
  };
}

/** OpenCode profile that talks only to the gateway (merged on top of the user's own config). */
export function buildOpenCodeProfile(rec: Recommendation, port: number): Record<string, unknown> {
  const limit = { context: rec.maxCtx, output: 8192 };
  return {
    $schema: "https://opencode.ai/config.json",
    model: "pitcrew/auto",
    small_model: "pitcrew/auto",
    enabled_providers: ["pitcrew"],
    share: "disabled",
    autoupdate: false,
    tools: { webfetch: false, skill: false, task: false },
    permission: { edit: "ask", bash: "ask", webfetch: "deny", external_directory: "ask" },
    provider: {
      pitcrew: {
        npm: "@ai-sdk/openai-compatible",
        name: "Pit Crew (local)",
        options: { baseURL: `http://127.0.0.1:${port}/v1` },
        models: {
          auto: { name: "Pit Crew auto (router: coder + light model)", tool_call: true, reasoning: true, limit },
          coder: { name: `Pit Crew coder (${rec.coder.name})`, tool_call: true, reasoning: true, limit },
        },
      },
    },
  };
}

export function plan(d: Detected, opts: InitOptions): InitPlan {
  const port = opts.port ?? 11500;
  const rec = recommend(d.memory, d.pulled, { coder: opts.coder, light: opts.light });
  const pulls = [rec.coder, rec.light].filter((p) => !p.pulled).map((p) => p.name);
  const file = (name: string, content: unknown): FileAction => {
    const path = join(opts.dir, name);
    const exists = existsSync(path);
    return { path, action: !exists ? "create" : opts.force ? "overwrite" : "keep", content: JSON.stringify(content, null, 2) + "\n" };
  };
  const configFile = file("config.json", buildConfig(rec, { port, backendUrl: d.ollama.url }));
  const profileFile = file("opencode.json", buildOpenCodeProfile(rec, port));

  const blockers: string[] = [];
  if (!d.ollama.installed) blockers.push("Ollama is not installed: https://ollama.com/download (macOS: brew install ollama)");
  else if (!d.ollama.running) blockers.push(`Ollama is installed but not running at ${d.ollama.url}: open the Ollama app or run \`ollama serve\``);
  if (d.platform !== "darwin" && d.platform !== "linux") blockers.push(`${d.platform} is not supported yet (macOS and Linux only)`);

  const next = ["npx pitcrew-ai serve                                   # gateway + dashboard on http://127.0.0.1:" + port];
  next.push(d.opencode.installed ? `OPENCODE_CONFIG=${profileFile.path} opencode` : "install OpenCode (https://opencode.ai, or: npm i -g opencode-ai), then:\n  OPENCODE_CONFIG=" + profileFile.path + " opencode");
  next.push("npx pitcrew-ai doctor                                  # checks every link in the chain");
  if (opts.cwd && existsSync(join(opts.cwd, "pitcrew.config.json"))) {
    rec.warnings.push(`./pitcrew.config.json in ${opts.cwd} takes precedence over ${configFile.path} when you run serve there`);
  }
  for (const f of [configFile, profileFile]) {
    if (f.action === "keep") rec.notes.push(`${f.path} exists and is kept (re-run with --force to replace it)`);
  }
  return { detected: d, recommendation: rec, pulls, files: [configFile, profileFile], blockers, next };
}

const pickLine = (role: string, p: Recommendation["coder"], extra: string) =>
  `  ${role.padEnd(7)} ${p.name.padEnd(14)} ${(p.bytes ? `${gb(p.bytes)} ${p.basis === "pulled" ? "on disk" : p.basis}` : "size unknown").padEnd(22)} ${p.pulled ? "already pulled ✓" : `not pulled → download`}${extra}`;

export function renderPlan(p: InitPlan): string {
  const d = p.detected;
  const m = d.memory;
  const r = p.recommendation;
  const out: string[] = [];
  out.push(`machine   ${d.platform}/${d.arch} · ${gb(m.totalBytes)} memory · available now ${gb(m.availableBytes)} · pressure ${m.pressure} · node ${d.node}`);
  out.push(`ollama    ${d.ollama.running ? `${d.ollama.serverVersion} running ✓` : d.ollama.installed ? "installed, not running ✗" : "not installed ✗"}      opencode ${d.opencode.installed ? `${d.opencode.version ?? ""} ✓` : "not installed"}`);
  out.push(`pulled    ${d.pulled.map((x) => x.name).join(", ") || "none"}`);
  if (d.cloud.length) out.push(`cloud     ${d.cloud.join(", ")} (Pit Crew never uses these)`);
  out.push("");
  out.push(`recommended for a ${r.tier} machine`);
  out.push(pickLine("coder", r.coder, ""));
  out.push(pickLine("light", r.light, ""));
  out.push(`  context ${r.minCtx === r.maxCtx ? `${r.maxCtx / 1024}k` : `${r.minCtx / 1024}k–${r.maxCtx / 1024}k`} for the coder · model budget ${gb(r.hardBudgetBytes)} · coder + light ≈ ${gb(r.needBytes)} (estimate)`);
  for (const w of r.warnings) out.push(`  ⚠ ${w}`);
  for (const n of r.notes) out.push(`  · ${n}`);
  out.push("");
  for (const b of p.blockers) out.push(`✗ ${b}`);
  if (p.blockers.length) out.push("");
  out.push("will do");
  let i = 1;
  for (const name of p.pulls) out.push(`  ${i++}. ollama pull ${name}${p.blockers.length ? "   (blocked until Ollama runs)" : ""}`);
  for (const f of p.files) out.push(`  ${i++}. ${f.action === "keep" ? "keep" : f.action === "overwrite" ? "overwrite" : "write"} ${f.path}${f.path.endsWith("opencode.json") ? "   (your own OpenCode config is untouched)" : ""}`);
  return out.join("\n");
}

export interface ApplyResult {
  pulled: string[];
  written: string[];
  skipped: string[];
}

export async function apply(p: InitPlan, client: OllamaClient, log: (line: string) => void): Promise<ApplyResult> {
  const result: ApplyResult = { pulled: [], written: [], skipped: [] };
  for (const name of p.pulls) {
    if (!p.detected.ollama.running) {
      result.skipped.push(`ollama pull ${name} (Ollama not running)`);
      continue;
    }
    log(`pulling ${name} …`);
    let shown = -1;
    await client.pull(name, (status, fraction) => {
      const pct = fraction === undefined ? -1 : Math.floor(fraction * 10) * 10;
      if (pct > shown) {
        shown = pct;
        log(`  ${name}: ${status} ${pct}%`);
      }
    });
    result.pulled.push(name);
  }
  for (const f of p.files) {
    if (f.action === "keep") {
      result.skipped.push(`${f.path} (exists)`);
      continue;
    }
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
    result.written.push(f.path);
  }
  return result;
}
