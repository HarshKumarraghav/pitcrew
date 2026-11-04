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
const TEXT = "I'll read it.\n<function=read>\n<parameter=filePath>\n/tmp/L/src/utils/paginate.ts\n</parameter>\n</function>\n</tool_call>";
const TOOLS = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { filePath: { type: "string" } } } } }];

async function gateway(repairToolCalls: boolean) {
  const mock = await startMockOllama([{ name: "qwen3.5:9b", size: 6.6 * G }], { textToolCall: TEXT });
  const stateDir = mkdtempSync(join(tmpdir(), "pitcrew-toolcalls-"));
  const cfg: Config = {
    ...DEFAULTS,
    backend: { ...DEFAULTS.backend, url: mock.url },
    scheduler: { ...DEFAULTS.scheduler, idleUnloadMs: 0 },
    models: { coder: { model: "qwen3.5:9b", primary: true } },
    router: { ...DEFAULTS.router, repairToolCalls },
    stateDir,
  };
  const probe = { read: async (): Promise<MemorySnapshot> => ({ t: Date.now(), totalBytes: 24 * G, availableBytes: 14 * G, inactiveBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0, swapoutPages: 0, pageSize: 16384, pressure: "normal", gpuLimitBytes: 18 * G }) };
  const monitor = new MemoryMonitor(probe, { thrashSwapoutMiBps: 40, pollMs: 100 });
  await monitor.sample();
  process.env.PITCREW_LOG = "quiet";
  const gw = createGateway(cfg, { monitor });
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
  const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.text());
  const close = async () => {
    await gw.close();
    await mock.close();
  };
  return { mock, base, stateDir, post, close };
}

const toolCalls = (sse: string) =>
  sse
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .flatMap((l) => JSON.parse(l.slice(6)).choices.map((c: { delta: { tool_calls?: unknown[] }; finish_reason: string | null }) => c))
    .reduce((a: { calls: unknown[]; finish: string[] }, c: { delta: { tool_calls?: unknown[] }; finish_reason: string | null }) => ({ calls: [...a.calls, ...(c.delta.tool_calls ?? [])], finish: c.finish_reason ? [...a.finish, c.finish_reason] : a.finish }), { calls: [], finish: [] });

test("repairToolCalls on: a text tool call reaches the client as tool_calls, counted and logged", async () => {
  const g = await gateway(true);
  try {
    const out = await g.post(`${g.base}/v1/chat/completions`, { model: "coder", stream: true, messages: [{ role: "user", content: "read paginate" }], tools: TOOLS });
    const t = toolCalls(out);
    assert.equal(t.calls.length, 1);
    assert.deepEqual(t.finish, ["tool_calls"]);
    const content = out.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices[0]?.delta?.content ?? "").join("");
    assert.equal(content, "I'll read it.\n");
    assert.ok(out.trimEnd().endsWith("data: [DONE]"));
    // Without tools in the request the text is left alone.
    const plain = await g.post(`${g.base}/v1/chat/completions`, { model: "coder", stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.equal(toolCalls(plain).calls.length, 0);
    const metrics = await fetch(`${g.base}/metrics`).then((r) => r.text());
    assert.match(metrics, /pitcrew_toolcalls_repaired_total\{model="qwen3.5:9b"\} 1/);
    await new Promise((r) => setTimeout(r, 100));
    const recs = readFileSync(join(g.stateDir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(recs[0].repairedToolCalls, 1);
    assert.deepEqual(recs[0].toolCalls, ["read"], "telemetry sees what the client got");
    assert.equal(recs[0].finish, "tool_calls");
    assert.equal(recs[1].repairedToolCalls, undefined);
    assert.ok(!readFileSync(join(g.stateDir, "requests.jsonl"), "utf8").includes("paginate"), "no answer text in the log");
  } finally {
    await g.close();
  }
});

test("repairToolCalls off: the gateway passes the upstream bytes unchanged", async () => {
  const g = await gateway(false);
  try {
    const req = { model: "coder", stream: true, messages: [{ role: "user", content: "read paginate" }], tools: TOOLS };
    const viaGateway = await g.post(`${g.base}/v1/chat/completions`, req);
    const direct = await g.post(`${g.mock.url}/v1/chat/completions`, req);
    assert.equal(viaGateway, direct);
    assert.equal(toolCalls(viaGateway).calls.length, 0);
  } finally {
    await g.close();
  }
});
