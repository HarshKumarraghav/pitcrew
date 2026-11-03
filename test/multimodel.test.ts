import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DEFAULTS, type Config } from "../src/config.ts";
import { createGateway } from "../src/server/http.ts";
import { parseMultipart, boundaryOf } from "../src/server/multipart.ts";
import { MemoryMonitor, type MemorySnapshot } from "../src/system/memory.ts";
import { Scheduler, type AcquireRequest } from "../src/scheduler/scheduler.ts";
import { startMockOllama } from "./mock-ollama.ts";

const G = 1024 ** 3;

function form(boundary: string, fields: Record<string, string>, file: { name: string; data: Buffer }) {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: audio/wav\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

test("multipart: fields and a binary file part survive intact", () => {
  const bin = Buffer.from([0, 1, 2, 13, 10, 45, 45, 255]);
  const parts = parseMultipart(form("XyZ", { model: "stt", language: "en" }, { name: "a.wav", data: bin }), "XyZ");
  assert.deepEqual(parts.map((p) => p.name), ["model", "language", "file"]);
  assert.equal(parts[2]!.filename, "a.wav");
  assert.deepEqual([...parts[2]!.data], [...bin]);
  assert.equal(boundaryOf('multipart/form-data; boundary="abc"'), "abc");
});

test("gateway: transcription upload reaches the command; video job runs; peaks persist", async () => {
  const mock = await startMockOllama([{ name: "qwen3.5:9b", size: 6.6 * G }]);
  const stateDir = mkdtempSync(join(tmpdir(), "pitcrew-mm-"));
  const cfg: Config = {
    ...DEFAULTS,
    backend: { ...DEFAULTS.backend, url: mock.url },
    scheduler: { ...DEFAULTS.scheduler, idleUnloadMs: 0 },
    models: {
      stt: { kind: "job", endpoint: "transcriptions", command: ["node", "-e", "process.stdout.write('heard:' + require('fs').readFileSync(process.argv[1]).toString())", "{file}"], memoryGiB: 0.2, outputExt: "txt" },
      video: { kind: "job", endpoint: "video", command: ["node", new URL("../bench/tools/ballast.mjs", import.meta.url).pathname, "--gb", "0.1", "--seconds", "1.2", "--ramp", "0", "--out", "{out}"], memoryGiB: 0.1, outputExt: "mp4" },
    },
    stateDir,
  };
  const probe = { read: async (): Promise<MemorySnapshot> => ({ t: Date.now(), totalBytes: 24 * G, availableBytes: 12 * G, inactiveBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0, swapoutPages: 0, pageSize: 16384, pressure: "normal", gpuLimitBytes: 18 * G }) };
  const monitor = new MemoryMonitor(probe, { thrashSwapoutMiBps: 40, pollMs: 100 });
  await monitor.sample();
  process.env.PITCREW_LOG = "quiet";
  const gw = createGateway(cfg, { monitor });
  gw.scheduler.start(50);
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
  try {
    const body = form("B0und", { model: "stt" }, { name: "clip.wav", data: Buffer.from("hello there") });
    const res = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=B0und" }, body });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { text: "heard:hello there" });
    const noFile = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "stt" }) });
    assert.equal(noFile.status, 400);

    const v = await fetch(`${base}/v1/videos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "video", prompt: "a cat" }) });
    assert.equal(v.status, 200);
    const vj = (await v.json()) as { data: { b64_json: string; mime: string }[] };
    assert.equal(vj.data[0]!.mime, "video/mp4");
    assert.match(Buffer.from(vj.data[0]!.b64_json, "base64").toString(), /^BALLAST 0.1GB/);
    const cal = JSON.parse(readFileSync(join(stateDir, "job-calibration.json"), "utf8"));
    assert.ok(cal.video.rssBytes > 90 * 1024 * 1024, `ballast RSS measured: ${cal.video.rssBytes}`);
    assert.equal(cal.video.runs, 1);
    // A fresh gateway starts from the persisted peak instead of the declared guess.
    assert.ok(existsSync(join(stateDir, "job-calibration.json")));
    const gw2 = createGateway(cfg, { monitor });
    await new Promise<void>((r) => gw2.server.listen(0, "127.0.0.1", () => r()));
    const st2 = (await (await fetch(`http://127.0.0.1:${(gw2.server.address() as AddressInfo).port}/governor/state`)).json()) as { jobCalibration: Record<string, { runs: number }> };
    assert.equal(st2.jobCalibration.video?.runs, 1);
    await gw2.close();
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("deferrable jobs: never age, wait for interactive work, then may evict the idle coder", async () => {
  let clock = 1_000_000;
  let available = 10 * G;
  const sched = new Scheduler(
    { osReserveBytes: 4 * G, minFreeBytes: 1 * G, probeLagMs: 0, maxConcurrent: 2, queueTimeoutMs: 10 * 60_000, idleUnloadMs: 0, agingMs: 60_000 },
    () => ({ t: clock, totalBytes: 24 * G, availableBytes: available, inactiveBytes: 0, gpuLimitBytes: 18 * G, state: "ok" }),
    async () => undefined,
    () => clock,
  );
  const log: string[] = [];
  const llm = (key: string, size: number): AcquireRequest => ({
    key, kind: "llm", priority: "interactive", ctx: 8192, estimate: () => size, parallel: 1,
    ops: { load: async () => { log.push(`load:${key}`); available -= size; return { bytes: size }; }, unload: async () => { log.push(`unload:${key}`); available += size; } },
  });
  const coder = await sched.acquire(llm("coder", 7 * G));
  let ran = false;
  const video = sched.acquire({ key: "job:video", kind: "job", priority: "deferrable", ctx: 0, estimate: () => 8 * G, parallel: 1, ops: { load: async () => undefined, unload: async () => undefined } }).then((l) => { ran = true; return l; });
  const queued = sched.acquire(llm("coder", 7 * G));
  coder.release();
  const second = await queued;
  clock += 120_000;
  sched.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(ran, false, "does not age into interactive or evict a busy coder");
  second.release();
  clock += 1000;
  sched.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(ran, false, "coder idle only 1 s");
  clock += 3000;
  sched.tick();
  (await video).release();
  assert.equal(ran, true);
  assert.deepEqual(log, ["load:coder", "unload:coder"]);
});
