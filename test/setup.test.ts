import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { OllamaClient } from "../src/backend/ollama.ts";
import { DEFAULTS, loadConfig, type Config } from "../src/config.ts";
import { createGateway } from "../src/server/http.ts";
import { MemoryMonitor, type MemoryProbe } from "../src/system/memory.ts";
import { recommend, type MachineView } from "../src/setup/catalog.ts";
import { apply, detect, plan } from "../src/setup/init.ts";
import { doctor } from "../src/setup/doctor.ts";
import { startMockOllama } from "./mock-ollama.ts";

const GiB = 1024 ** 3;
const G = 1e9;
process.env.PITCREW_LOG = "quiet";

/** A machine with `total` GiB, most of it free, and the Apple GPU limit (~74% of RAM). */
const mac = (total: number, freeGiB = total * 0.6): MachineView => ({
  totalBytes: total * GiB,
  availableBytes: freeGiB * GiB,
  inactiveBytes: 0,
  gpuLimitBytes: total * 0.74 * GiB,
  pressure: "normal",
});

const probeFor = (m: MachineView): MemoryProbe => ({
  async read() {
    return { t: Date.now(), ...m, swapUsedBytes: 0, swapTotalBytes: 0, swapoutPages: 0, pageSize: 16384 };
  },
});

test("recommend: total RAM picks the tier", () => {
  const cases: [number, string, string, number][] = [
    [8, "qwen3.5:2b", "qwen3.5:0.8b", 16384],
    [16, "qwen3.5:4b", "qwen3.5:0.8b", 16384],
    [24, "qwen3.5:9b", "qwen3.5:0.8b", 32768],
    [32, "qwen3.5:9b", "qwen3.5:0.8b", 65536],
    [64, "qwen3.5:9b", "qwen3.5:2b", 65536],
  ];
  for (const [total, coder, light, maxCtx] of cases) {
    const r = recommend(mac(total), []);
    assert.equal(r.coder.name, coder, `${total} GB coder`);
    assert.equal(r.light.name, light, `${total} GB light`);
    assert.equal(r.maxCtx, maxCtx, `${total} GB ctx`);
    assert.ok(r.needBytes <= r.hardBudgetBytes, `${total} GB fits budget`);
  }
  assert.ok(recommend(mac(32), []).notes.some((n) => n.includes("Qwen3.8-27B")), "big machines hear about bigger models");
});

test("recommend: steps the coder down when the budget is too small", () => {
  const tight = { ...mac(24), gpuLimitBytes: 8 * GiB }; // budget 7.2 GiB: 9b + 0.8b does not fit
  const r = recommend(tight, []);
  assert.notEqual(r.coder.name, "qwen3.5:9b");
  assert.ok(r.needBytes <= r.hardBudgetBytes);
  assert.ok(r.warnings.some((w) => w.includes("qwen3.5:9b would not fit")));
});

test("recommend: busy machine warns, pulled sizes win, bigger pulled models are mentioned", () => {
  const busy = recommend(mac(24, 2), [{ name: "qwen3.5:9b", size: 7.6 * G }]);
  assert.equal(busy.fitsNow, false);
  assert.ok(busy.warnings.some((w) => w.includes("free right now")));
  assert.equal(busy.coder.basis, "pulled");

  const r16 = recommend(mac(16), [{ name: "qwen3.5:9b", size: 7.6 * G }]);
  assert.equal(r16.coder.name, "qwen3.5:4b");
  assert.ok(r16.notes.some((n) => n.includes("--coder qwen3.5:9b")));

  const forced = recommend(mac(16), [], { coder: "mystery:7b" });
  assert.equal(forced.coder.name, "mystery:7b");
  assert.ok(forced.warnings.some((w) => w.includes("size unknown")));
});

