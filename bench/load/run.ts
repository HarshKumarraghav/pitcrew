// Multi-model load benchmark: the same concurrent workload sent (a) straight to Ollama and
// (b) through the Pit Crew gateway. Measures latency, failures, truncation, model loads, swap,
// and how responsive the rest of the Mac stays.
//
// usage: node --experimental-strip-types bench/load/run.ts \
//          --mode direct-default,direct-tuned,governed [--repeats 3] [--rounds 3]
// Several modes are run interleaved (A B C A B C …) so slow drift in the machine's state does not
// favour one of them. Each run writes its own JSON; a summary with median and range is written last.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((x) => x.length));
type Mode = "direct-default" | "direct-tuned" | "governed";
const MODES = String(args.mode ?? "governed").split(",") as Mode[];
const REPEATS = Number(args.repeats ?? 1);
const ROUNDS = Number(args.rounds ?? 3);
const CONFIG = args.config ?? "examples/pitcrew.config.json";
const OLLAMA = "http://127.0.0.1:11434";
const GATEWAY = "http://127.0.0.1:11500";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

// The real request OpenCode sent for "List the files in src." (captured, local profile): 5,858 tokens.
const AGENT = JSON.parse(readFileSync(join(HERE, "opencode-request.json"), "utf8")) as { messages: unknown[]; tools: unknown[] };
const AGENT_TOKENS = 5858;

type Cls = "agent" | "chat" | "title";
interface Client { cls: Cls; model: Record<Mode, string>; body: () => Record<string, unknown>; minPromptTokens: number }

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

async function sh(cmd: string, a: string[]): Promise<string> {
  try {
    return (await execFileP(cmd, a, { encoding: "utf8" })).stdout;
  } catch {
    return "";
  }
}
interface MemSample { t: number; availableGB: number; swapouts: number; page: number; swapUsedMB: number; pressure: number }
async function memSample(): Promise<MemSample> {
  const [vm, swap, level] = await Promise.all([sh("vm_stat", []), sh("sysctl", ["-n", "vm.swapusage"]), sh("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])]);
  const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384);
  const pg = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
  return {
    t: Date.now(),
    availableGB: ((pg("Pages free") + pg("File-backed pages") + pg("Pages purgeable")) * page) / 1e9,
    swapouts: pg("Swapouts"),
    page,
    swapUsedMB: Number(/used = ([\d.]+)M/.exec(swap)?.[1] ?? 0),
    pressure: Number(level.trim()),
  };
}

/** "Does my Mac lag": how long it takes to start and finish a trivial process. */
function spawnLatencyMs(): Promise<number> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const p = spawn("/usr/bin/true", [], { stdio: "ignore" });
    p.on("exit", () => resolve(performance.now() - t0));
    p.on("error", () => resolve(Number.NaN));
  });
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

async function one(c: Client, mode: Mode, base: string): Promise<Result> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: c.model[mode], stream: true, stream_options: { include_usage: true }, ...c.body() }),
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
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);

