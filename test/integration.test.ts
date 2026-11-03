import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DEFAULTS, type Config } from "../src/config.ts";
import { createGateway, extractUsage, type Gateway } from "../src/server/http.ts";
import { MemoryMonitor, type MemoryProbe, type MemorySnapshot } from "../src/system/memory.ts";
import { startMockOllama } from "./mock-ollama.ts";

const G = 1024 ** 3;

/** Fake machine whose available memory shrinks by whatever the mock reports as loaded. */
function fakeProbe(getLoaded: () => number, freeGiB: number): MemoryProbe {
  return {
    async read(): Promise<MemorySnapshot> {
      return {
        t: Date.now(),
        totalBytes: 24 * G,
        availableBytes: freeGiB * G - getLoaded(),
        inactiveBytes: 0,
        swapUsedBytes: 0,
        swapTotalBytes: 0,
        swapoutPages: 0,
        pageSize: 16384,
        pressure: "normal",
        gpuLimitBytes: 18 * G,
      };
    },
  };
}

let mock: Awaited<ReturnType<typeof startMockOllama>>;
let gw: Gateway;
let base: string;

before(async () => {
  mock = await startMockOllama(
    [
      { name: "qwen3.5:9b", size: 6.6 * G },
      { name: "qwen3.5:2b", size: 1.9 * G },
      { name: "kimi-k2.5:cloud", size: 0, remote: true },
    ],
    { tokenDelayMs: 5 },
  );
  const cfg: Config = {
    ...DEFAULTS,
    backend: { ...DEFAULTS.backend, url: mock.url },
    memory: { ...DEFAULTS.memory, osReserveGiB: 4, minFreeGiB: 1, pollMs: 100 },
    scheduler: { ...DEFAULTS.scheduler, idleUnloadMs: 0 },
    models: {
      coder: { model: "qwen3.5:9b", minCtx: 16384, maxCtx: 32768 },
      small: { model: "qwen3.5:2b", maxCtx: 16384, priority: "background" },
      tts: { kind: "job", endpoint: "speech", command: ["node", "-e", "require('fs').writeFileSync(process.argv[1], 'RIFF'+process.argv[2])", "{out}", "{input}"], memoryGiB: 0.2, outputExt: "wav" },
    },
    stateDir: mkdtempSync(join(tmpdir(), "pitcrew-test-")),
  };
  const loadedBytes = () => [...mock.loaded.values()].reduce((a, b) => a + b, 0);
  // 10.5 GiB "free" before models: fits coder (≈7.6G est) OR coder+small barely not → forces eviction.
  const monitor = new MemoryMonitor(fakeProbe(loadedBytes, 10.5), { thrashSwapoutMiBps: 40, pollMs: 100 });
  await monitor.sample();
  monitor.start();
  process.env.PITCREW_LOG = "quiet";
  gw = createGateway(cfg, { monitor });
  gw.scheduler.start(100);
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
});

after(async () => {
  await gw.close();
  await mock.close();
});

const chat = (model: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
  });

test("routes an alias to a derived context variant and forwards the reply", async () => {
  const res = await chat("coder");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-pitcrew-ctx"), "16384", "minCtx respected");
  assert.equal(res.headers.get("x-pitcrew-model"), "pitcrew/qwen3.5-9b:16k");
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  assert.equal(body.choices[0]?.message.content, "hello");
  assert.ok(mock.created.has("pitcrew/qwen3.5-9b:16k"));
  assert.ok(mock.calls.some((c) => c.includes("/api/generate pitcrew/qwen3.5-9b:16k ka=-1")), "loaded with keep_alive -1");
});

test("streams SSE byte-for-byte, including tool calls", async () => {
  const res = await chat("coder", { stream: true, max_tokens: 3 });
  const text = await res.text();
  assert.match(text, /t0 /);
  assert.match(text, /"tool_calls":\[\{"index":0,"id":"call_1"/);
  assert.match(text, /data: \[DONE\]/);
});

test("refuses cloud models", async () => {
  const res = await chat("kimi-k2.5:cloud");
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /cloud/);
});

test("rejects oversize prompts instead of truncating", async () => {
  const res = await chat("small", { messages: [{ role: "user", content: "x".repeat(200_000) }] });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /context too large/);
});

