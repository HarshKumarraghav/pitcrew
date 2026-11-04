import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DEFAULTS, type Config } from "../src/config.ts";
import { createGateway } from "../src/server/http.ts";
import { isClaudeModel, messagesPatch, openAIView } from "../src/server/anthropic.ts";
import { classifyStep } from "../src/server/levers.ts";
import { MemoryMonitor, type MemorySnapshot } from "../src/system/memory.ts";
import { startMockOllama } from "./mock-ollama.ts";

const G = 1024 ** 3;
const TOOLS = [{ name: "Read", description: "read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }];
// A Claude Code turn: big system prompt, a tool_use, its result, then the next request.
const AGENT = {
  model: "claude-sonnet-4-5",
  max_tokens: 4096,
  stream: true,
  system: [{ type: "text", text: "You are Claude Code. ".repeat(600) }],
  tools: TOOLS,
  messages: [
    { role: "user", content: [{ type: "text", text: "fix the failing test" }] },
    { role: "assistant", content: [{ type: "text", text: "Reading it." }, { type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "src/a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: [{ type: "text", text: "export const a = 1;" }] }] },
  ],
};

test("Messages view: system, tool_use and tool_result map onto the OpenAI shapes the router reads", () => {
  const v = openAIView(AGENT) as { messages: { role: string; content: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[]; tools: unknown[] };
  assert.deepEqual(v.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(v.messages[2]!.tool_calls![0]!.function.name, "Read");
  assert.equal(v.messages[3]!.tool_call_id, "toolu_a");
  assert.equal(v.tools.length, 1);
  assert.equal(classifyStep(v).step, "after-read");
  const err = openAIView({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", is_error: true, content: "no such file" }] }] }) as { messages: { content: string }[] };
  assert.match(err.messages[0]!.content, /^Error: no such file/);
  assert.ok(isClaudeModel("claude-sonnet-4-5") && isClaudeModel("claude-haiku-5-5") && !isClaudeModel("coder"));
  assert.deepEqual(messagesPatch({ max_tokens: 512, reasoning_effort: "none" }), { max_tokens: 512, thinking: { type: "disabled" } });
});

async function gateway() {
  const mock = await startMockOllama([{ name: "qwen3.5:9b", size: 6.6 * G }, { name: "qwen3.5:0.8b", size: 1 * G }]);
  const stateDir = mkdtempSync(join(tmpdir(), "pitcrew-anthropic-"));
  const cfg: Config = {
    ...DEFAULTS,
    backend: { ...DEFAULTS.backend, url: mock.url },
    scheduler: { ...DEFAULTS.scheduler, idleUnloadMs: 0 },
    models: { coder: { model: "qwen3.5:9b", primary: true, maxCtx: 32768 }, small: { model: "qwen3.5:0.8b" } },
    stateDir,
  };
  const probe = { read: async (): Promise<MemorySnapshot> => ({ t: Date.now(), totalBytes: 24 * G, availableBytes: 14 * G, inactiveBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0, swapoutPages: 0, pageSize: 16384, pressure: "normal", gpuLimitBytes: 18 * G }) };
  const monitor = new MemoryMonitor(probe, { thrashSwapoutMiBps: 40, pollMs: 100 });
  await monitor.sample();
  process.env.PITCREW_LOG = "quiet";
  const gw = createGateway(cfg, { monitor });
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
  return { mock, stateDir, post, close: async () => (await gw.close(), await mock.close()) };
}

test("Claude Code → Pit Crew: a claude-* agent turn goes to the local coder; the stream passes through; telemetry reads it", async () => {
  const g = await gateway();
  try {
    const res = await g.post("/v1/messages", AGENT);
    const out = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("x-pitcrew-route") ?? "", /^agent->coder .*\[as claude-sonnet-4-5\]/);
    assert.match(res.headers.get("x-pitcrew-model") ?? "", /^pitcrew\/qwen3\.5-9b/);
    const sent = g.mock.bodies.at(-1)!;
    assert.match(String(sent.model), /^pitcrew\/qwen3\.5-9b/);
    assert.deepEqual(sent.system, AGENT.system, "body forwarded as sent");
    assert.deepEqual(sent.messages, AGENT.messages);
    assert.match(out, /event: message_start[\s\S]*"name":"Read"[\s\S]*event: message_stop/);
    await new Promise((r) => setTimeout(r, 100));
    const rec = readFileSync(join(g.stateDir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    assert.equal(rec.path, "/v1/messages");
    assert.equal(rec.kind, "agent");
    assert.equal(rec.step, "after-read");
    assert.deepEqual(rec.toolCalls, ["Read"]);
    assert.equal(rec.finish, "tool_use");
    assert.ok(rec.promptTokens > 0 && rec.completionTokens === 3);
  } finally {
    await g.close();
  }
});

test("Claude Code helper request (no tools, short) → light model with thinking off and output capped", async () => {
  const g = await gateway();
  try {
    const res = await g.post("/v1/messages", { model: "claude-haiku-5-5", max_tokens: 32000, messages: [{ role: "user", content: "Summarize this in a 5-word title: fix login" }] });
    const j = await res.json();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("x-pitcrew-route") ?? "", /^helper->small/);
    assert.equal(j.content[0].text, "hello");
    const sent = g.mock.bodies.at(-1)!;
    assert.deepEqual(sent.thinking, { type: "disabled" });
    assert.equal(sent.max_tokens, DEFAULTS.router.helperMaxTokens);
  } finally {
    await g.close();
  }
});

test("count_tokens answers locally; errors use Anthropic's envelope", async () => {
  const g = await gateway();
  try {
    const c = await (await g.post("/v1/messages/count_tokens", { model: "claude-sonnet-4-5", messages: AGENT.messages, system: AGENT.system, tools: TOOLS })).json();
    assert.ok(Number.isInteger(c.input_tokens) && c.input_tokens > 1000, JSON.stringify(c));
    assert.ok(!g.mock.calls.some((x) => x.includes("count_tokens")), "never forwarded");
    const big = await g.post("/v1/messages", { ...AGENT, system: "word ".repeat(200_000) });
    assert.equal(big.status, 400);
    const e = await big.json();
    assert.equal(e.type, "error");
    assert.equal(e.error.type, "invalid_request_error");
    assert.match(e.error.message, /context too large/);
  } finally {
    await g.close();
  }
});

test("Claude Code tool names and results classify like OpenCode's (Bash test failures, Edit misses, stuck edits)", () => {
  const turn = (name: string, input: Record<string, unknown>, result: string, isError = false, id = `t${Math.random()}`) => [
    { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: result }] },
  ];
  const req = (...turns: unknown[][]) => openAIView({ system: "x", tools: TOOLS, messages: [{ role: "user", content: "fix it" }, ...turns.flat()] });
  const failing = "Exit code 1\n\n> t test\n> node --test\n\nnot ok 1 - adds\n  ---\n  expected: 4\n  actual: 0\n  ...\n# fail 1";
  const t = classifyStep(req(turn("Bash", { command: "npm test" }, failing, true)));
  assert.equal(t.step, "after-test-fail");
  assert.deepEqual(t.failing?.[0], { name: "adds", where: undefined, detail: "expected 4, actual 0" });
  const miss = classifyStep(req(turn("Edit", { file_path: "/r/a.ts", old_string: "nope", new_string: "x" }, "String to replace not found in file.", true)));
  assert.deepEqual(miss.editMiss, { filePath: "/r/a.ts", oldString: "nope" });
  assert.equal(classifyStep(req(turn("Read", { file_path: "/r/a.ts" }, "1\texport const a = 1;"))).step, "after-read");
  const ok = (o: string, n: string) => turn("MultiEdit", { file_path: "/r/a.ts", old_string: o, new_string: n }, "The file /r/a.ts has been updated.");
  assert.deepEqual(classifyStep(req(ok("a", "b"), ok("b", "a"), ok("a", "b"), ok("b", "a"))).stuck, { kind: "no-diff-progress", count: 3 });
});
