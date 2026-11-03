// S3 mixed load (M9.4): a real OpenCode agent task, voice round trips (TTS → STT) every 15 s, and a
// big "video" job (ballast stand-in) submitted 10 s in — once through Pit Crew, once with everything
// talking to Ollama / running directly. Measures what a user feels: does the Mac lag, does it swap,
// does the coder slow down, and when does the video run.
//
// usage: node --experimental-strip-types bench/load/s3.ts --mode governed|direct [--task F] [--repeat 1]
//          [--video-gb 6] [--video-s 30] [--config examples/pitcrew.multimodel.json]
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig, isJob } from "../../src/config.ts";
import { runJob, type JobSpec } from "../../src/backend/jobs.ts";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((x) => x.length));
const MODE = (args.mode ?? "governed") as "governed" | "direct";
const TASK = args.task ?? "F";
const REPEAT = Number(args.repeat ?? 1);
const VIDEO_GB = Number(args["video-gb"] ?? 6);
const VIDEO_S = Number(args["video-s"] ?? 30);
const CONFIG = args.config ?? "examples/pitcrew.multimodel.json";
const OLLAMA = "http://127.0.0.1:11434";
const GATEWAY = "http://127.0.0.1:11500";
const { config } = loadConfig(join(ROOT, CONFIG));
const job = (name: string) => {
  const s = config.models[name];
  if (!isJob(s)) throw new Error(`${CONFIG}: models.${name} must be a job`);
  return s;
};

async function sh(cmd: string, a: string[]) {
  try {
    return (await execFileP(cmd, a, { encoding: "utf8" })).stdout;
  } catch {
    return "";
  }
}
async function memSample() {
  const [vm, level] = await Promise.all([sh("vm_stat", []), sh("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])]);
  const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384);
  const pg = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
  return { t: Date.now(), availableGB: ((pg("Pages free") + pg("File-backed pages") + pg("Pages purgeable")) * page) / 1e9, swapouts: pg("Swapouts"), page, pressure: Number(level.trim()) };
}
function spawnLatencyMs(): Promise<number> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const p = spawn("/usr/bin/true", [], { stdio: "ignore" });
    p.on("exit", () => resolve(performance.now() - t0));
    p.on("error", () => resolve(Number.NaN));
  });
}
async function unloadAll() {
  try {
    const ps = ((await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models: { name: string }[] }).models;
    for (const m of ps) await fetch(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
  } catch {
    // backend down
  }
  await new Promise((r) => setTimeout(r, 3000));
}
const pct = (xs: number[], p: number) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]! * 10) / 10 : null;
};

/** One voice round trip: speak a sentence, then transcribe the audio back. */
async function voiceRoundTrip(): Promise<{ ttsMs: number; sttMs: number; ok: boolean; text?: string; error?: string }> {
  const sentence = "The build finished and two tests failed in the task store.";
  const t0 = Date.now();
  try {
    let wav: Buffer;
    if (MODE === "governed") {
      const r = await fetch(`${GATEWAY}/v1/audio/speech`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "tts", input: sentence }) });
      if (!r.ok) throw new Error(`tts ${r.status} ${(await r.text()).slice(0, 160)}`);
      wav = Buffer.from(await r.arrayBuffer());
    } else {
      wav = (await runJob(job("tts"), { input: sentence, voice: "af_heart" })).data;
    }
    const t1 = Date.now();
    let text: string;
    if (MODE === "governed") {
      const fd = new FormData();
      fd.set("model", "stt");
      fd.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
      const r = await fetch(`${GATEWAY}/v1/audio/transcriptions`, { method: "POST", body: fd });
      if (!r.ok) throw new Error(`stt ${r.status} ${(await r.text()).slice(0, 160)}`);
      text = ((await r.json()) as { text: string }).text;
    } else {
      const dir = `/tmp/pitcrew-s3-${process.pid}`;
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "speech.wav");
      writeFileSync(file, wav);
      text = (await runJob(job("stt"), { file })).data.toString("utf8").trim();
    }
    return { ttsMs: t1 - t0, sttMs: Date.now() - t1, ok: /tests? failed/i.test(text), text: text.slice(0, 120) };
  } catch (e) {
    return { ttsMs: Date.now() - t0, sttMs: 0, ok: false, error: String(e).slice(0, 200) };
  }
}

