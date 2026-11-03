// Multi-model load benchmark: the same concurrent workload sent (a) straight to Ollama and
// (b) through the Pit Crew gateway. Measures latency, failures, truncation, model loads, swap.
//
// usage: node --experimental-strip-types bench/load/run.ts --mode direct-default|direct-tuned|governed [--rounds 3]
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((x) => x.length));
const MODE = (args.mode ?? "governed") as "direct-default" | "direct-tuned" | "governed";
const ROUNDS = Number(args.rounds ?? 3);
const OLLAMA = "http://127.0.0.1:11434";
const GATEWAY = "http://127.0.0.1:11500";

// The real request OpenCode sent for "List the files in src." (captured, local profile): 5,858 tokens.
const AGENT = JSON.parse(readFileSync(join(HERE, "opencode-request.json"), "utf8")) as { messages: unknown[]; tools: unknown[] };
const AGENT_TOKENS = 5858;

type Cls = "agent" | "chat" | "title";
interface Client { cls: Cls; model: Record<typeof MODE, string>; body: () => Record<string, unknown>; minPromptTokens: number }

const MODELS = {
  coder: { "direct-default": "qwen3.5:9b", "direct-tuned": "pitcrew/qwen3.5-9b:32k", governed: "coder" },
  mid: { "direct-default": "qwen3.5:2b", "direct-tuned": "qwen3.5:2b", governed: "mid" },
  small: { "direct-default": "qwen3.5:0.8b", "direct-tuned": "qwen3.5:0.8b", governed: "small" },
} as const;

const QUESTIONS = [
  "Explain the difference between a mutex and a semaphore in two sentences.",
  "Write a TypeScript function that debounces another function.",
  "What does HTTP status 409 mean and when should an API return it?",
  "Give three tips for writing reliable unit tests.",
];
const TITLES = ["fix login redirect bug", "add pagination to task list", "rename getAllTasks to listTasks", "debug failing slugify test"];

const clients: Client[] = [
  ...[0, 1].map(() => ({ cls: "agent" as Cls, model: MODELS.coder, minPromptTokens: AGENT_TOKENS * 0.9, body: () => ({ messages: AGENT.messages, tools: AGENT.tools, max_tokens: 256 }) })),
  ...[0, 1].map((c) => ({ cls: "chat" as Cls, model: MODELS.mid, minPromptTokens: 0, body: () => ({ messages: [{ role: "user", content: QUESTIONS[(c + Math.floor(Math.random() * 4)) % 4] }], max_tokens: 160, reasoning_effort: "none" }) })),
  ...[0, 1].map((c) => ({ cls: "title" as Cls, model: MODELS.small, minPromptTokens: 0, body: () => ({ messages: [{ role: "system", content: "Generate a 3-6 word title. Output only the title." }, { role: "user", content: TITLES[(c + Math.floor(Math.random() * 4)) % 4] }], max_tokens: 32, reasoning_effort: "none" }) })),
];

function sh(cmd: string, a: string[]): string {
  try {
    return execFileSync(cmd, a, { encoding: "utf8" });
  } catch {
    return "";
  }
}
function memSample() {
  const vm = sh("vm_stat", []);
  const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384);
  const pg = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
  const swap = sh("sysctl", ["-n", "vm.swapusage"]);
  return {
    t: Date.now(),
    availableGB: ((pg("Pages free") + pg("File-backed pages") + pg("Pages purgeable")) * page) / 1e9,
    swapouts: pg("Swapouts"),
    page,
    swapUsedMB: Number(/used = ([\d.]+)M/.exec(swap)?.[1] ?? 0),
    pressure: Number(sh("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).trim()),
  };
}
async function ps(): Promise<{ name: string; size: number }[]> {
  try {
    return ((await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models: { name: string; size: number }[] }).models;
  } catch {
    return [];
  }
}
async function unloadAll() {
  for (const m of await ps()) await fetch(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
  await new Promise((r) => setTimeout(r, 3000));
}

interface Result { cls: Cls; ok: boolean; status: number; ms: number; ttftMs?: number; promptTokens?: number; truncated: boolean; error?: string; queuedMs?: number }

async function one(c: Client, base: string): Promise<Result> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: c.model[MODE], stream: true, stream_options: { include_usage: true }, ...c.body() }),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    let ttft: number | undefined;
    let text = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      ttft ??= Date.now() - t0;
      text = (text + Buffer.from(chunk).toString()).slice(-20000);
    }
    const usage = /"prompt_tokens":(\d+)/.exec(text);
    const promptTokens = usage ? Number(usage[1]) : undefined;
    const truncated = promptTokens !== undefined && promptTokens < c.minPromptTokens;
    return { cls: c.cls, ok: res.ok && !truncated, status: res.status, ms: Date.now() - t0, ttftMs: ttft, promptTokens, truncated, queuedMs: Number(res.headers.get("x-pitcrew-queued-ms") ?? NaN) || undefined, error: res.ok ? undefined : text.slice(0, 200) };
  } catch (e) {
    return { cls: c.cls, ok: false, status: 0, ms: Date.now() - t0, truncated: false, error: String(e).slice(0, 200) };
  }
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};

