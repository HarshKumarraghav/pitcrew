import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamTap, derive, requestKind, sessionKey, tailShape } from "../src/server/telemetry.ts";

function clock(start = 0) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v) };
}

test("tap: OpenAI SSE with reasoning, content and a tool call split across chunks", () => {
  const c = clock(1000);
  const tap = new StreamTap(1000, c.now);
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  c.set(1200);
  const a = ev({ choices: [{ delta: { reasoning: "let me think" } }] });
  tap.push(a.slice(0, 10));
  tap.push(a.slice(10));
  c.set(1700);
  tap.push(ev({ choices: [{ delta: { content: "ok" } }] }));
  c.set(1800);
  tap.push(ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"p":' } }] } }] }));
  tap.push(ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" }] }));
  tap.push(ev({ choices: [], usage: { prompt_tokens: 5000, completion_tokens: 40 } }));
  tap.push("data: [DONE]\n\n");
  c.set(2000);
  const r = tap.finish();
  assert.equal(r.firstByteMs, 200);
  assert.equal(r.firstReasoningMs, 200);
  assert.equal(r.firstContentMs, 700);
  assert.equal(r.endMs, 1000);
  assert.equal(r.reasoningChars, 12);
  assert.equal(r.contentChars, 2);
  assert.deepEqual(r.toolCalls, ["read"]);
  assert.equal(r.finish, "tool_calls");
  assert.equal(r.promptTokens, 5000);
  const d = derive(r, 50, 500);
  assert.equal(d.prefillMs, 150, "first byte − lease");
  assert.equal(d.decodeMs, 800);
  assert.equal(d.reasoningDecodeMs, 500);
  assert.equal(d.contentDecodeMs, 300);
  assert.equal(d.estUncachedPromptTokens, 75, "0.15 s × 500 tok/s");
  assert.ok(d.reasoningTokens! > 0 && d.reasoningTokens! < 40);
});

test("tap: reasoning_content and Ollama-native NDJSON with real prefill timings", () => {
  const t1 = new StreamTap(0, () => 5);
  t1.push('data: {"choices":[{"delta":{"reasoning_content":"abc"}}]}\n');
  assert.equal(t1.finish().reasoningChars, 3);
  const t2 = new StreamTap(0, () => 5);
  t2.push('{"message":{"role":"assistant","thinking":"hm"},"done":false}\n{"message":{"content":"hi"},"done":false}\n');
  t2.push('{"done":true,"done_reason":"stop","prompt_eval_count":900,"prompt_eval_duration":1500000000,"eval_count":12,"eval_duration":400000000}\n');
  const r = t2.finish();
  assert.equal(r.reasoningChars, 2);
  assert.equal(r.contentChars, 2);
  assert.equal(r.promptTokens, 900);
  assert.equal(derive(r, 0, 500).prefillMs, 1500, "native prefill duration wins over first-byte timing");
});

test("tap: non-streaming JSON body", () => {
  const tap = new StreamTap(0, () => 1);
  const body = JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello", tool_calls: [{ id: "t", function: { name: "glob", arguments: "{}" } }] }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2 } });
  tap.push(body.slice(0, 30));
  tap.push(body.slice(30));
  const r = tap.finish();
  assert.equal(r.contentChars, 5);
  assert.deepEqual(r.toolCalls, ["glob"]);
  assert.equal(r.promptTokens, 7);
});

test("request kind, session key and tail shape", () => {
  const sys = { role: "system", content: "You are opencode." };
  const agent = { messages: [sys, { role: "user", content: "fix it" }], tools: [{ type: "function", function: { name: "read" } }] };
  assert.equal(requestKind(agent, 30_000, 8000), "agent");
  assert.equal(requestKind({ messages: [{ role: "user", content: "title: fix" }] }, 100, 8000), "helper");
  assert.equal(requestKind({ messages: [sys, { role: "user", content: "x" }, { role: "assistant", content: "y" }] }, 20_000, 8000), "compaction");
  const summary = { messages: [{ role: "system", content: "Summarize the conversation so far." }, { role: "user", content: "a" }, { role: "assistant", content: "b" }] };
  assert.equal(requestKind(summary, 500, 8000), "compaction");
  const titleReq = { messages: [{ role: "system", content: "You are a title generator… a brief title that would help the user find this conversation later; summarize it." }, { role: "user", content: "Generate a title for this conversation:" }, { role: "user", content: "fix the bug" }] };
  assert.equal(requestKind(titleReq, 2700, 8000), "helper", "title requests are not compactions");
  const k1 = sessionKey(agent);
  const k2 = sessionKey({ ...agent, messages: [...agent.messages, { role: "assistant", content: "ok" }] });
  assert.equal(k1, k2, "same conversation → same key as it grows");
  assert.notEqual(k1, sessionKey({ messages: [sys, { role: "user", content: "other task" }] }));
  const shape = tailShape({
    messages: [sys, { role: "user", content: "go" }, { role: "assistant", content: "", tool_calls: [{ id: "c9", function: { name: "edit" } }] }, { role: "tool", tool_call_id: "c9", content: "Error: Could not find oldString in the file" }],
  });
  assert.deepEqual(shape, { messages: 4, lastRole: "tool", lastTool: "edit", lastToolError: true });
});