test("evicts the idle coder to fit the small model when memory is short", async () => {
  // coder (~7.6G) is resident; 10.5G free - loaded - 1G floor leaves too little for small (~2.4G).
  mock.calls.length = 0;
  const res = await chat("small");
  assert.equal(res.status, 200);
  assert.ok(mock.calls.some((c) => c.includes("pitcrew/qwen3.5-9b:16k ka=0")), `coder unloaded: ${mock.calls.join(" | ")}`);
  assert.ok(!mock.loaded.has("pitcrew/qwen3.5-9b:16k"));
  const events = gw.scheduler.events.map((e) => e.type);
  assert.ok(events.includes("evict"));
});

test("client disconnect mid-stream releases the slot", async () => {
  const ac = new AbortController();
  const res = await chat("small", { stream: true, max_tokens: 200 }, {});
  const reader = res.body!.getReader();
  await reader.read();
  void ac;
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(gw.scheduler.snapshot().running, 0);
});

test("lists aliases and local models, never cloud", async () => {
  const res = await fetch(`${base}/v1/models`);
  const ids = ((await res.json()) as { data: { id: string }[] }).data.map((d) => d.id);
  assert.ok(ids.includes("coder") && ids.includes("small") && ids.includes("tts"));
  assert.ok(ids.includes("qwen3.5:9b"));
  assert.ok(!ids.includes("kimi-k2.5:cloud"));
  assert.ok(!ids.some((i) => i.startsWith("pitcrew/")), "derived variants are hidden");
});

test("runs a speech job through the scheduler", async () => {
  const res = await fetch(`${base}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tts", input: "hello" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/wav");
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "RIFFhello");
});

test("state and metrics endpoints expose measured memory", async () => {
  const s = (await (await fetch(`${base}/governor/state`)).json()) as { memory: { measured: boolean }; scheduler: { units: unknown[] } };
  assert.equal(s.memory.measured, true);
  assert.ok(s.scheduler.units.length >= 1);
  const m = await (await fetch(`${base}/metrics`)).text();
  assert.match(m, /pitcrew_memory_available_bytes \d+/);
  assert.match(m, /pitcrew_requests_total\{model="qwen3.5:9b",status="200"\} \d+/);
});

test("extractUsage reads OpenAI and Ollama-native usage", () => {
  assert.deepEqual(extractUsage('data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}'), { prompt_tokens: 12, completion_tokens: 3 });
  assert.deepEqual(extractUsage('{"done":true,"prompt_eval_count":40,"eval_count":7}'), { prompt_tokens: 40, completion_tokens: 7 });
});

test("router model 'auto': helpers and agent turns are routed and labelled", async () => {
  const helper = await chat("auto", { max_tokens: 4096 });
  assert.equal(helper.status, 200);
  assert.match(helper.headers.get("x-pitcrew-route") ?? "", /^helper->(small|coder) \(mode C/);
  await helper.arrayBuffer();
  const agentTurn = await chat("auto", { tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] });
  assert.equal(agentTurn.status, 200);
  assert.match(agentTurn.headers.get("x-pitcrew-route") ?? "", /^agent->coder/);
  await agentTurn.arrayBuffer();
  const models = ((await (await fetch(`${base}/v1/models`)).json()) as { data: { id: string }[] }).data.map((d) => d.id);
  assert.ok(models.includes("auto"));
});

test("writes one size-and-timing record per request, with reasoning split and no prompt text", async () => {
  const secret = "SECRET-PROMPT-TEXT-123";
  const res = await chat("coder", { stream: true, max_tokens: 3, reasoning_effort: "high", messages: [{ role: "system", content: "sys" }, { role: "user", content: secret }], tools: [{ type: "function", function: { name: "read" } }] });
  await res.text();
  await new Promise((r) => setTimeout(r, 100));
  const raw = readFileSync(join(gw.registry["cfg"].stateDir, "requests.jsonl"), "utf8");
  assert.ok(!raw.includes(secret), "prompt text never logged");
  const rec = JSON.parse(raw.trim().split("\n").pop()!);
  assert.equal(rec.kind, "agent");
  assert.equal(rec.status, 200);
  assert.ok(rec.firstReasoningMs <= rec.firstContentMs, "reasoning streamed before content");
  assert.ok(rec.reasoningChars > 0 && rec.contentChars > 0);
  assert.deepEqual(rec.toolCalls, ["read"]);
  assert.ok(rec.reasoningDecodeMs >= 0 && rec.contentDecodeMs >= 0 && rec.prefillMs >= 0);
  assert.match(rec.session, /^[0-9a-f]{12}$/);
});