async function runOnce(mode: Mode, rep: number) {
  await unloadAll();
  let gw: ChildProcess | undefined;
  let log = "";
  if (mode === "governed") {
    gw = spawn("node", ["--experimental-strip-types", "--no-warnings", "src/cli.ts", "serve", "--config", CONFIG], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PITCREW_LOG: "normal" } });
    gw.stdout?.on("data", (d) => (log += d));
    gw.stderr?.on("data", (d) => (log += d));
    for (let i = 0; i < 40; i++) {
      if (await fetch(`${GATEWAY}/healthz`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const base = mode === "governed" ? GATEWAY : OLLAMA;
  const start = await memSample();
  const samples: MemSample[] = [start];
  const spawnMs: number[] = [];
  const loadsSeen = new Map<string, number>();
  let prevResident = new Set<string>();
  let peakResidentGB = 0;
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const tick = Date.now();
      const [s, r, lag] = await Promise.all([memSample(), ps(), spawnLatencyMs()]);
      samples.push(s);
      spawnMs.push(lag);
      peakResidentGB = Math.max(peakResidentGB, r.reduce((a, m) => a + m.size, 0) / 1e9);
      const now = new Set(r.map((m) => m.name));
      for (const n of now) if (!prevResident.has(n)) loadsSeen.set(n, (loadsSeen.get(n) ?? 0) + 1);
      prevResident = now;
      await new Promise((res) => setTimeout(res, Math.max(0, 1000 - (Date.now() - tick))));
    }
  })();

  const t0 = Date.now();
  const results: Result[] = [];
  await Promise.all(clients.map(async (c) => {
    for (let i = 0; i < ROUNDS; i++) results.push(await one(c, mode, base));
  }));
  const wallS = (Date.now() - t0) / 1000;
  polling = false;
  await poller;
  const end = await memSample();
  samples.push(end);
  let gwStats: unknown;
  if (gw) {
    gwStats = await fetch(`${GATEWAY}/governor/state`).then((r) => r.json(), () => undefined);
    gw.kill("SIGTERM");
    await new Promise((r) => gw!.once("exit", r));
    writeFileSync(`/tmp/load-gw-${mode}-r${rep}.log`, log);
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
  // Peak swap-out rate between consecutive ~1 s samples.
  let peakSwapoutMBps = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const dt = (b.t - a.t) / 1000;
    if (dt > 0.2) peakSwapoutMBps = Math.max(peakSwapoutMBps, (Math.max(0, b.swapouts - a.swapouts) * b.page) / 1e6 / dt);
  }
  const swapoutGB = ((end.swapouts - start.swapouts) * end.page) / 1e9;
  const gwState = gwStats as { scheduler?: { stats: unknown }; backendParallel?: unknown } | undefined;
  const report = {
    mode,
    repeat: rep,
    rounds: ROUNDS,
    clients: clients.length,
    requests: results.length,
    wallS,
    success: results.filter((r) => r.ok).length,
    byCls,
    modelLoads: Object.fromEntries(loadsSeen),
    totalLoads: [...loadsSeen.values()].reduce((a, b) => a + b, 0),
    peakResidentGB: r2(peakResidentGB),
    memory: {
      startAvailableGB: +start.availableGB.toFixed(2),
      minAvailableGB: +Math.min(...samples.map((s) => s.availableGB)).toFixed(2),
      swappedOutGB: +swapoutGB.toFixed(2),
      peakSwapoutMBps: +peakSwapoutMBps.toFixed(1),
      swapUsedStartMB: start.swapUsedMB,
      swapUsedEndMB: end.swapUsedMB,
      secondsAtWarnOrWorse: samples.filter((s) => s.pressure >= 2).length,
      secondsCritical: samples.filter((s) => s.pressure >= 4).length,
      samples: samples.length,
    },
    responsiveness: { spawnP50ms: r2(pct(spawnMs, 0.5)), spawnP95ms: r2(pct(spawnMs, 0.95)), spawnMaxms: r2(pct(spawnMs, 1)), n: spawnMs.length },
    gateway: gwState ? { stats: gwState.scheduler?.stats, backendParallel: gwState.backendParallel } : undefined,
  };
  const out = join(ROOT, "bench", "results", "load");
  mkdirSync(out, { recursive: true });
  const file = join(out, `${mode}-${STAMP}-r${rep}.json`);
  writeFileSync(file, JSON.stringify({ ...report, results, spawnMs }, null, 2));
  console.log(`${mode} r${rep}: wall ${wallS.toFixed(1)} s · title p50 ${byCls.title?.p50s} s · agent p95 ${byCls.agent?.p95s} s · swapped ${swapoutGB.toFixed(2)} GB · spawn p95 ${report.responsiveness.spawnP95ms} ms → ${file}`);
  return report;
}