test("init: pulls what is missing, writes a config that loads, keeps existing files", async () => {
  const mock = await startMockOllama([{ name: "qwen3.5:0.8b", size: 1.2 * G }], { pullSizes: { "qwen3.5:9b": 7.6 * G } });
  try {
    const dir = mkdtempSync(join(tmpdir(), "pitcrew-init-"));
    const client = new OllamaClient(mock.url);
    const deps = { probe: probeFor(mac(24)), client, toolVersion: (c: string) => (c === "opencode" ? "1.18.35" : "0.40.11") };
    const p = plan(await detect(deps), { dir, port: 11600 });
    assert.deepEqual(p.pulls, ["qwen3.5:9b"]);
    assert.deepEqual(p.blockers, []);
    const log: string[] = [];
    const res = await apply(p, client, (l) => log.push(l));
    assert.deepEqual(res.pulled, ["qwen3.5:9b"]);
    assert.ok(log.some((l) => l.includes("50%")), "progress is reported");
    assert.ok((await client.tags()).some((t) => t.name === "qwen3.5:9b"));

    const { config } = loadConfig(join(dir, "config.json"));
    assert.equal(config.listen.port, 11600);
    assert.equal(config.router.coder, "coder");
    assert.deepEqual([(config.models.coder as { model: string }).model, (config.models.small as { model: string }).model], ["qwen3.5:9b", "qwen3.5:0.8b"]);
    const profile = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
    assert.equal(profile.provider.pitcrew.options.baseURL, "http://127.0.0.1:11600/v1");
    assert.equal(profile.model, "pitcrew/auto");

    // Second run: everything pulled, files kept unless --force.
    writeFileSync(join(dir, "config.json"), "{}\n");
    const again = plan(await detect(deps), { dir, port: 11600 });
    assert.deepEqual(again.pulls, []);
    assert.deepEqual(again.files.map((f) => f.action), ["keep", "keep"]);
    await apply(again, client, () => {});
    assert.equal(readFileSync(join(dir, "config.json"), "utf8"), "{}\n");
    assert.deepEqual(plan(await detect(deps), { dir, force: true }).files.map((f) => f.action), ["overwrite", "overwrite"]);
  } finally {
    await mock.close();
  }
});

test("init: Ollama missing → blocker, pulls skipped, files still written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pitcrew-init-"));
  const client = new OllamaClient("http://127.0.0.1:9"); // nothing listens on the discard port
  const p = plan(await detect({ probe: probeFor(mac(16)), client, toolVersion: () => undefined }), { dir });
  assert.ok(p.blockers.some((b) => b.includes("ollama.com/download")));
  assert.deepEqual(p.pulls, ["qwen3.5:4b", "qwen3.5:0.8b"]);
  assert.ok(p.next.some((n) => n.includes("npm i -g opencode-ai")));
  const res = await apply(p, client, () => {});
  assert.deepEqual(res.pulled, []);
  assert.equal(res.skipped.length, 2);
  assert.ok(existsSync(join(dir, "config.json")));
});

test("doctor: healthy chain passes end to end; missing pieces fail with fixes", async () => {
  const mock = await startMockOllama([
    { name: "qwen3.5:9b", size: 7.6 * G },
    { name: "qwen3.5:0.8b", size: 1.2 * G },
  ]);
  const machine = mac(24);
  const monitor = new MemoryMonitor(probeFor(machine), { ...DEFAULTS.memory, pollMs: 100 });
  await monitor.sample();
  const dir = mkdtempSync(join(tmpdir(), "pitcrew-doctor-"));
  const cfg: Config = {
    ...DEFAULTS,
    backend: { ...DEFAULTS.backend, url: mock.url, parallel: 1 },
    models: { coder: { model: "qwen3.5:9b", primary: true }, small: { model: "qwen3.5:0.8b", maxCtx: 8192 } },
    stateDir: dir,
  };
  const gw = createGateway(cfg, { monitor });
  gw.scheduler.start(100);
  await gw.registry.refresh();
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", () => r()));
  cfg.listen = { host: "127.0.0.1", port: (gw.server.address() as AddressInfo).port };
  const profilePath = join(dir, "opencode.json");
  writeFileSync(profilePath, JSON.stringify({ provider: { pitcrew: { options: { baseURL: `http://127.0.0.1:${cfg.listen.port}/v1` } } } }));
  const base = { config: cfg, configPath: join(dir, "config.json"), client: new OllamaClient(mock.url), probe: probeFor(machine), profilePath, toolVersion: () => "1.0" };
  try {
    const ok = await doctor(base);
    assert.deepEqual(ok.filter((c) => c.status !== "ok"), [], JSON.stringify(ok, null, 2));
    assert.ok(ok.find((c) => c.name === "request")?.detail.includes("auto →"));

    const broken = await doctor({
      ...base,
      configPath: undefined,
      config: { ...cfg, models: { coder: { model: "qwen3.5:27b" } } },
      profilePath: join(dir, "missing.json"),
      request: false,
    });
    const byName = Object.fromEntries(broken.map((c) => [c.name, c]));
    assert.equal(byName.config?.status, "fail");
    assert.equal(byName["router.light"]?.status, "fail");
    assert.equal(byName["model coder"]?.fix, "ollama pull qwen3.5:27b");
    assert.equal(byName["opencode profile"]?.status, "warn");
  } finally {
    await gw.close();
    await mock.close();
  }
});