async function video(): Promise<{ submittedAt: number; startedAt?: number; endedAt: number; ok: boolean; error?: string }> {
  const submittedAt = Date.now();
  try {
    if (MODE === "governed") {
      const r = await fetch(`${GATEWAY}/v1/videos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "video", prompt: "a red car on a coastal road", seconds: VIDEO_S }), signal: AbortSignal.timeout(30 * 60_000) });
      const ms = Number(r.headers.get("x-pitcrew-ms") ?? NaN);
      await r.arrayBuffer();
      const endedAt = Date.now();
      return { submittedAt, startedAt: Number.isFinite(ms) ? endedAt - ms : undefined, endedAt, ok: r.ok };
    }
    const spec: JobSpec = { ...job("video"), command: ["node", join(ROOT, "bench/tools/ballast.mjs"), "--gb", String(VIDEO_GB), "--seconds", String(VIDEO_S), "--out", "{out}"] };
    await runJob(spec, {});
    return { submittedAt, startedAt: submittedAt, endedAt: Date.now(), ok: true };
  } catch (e) {
    return { submittedAt, endedAt: Date.now(), ok: false, error: String(e).slice(0, 200) };
  }
}

async function main() {
  await unloadAll();
  let gw: ChildProcess | undefined;
  let gwLog = "";
  if (MODE === "governed") {
    // The ballast size/time comes from the CLI so both modes run the same job.
    const cfgPath = `/tmp/pitcrew-s3-config-${process.pid}.json`;
    const raw = JSON.parse(readFileSync(join(ROOT, CONFIG), "utf8"));
    raw.models.video.command = ["node", "{pitcrew_root}/bench/tools/ballast.mjs", "--gb", String(VIDEO_GB), "--seconds", "{seconds}", "--out", "{out}"];
    raw.models.video.memoryGiB = VIDEO_GB;
    writeFileSync(cfgPath, JSON.stringify(raw));
    gw = spawn("node", ["--experimental-strip-types", "--no-warnings", "src/cli.ts", "serve", "--config", cfgPath], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PITCREW_LOG: "normal" } });
    gw.stdout?.on("data", (d) => (gwLog += d));
    gw.stderr?.on("data", (d) => (gwLog += d));
    for (let i = 0; i < 40; i++) {
      if (await fetch(`${GATEWAY}/healthz`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const samples: Awaited<ReturnType<typeof memSample>>[] = [];
  const lag: number[] = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const tick = Date.now();
      const [s, l] = await Promise.all([memSample(), spawnLatencyMs()]);
      samples.push(s);
      lag.push(l);
      await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - tick))));
    }
  })();

  const label = `s3-${MODE}-${TASK}`;
  const t0 = Date.now();
  const agent = spawn("node", ["bench/agent/run.mjs", "--model", MODE === "governed" ? "pitcrew/auto" : "local/coder", "--label", label, "--repeat", String(REPEAT), "--tests", TASK, "--timeout", "900"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, PITCREW_OPENCODE_PROFILE: join(ROOT, "examples", "opencode", MODE === "governed" ? "opencode.pitcrew.json" : "opencode.baseline.json") },
  });
  let agentOut = "";
  agent.stdout?.on("data", (d) => (agentOut += d));
  const agentDone = new Promise<number>((r) => agent.on("close", () => r(Date.now())));
  let agentEnded = 0;
  void agentDone.then((t) => (agentEnded = t));

  const voice: Awaited<ReturnType<typeof voiceRoundTrip>>[] = [];
  const voiceLoop = (async () => {
    await new Promise((r) => setTimeout(r, 5000));
    while (!agentEnded) {
      const t = Date.now();
      voice.push(await voiceRoundTrip());
      await new Promise((r) => setTimeout(r, Math.max(0, 15_000 - (Date.now() - t))));
    }
  })();
  const vid = (async () => {
    await new Promise((r) => setTimeout(r, 10_000));
    return video();
  })();

  const [agentEnd, v] = await Promise.all([agentDone, vid, voiceLoop]).then(([a, b]) => [a, b] as const);
  polling = false;
  await poller;
  let gwState: unknown;
  if (gw) {
    gwState = await fetch(`${GATEWAY}/governor/state`).then((r) => r.json(), () => undefined);
    gw.kill("SIGTERM");
    await new Promise((r) => gw!.once("exit", r));
  }
  await unloadAll();

  const resultDir = join(ROOT, "bench", "agent", "results", `${label}-r${REPEAT}`);
  let agentResult: { success?: boolean; wallS?: number } = {};
  try {
    agentResult = JSON.parse(readFileSync(join(resultDir, `${TASK}.json`), "utf8"));
  } catch {
    // older harness layout
  }
  let peakSwapoutMBps = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const dt = (b.t - a.t) / 1000;
    if (dt > 0.2) peakSwapoutMBps = Math.max(peakSwapoutMBps, (Math.max(0, b.swapouts - a.swapouts) * b.page) / 1e6 / dt);
  }
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const report = {
    mode: MODE,
    task: TASK,
    repeat: REPEAT,
    agent: { success: agentResult.success, wallS: agentResult.wallS ?? (agentEnd - t0) / 1000, endedAtS: (agentEnd - t0) / 1000 },
    video: { ...v, submittedAtS: (v.submittedAt - t0) / 1000, startedAtS: v.startedAt ? (v.startedAt - t0) / 1000 : null, endedAtS: (v.endedAt - t0) / 1000, startedAfterAgentEnd: v.startedAt ? v.startedAt >= agentEnd - 1000 : null },
    voice: { n: voice.length, ok: voice.filter((x) => x.ok).length, ttsP50ms: pct(voice.map((x) => x.ttsMs), 0.5), sttP50ms: pct(voice.map((x) => x.sttMs), 0.5), roundTripP95ms: pct(voice.map((x) => x.ttsMs + x.sttMs), 0.95), errors: voice.filter((x) => x.error).map((x) => x.error) },
    memory: {
      minAvailableGB: +Math.min(...samples.map((s) => s.availableGB)).toFixed(2),
      swappedOutGB: +(((last.swapouts - first.swapouts) * last.page) / 1e9).toFixed(2),
      peakSwapoutMBps: +peakSwapoutMBps.toFixed(1),
      secondsCritical: samples.filter((s) => s.pressure >= 4).length,
      secondsWarnOrWorse: samples.filter((s) => s.pressure >= 2).length,
    },
    responsiveness: { spawnP50ms: pct(lag, 0.5), spawnP95ms: pct(lag, 0.95), spawnMaxms: pct(lag, 1), n: lag.length },
    gateway: gwState ? { stats: (gwState as { scheduler: { stats: unknown } }).scheduler.stats, jobCalibration: (gwState as { jobCalibration: unknown }).jobCalibration } : undefined,
    agentLog: agentOut.trim().split("\n").slice(-3),
  };
  const out = join(ROOT, "bench", "results", "s3");
  mkdirSync(out, { recursive: true });
  const file = join(out, `${MODE}-${TASK}-${new Date().toISOString().replace(/[:.]/g, "-")}-r${REPEAT}.json`);
  writeFileSync(file, JSON.stringify({ ...report, voiceRuns: voice, lag, samples }, null, 2));
  if (gw) writeFileSync(`/tmp/s3-gw-${MODE}-r${REPEAT}.log`, gwLog);
  console.log(JSON.stringify(report, null, 1));
  console.log(`→ ${file}`);
  process.exit(0);
}
void main();