async function main() {
  await unloadAll();
  let gw: ChildProcess | undefined;
  if (MODE === "governed") {
    gw = spawn("node", ["--experimental-strip-types", "--no-warnings", "src/cli.ts", "serve", "--config", "examples/pitcrew.config.json"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PITCREW_LOG: "normal" } });
    let log = "";
    gw.stdout?.on("data", (d) => (log += d));
    process.on("exit", () => writeFileSync(`/tmp/load-gw-${MODE}.log`, log));
    for (let i = 0; i < 40; i++) {
      if (await fetch(`${GATEWAY}/healthz`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const base = MODE === "governed" ? GATEWAY : OLLAMA;
  const start = memSample();
  const samples = [start];
  const loadsSeen = new Map<string, number>();
  let prevResident = new Set<string>();
  let peakResidentGB = 0;
  const poll = setInterval(async () => {
    samples.push(memSample());
    const r = await ps();
    peakResidentGB = Math.max(peakResidentGB, r.reduce((a, m) => a + m.size, 0) / 1e9);
    const now = new Set(r.map((m) => m.name));
    for (const n of now) if (!prevResident.has(n)) loadsSeen.set(n, (loadsSeen.get(n) ?? 0) + 1);
    prevResident = now;
  }, 1000);

  const t0 = Date.now();
  const results: Result[] = [];
  await Promise.all(clients.map(async (c) => {
    for (let i = 0; i < ROUNDS; i++) results.push(await one(c, base));
  }));
  const wallS = (Date.now() - t0) / 1000;
  clearInterval(poll);
  const end = memSample();
  samples.push(end);
  let gwStats: unknown;
  if (gw) {
    gwStats = await fetch(`${GATEWAY}/governor/state`).then((r) => r.json(), () => undefined);
    gw.kill("SIGTERM");
  }
  await unloadAll();

  const byCls = Object.fromEntries((["agent", "chat", "title"] as Cls[]).map((cls) => {
    const rs = results.filter((r) => r.cls === cls);
    const ok = rs.filter((r) => r.ok);
    return [cls, {
      n: rs.length,
      ok: ok.length,
      truncated: rs.filter((r) => r.truncated).length,
      errors: rs.filter((r) => !r.ok && !r.truncated).map((r) => `${r.status} ${r.error ?? ""}`.slice(0, 120)),
      p50s: pct(ok.map((r) => r.ms / 1000), 0.5),
      p95s: pct(ok.map((r) => r.ms / 1000), 0.95),
      ttftP50s: pct(ok.flatMap((r) => (r.ttftMs ? [r.ttftMs / 1000] : [])), 0.5),
      promptTokens: [...new Set(rs.map((r) => r.promptTokens))],
    }];
  }));
  const swapoutGB = ((end.swapouts - start.swapouts) * end.page) / 1e9;
  const report = {
    mode: MODE,
    rounds: ROUNDS,
    clients: clients.length,
    requests: results.length,
    wallS,
    success: results.filter((r) => r.ok).length,
    byCls,
    modelLoads: Object.fromEntries(loadsSeen),
    totalLoads: [...loadsSeen.values()].reduce((a, b) => a + b, 0),
    peakResidentGB: Math.round(peakResidentGB * 100) / 100,
    memory: {
      startAvailableGB: +start.availableGB.toFixed(2),
      minAvailableGB: +Math.min(...samples.map((s) => s.availableGB)).toFixed(2),
      swappedOutGB: +swapoutGB.toFixed(2),
      swapUsedStartMB: start.swapUsedMB,
      swapUsedEndMB: end.swapUsedMB,
      secondsAtWarnOrWorse: samples.filter((s) => s.pressure >= 2).length,
      secondsCritical: samples.filter((s) => s.pressure >= 4).length,
      samples: samples.length,
    },
    gateway: gwStats ? { stats: (gwStats as { scheduler: { stats: unknown } }).scheduler.stats } : undefined,
  };
  const out = join(ROOT, "bench", "results", "load");
  mkdirSync(out, { recursive: true });
  const file = join(out, `${MODE}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ ...report, results }, null, 2));
  console.log(JSON.stringify(report, null, 1));
  console.log(`→ ${file}`);
  process.exit(0);
}
void main();
