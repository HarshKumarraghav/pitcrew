import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DEFAULTS, type Config } from "../src/config.ts";
import { createGateway } from "../src/server/http.ts";
import { MemoryMonitor, type MemorySnapshot } from "../src/system/memory.ts";
import { startMockOllama } from "./mock-ollama.ts";

const G = 1024 ** 3;
const SESSION = JSON.parse(readFileSync(new URL("./fixtures/opencode-session.json", import.meta.url), "utf8")) as { messages: unknown[]; tools: unknown[] };

test("router levers reach the backend and are logged per step", async () => {
  const mock = await startMockOllama([{ name: "qwen3.5:9b", size: 6.6 * G }, { name: "qwen3.5:0.8b", size: 1 * G }]);
  const stateDir = mkdtempSync(join(tmpdir(), "pitcrew-levers-"));
  const cfg: Config = {
    ...DEFAULTS,
    backend: { ...DEFAULTS.backend, url: mock.url },
    scheduler: { ...DEFAULTS.scheduler, idleUnloadMs: 0 },
    models: { coder: { model: "qwen3.5:9b", primary: true }, small: { model: "qwen3.5:0.8b" } },
    router: { ...DEFAULTS.router, reasoningBudget: { enabled: true, afterRead: "low", maxTokens: {} }, testRepair: true },
    stateDir,
  };
  const probe = { read: async (): Promise<MemorySnapshot> => ({ t: Date.now(), totalBytes: 24 * G, availableBytes: 14 * G, inactiveBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0, swapoutPages: 0, pageSize: 16384, pressure: "normal", gpuLimitBytes: 18 * G }) };
  const monitor = new MemoryMonitor(probe, { thrashSwapoutMiBps: 40, pollMs: 100 });
  await monitor.sample();
  process.env.PITCREW_LOG = "quiet";
  const gw = createGateway(cfg, { monitor });
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
  const send = async (n: number) => {
    const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "auto", stream: true, messages: SESSION.messages.slice(0, n), tools: SESSION.tools }) });
    await res.text();
    return res.headers.get("x-pitcrew-route") ?? "";
  };
  try {
    assert.match(await send(16), /agent->coder .*\[after-read: reasoning:low\]/);
    assert.equal(mock.bodies.at(-1)?.reasoning_effort, "low");
    assert.match(await send(10), /\[after-test-fail: hint:test-repair\]/);
    assert.equal(mock.bodies.at(-1)?.reasoning_effort, undefined);
    assert.equal((mock.bodies.at(-1)?.messages as unknown[]).length, 11, "one hint appended");
    await send(4);
    await new Promise((r) => setTimeout(r, 100));
    const recs = readFileSync(join(stateDir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(recs.map((r) => r.step), ["after-read", "after-test-fail", "after-read"]);
    assert.deepEqual(recs.map((r) => r.levers), [["reasoning:low"], ["hint:test-repair"], ["reasoning:low"]]);
  } finally {
    await gw.close();
    await mock.close();
  }
});
