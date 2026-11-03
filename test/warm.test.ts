import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DEFAULTS, type Config } from "../src/config.ts";
import { createGateway } from "../src/server/http.ts";
import { MemoryMonitor, type MemorySnapshot } from "../src/system/memory.ts";
import { startMockOllama } from "./mock-ollama.ts";

const G = 1024 ** 3;

async function gatewayWith(parallel: number) {
  const mock = await startMockOllama([{ name: "qwen3.5:9b", size: 6.6 * G }, { name: "qwen3.5:0.8b", size: 1 * G }], { tokenDelayMs: 20, parallel });
  const cfg: Config = {
    ...DEFAULTS,
    backend: { ...DEFAULTS.backend, url: mock.url },
    scheduler: { ...DEFAULTS.scheduler, idleUnloadMs: 0 },
    models: {
      coder: { model: "qwen3.5:9b", primary: true },
      small: { model: "qwen3.5:0.8b", warm: true, maxCtx: 16384 },
    },
    stateDir: mkdtempSync(join(tmpdir(), "pitcrew-warm-")),
  };
  const probe = { read: async (): Promise<MemorySnapshot> => ({ t: Date.now(), totalBytes: 24 * G, availableBytes: 12 * G, inactiveBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0, swapoutPages: 0, pageSize: 16384, pressure: "normal", gpuLimitBytes: 18 * G }) };
  const monitor = new MemoryMonitor(probe, { thrashSwapoutMiBps: 40, pollMs: 100 });
  await monitor.sample();
  process.env.PITCREW_LOG = "quiet";
  const gw = createGateway(cfg, { monitor });
  return { gw, mock };
}

for (const parallel of [1, 2]) {
  test(`warm-up loads and pins the helper, and detects ${parallel} backend slot(s)`, async () => {
    const { gw, mock } = await gatewayWith(parallel);
    await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
    try {
      await gw.warmUp();
      const unit = gw.scheduler.units.get("qwen3.5:0.8b");
      assert.equal(unit?.state, "ready");
      assert.equal(unit?.pin, true);
      const st = (await (await fetch(`${base}/governor/state`)).json()) as { backendParallel: { slots: number; source: string } };
      assert.equal(st.backendParallel.slots, parallel, st.backendParallel.source);
      const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "small", messages: [{ role: "user", content: "hi" }] }) });
      assert.equal(res.status, 200);
      await res.text();
      // The helper wants 2 slots; it never gets more than the backend has.
      assert.equal(gw.scheduler.units.get("qwen3.5:0.8b")?.parallel, Math.min(2, parallel));
      assert.equal(mock.calls.filter((c) => c.startsWith("POST /api/generate pitcrew/qwen3.5-0.8b") && c.endsWith("ka=-1")).length, 1 + 4, "one load + four probe requests");
    } finally {
      await gw.close();
      await mock.close();
    }
  });
}