type Report = Awaited<ReturnType<typeof runOnce>>;
const METRICS: [string, (r: Report) => number | null][] = [
  ["wallS", (r) => r.wallS],
  ["titleP50s", (r) => r.byCls.title?.p50s ?? null],
  ["agentP95s", (r) => r.byCls.agent?.p95s ?? null],
  ["chatP95s", (r) => r.byCls.chat?.p95s ?? null],
  ["swappedOutGB", (r) => r.memory.swappedOutGB],
  ["peakSwapoutMBps", (r) => r.memory.peakSwapoutMBps],
  ["secondsCritical", (r) => r.memory.secondsCritical],
  ["spawnP95ms", (r) => r.responsiveness.spawnP95ms],
  ["success", (r) => r.success],
];

function summarize(reports: Report[]) {
  const byMode: Record<string, Record<string, { median: number | null; min: number | null; max: number | null; values: (number | null)[] }>> = {};
  for (const mode of MODES) {
    const rs = reports.filter((r) => r.mode === mode);
    byMode[mode] = Object.fromEntries(METRICS.map(([k, f]) => {
      const vs = rs.map(f);
      const ok = vs.filter((v): v is number => v !== null);
      return [k, { median: r2(pct(ok, 0.5) === null ? null : median(ok)), min: ok.length ? Math.min(...ok) : null, max: ok.length ? Math.max(...ok) : null, values: vs }];
    }));
  }
  // Targets from docs/PLAN.md M10, judged on medians against direct-tuned (direct, 32k window).
  let targets: Record<string, { pass: boolean; detail: string }> | undefined;
  const g = byMode.governed;
  const d = byMode["direct-tuned"];
  if (g && d) {
    const m = (x: { median: number | null } | undefined) => x?.median ?? Number.NaN;
    targets = {
      "total time within +10%": { pass: m(g.wallS) <= m(d.wallS) * 1.1, detail: `${m(g.wallS)} vs ${m(d.wallS)} s` },
      "title p50 ≤ 1 s": { pass: m(g.titleP50s) <= 1, detail: `${m(g.titleP50s)} s` },
      "agent p95 better": { pass: m(g.agentP95s) < m(d.agentP95s), detail: `${m(g.agentP95s)} vs ${m(d.agentP95s)} s` },
      "swap-out ≤ direct": { pass: m(g.swappedOutGB) <= m(d.swappedOutGB), detail: `${m(g.swappedOutGB)} vs ${m(d.swappedOutGB)} GB` },
      "0 s at critical": { pass: (g.secondsCritical?.max ?? 1) === 0, detail: `max ${g.secondsCritical?.max} s` },
      "responsiveness p95 better": { pass: m(g.spawnP95ms) < m(d.spawnP95ms), detail: `${m(g.spawnP95ms)} vs ${m(d.spawnP95ms)} ms` },
    };
  }
  return { modes: MODES, repeats: REPEATS, rounds: ROUNDS, byMode, targets };
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function main() {
  const reports: Report[] = [];
  for (let rep = 1; rep <= REPEATS; rep++) for (const mode of MODES) reports.push(await runOnce(mode, rep));
  const summary = summarize(reports);
  const file = join(ROOT, "bench", "results", "load", `summary-${STAMP}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log("\nmetric".padEnd(18) + MODES.map((m) => m.padEnd(26)).join(""));
  for (const [k] of METRICS) {
    console.log(k.padEnd(17) + MODES.map((m) => {
      const v = summary.byMode[m]?.[k];
      return `${v?.median} [${v?.min}–${v?.max}]`.padEnd(26);
    }).join(""));
  }
  if (summary.targets) {
    console.log("\ntargets (governed vs direct-tuned, medians):");
    for (const [k, v] of Object.entries(summary.targets)) console.log(`  ${v.pass ? "✅" : "❌ MISSED"} ${k}: ${v.detail}`);
  }
  console.log(`→ ${file}`);
  process.exit(0);
}
void main();
