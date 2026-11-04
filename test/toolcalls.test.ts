import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTextToolCalls, ToolCallRepair } from "../src/server/toolcalls.ts";

const fn = (name: string, properties: Record<string, unknown>) => ({ type: "function", function: { name, parameters: { type: "object", properties } } });
const TOOLS = [
  fn("read", { filePath: { type: "string" }, offset: { type: "number" }, limit: { type: "integer" } }),
  fn("edit", { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" }, replaceAll: { type: "boolean" } }),
  fn("todowrite", { todos: { type: "array" } }),
];

// The assistant text from bench/agent/results/pitcrew-levers-all-r1/L (no opening <tool_call>).
const L_TEXT = ["paginate.ts", "task.ts", "client.ts", "paginate.test.ts"]
  .map((f) => `<function=read>\n<parameter=filePath>\n/private/tmp/qbench/L/src/${f}\n</parameter>\n</function>\n</tool_call>`)
  .join("\n");

const xml = (name: string, params: Record<string, string>, opener = true) =>
  `${opener ? "<tool_call>\n" : ""}<function=${name}>\n${Object.entries(params).map(([k, v]) => `<parameter=${k}>\n${v}\n</parameter>\n`).join("")}</function>\n</tool_call>`;

test("parse: the real L leak becomes four read calls", () => {
  const p = parseTextToolCalls(L_TEXT, TOOLS);
  assert.ok(p);
  assert.equal(p.content, "");
  assert.deepEqual(p.calls.map((c) => c.name), ["read", "read", "read", "read"]);
  assert.deepEqual(JSON.parse(p.calls[0]!.arguments), { filePath: "/private/tmp/qbench/L/src/paginate.ts" });
});

test("parse: Qwen XML with and without the opener, several calls, prose before", () => {
  const a = xml("read", { filePath: "/a.ts" });
  const b = xml("read", { filePath: "/b.ts" }, false);
  assert.deepEqual(parseTextToolCalls(a, TOOLS)?.calls, [{ name: "read", arguments: '{"filePath":"/a.ts"}' }]);
  assert.deepEqual(parseTextToolCalls(b, TOOLS)?.calls, [{ name: "read", arguments: '{"filePath":"/b.ts"}' }]);
  assert.equal(parseTextToolCalls(`${a}\n${b}\n${a}`, TOOLS)?.calls.length, 3);
  const p = parseTextToolCalls(`I'll read the file.\n${a}`, TOOLS);
  assert.equal(p?.content, "I'll read the file.\n");
  assert.equal(p?.calls.length, 1);
});

test("parse: Hermes JSON and bare JSON", () => {
  const h = parseTextToolCalls('<tool_call>\n{"name": "read", "arguments": {"filePath": "/a.ts"}}\n</tool_call>', TOOLS);
  assert.deepEqual(h?.calls, [{ name: "read", arguments: '{"filePath":"/a.ts"}' }]);
  const two = parseTextToolCalls('<tool_call>{"name":"read","arguments":{"filePath":"/a"}}</tool_call>\n<tool_call>{"name":"read","arguments":"{\\"filePath\\":\\"/b\\"}"}</tool_call>', TOOLS);
  assert.deepEqual(two?.calls.map((c) => JSON.parse(c.arguments).filePath), ["/a", "/b"]);
  assert.deepEqual(parseTextToolCalls('  {"name":"read","arguments":{"filePath":"/a.ts"}}\n', TOOLS)?.calls, [{ name: "read", arguments: '{"filePath":"/a.ts"}' }]);
  // Bare JSON only when it is the whole message; JSON in prose is an answer, not a call.
  assert.equal(parseTextToolCalls('Here: {"name":"read","arguments":{"filePath":"/a.ts"}}', TOOLS), null);
  assert.equal(parseTextToolCalls('{"name":"read"}', TOOLS), null, "no arguments");
});

// The assistant text from the failed e2e check (OpenCode → Pit Crew, 2026-11-04).
const E2E_TEXT = '```json\n{\n  "tool_call": "bash",\n  "command": "cat > src/version.ts << \'EOF\'\\nexport const VERSION = \\"0.3.0\\";\\nEOF\\n"\n}\n```';
const BASH = [...TOOLS, fn("bash", { command: { type: "string" }, description: { type: "string" } })];

test("parse: a fenced JSON call with flat arguments (the e2e failure)", () => {
  const p = parseTextToolCalls(E2E_TEXT, BASH);
  assert.equal(p?.calls[0]?.name, "bash");
  assert.deepEqual(JSON.parse(p!.calls[0]!.arguments), { command: "cat > src/version.ts << 'EOF'\nexport const VERSION = \"0.3.0\";\nEOF\n" });
  assert.equal(parseTextToolCalls('```\n{"name":"read","parameters":{"filePath":"/a"}}\n```', TOOLS)?.calls[0]?.arguments, '{"filePath":"/a"}');
  // Flat keys must all be parameters of the named tool; the fence must be the whole message.
  assert.equal(parseTextToolCalls('{"tool_call":"bash","command":"ls","sudo":true}', BASH), null);
  assert.equal(parseTextToolCalls(`Run this:\n${E2E_TEXT}`, BASH), null);
  assert.equal(parseTextToolCalls('```json\n{"command":"ls"}\n```', BASH), null, "no tool named");
  assert.equal(parseTextToolCalls("```ts\nexport const VERSION = 1;\n```", BASH), null);
});

test("parse: unknown tool names, malformed XML and no tools stay untouched", () => {
  assert.equal(parseTextToolCalls(xml("delete_everything", { path: "/" }), TOOLS), null);
  assert.equal(parseTextToolCalls('{"name":"delete_everything","arguments":{}}', TOOLS), null);
  assert.equal(parseTextToolCalls("<function=read>\n<parameter=filePath>\n/a.ts\n</function>", TOOLS), null, "unclosed parameter");
  assert.equal(parseTextToolCalls("<function=read>\n<parameter=filePath>\n/a.ts\n</parameter>\n", TOOLS), null, "no </function>");
  assert.equal(parseTextToolCalls(`${xml("read", { filePath: "/a" })}\nand then I will edit it`, TOOLS), null, "trailing prose");
  assert.equal(parseTextToolCalls(xml("read", { filePath: "/a" }), []), null);
  assert.equal(parseTextToolCalls(xml("read", { filePath: "/a" }), undefined), null);
  assert.equal(parseTextToolCalls("Use `<function=` tags like this.", TOOLS), null);
});

test("parse: values are coerced by the tool's JSON schema", () => {
  const p = parseTextToolCalls(xml("read", { filePath: "/a.ts", offset: "10", limit: " 20 " }), TOOLS);
  assert.deepEqual(JSON.parse(p!.calls[0]!.arguments), { filePath: "/a.ts", offset: 10, limit: 20 });
  const e = parseTextToolCalls(xml("edit", { filePath: "/a", oldString: "  a\n  b", newString: "x\n", replaceAll: "true" }), TOOLS);
  // One surrounding newline is trimmed from strings; inner whitespace is kept.
  assert.deepEqual(JSON.parse(e!.calls[0]!.arguments), { filePath: "/a", oldString: "  a\n  b", newString: "x\n", replaceAll: true });
  const t = parseTextToolCalls(xml("todowrite", { todos: '[{"content":"x","status":"pending"}]' }), TOOLS);
  assert.deepEqual(JSON.parse(t!.calls[0]!.arguments).todos, [{ content: "x", status: "pending" }]);
  assert.equal(parseTextToolCalls(xml("read", { filePath: "/a", offset: "ten" }), TOOLS), null, "a number that is not JSON fails the whole parse");
  const u = parseTextToolCalls(xml("read", { filePath: "/a", extra: "42" }), TOOLS);
  assert.equal(JSON.parse(u!.calls[0]!.arguments).extra, "42", "undeclared parameters stay strings");
});

// ─────────────── streaming ───────────────

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usage = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\n`;
const DONE = "data: [DONE]\n\n";

/** An SSE stream that writes `text` as content in pieces of `step` characters. */
function stream(text: string, step = 5, opts: { reasoning?: string } = {}): string {
  let s = "";
  if (opts.reasoning) s += chunk({ role: "assistant", reasoning: opts.reasoning });
  for (let i = 0; i < text.length; i += step) s += chunk({ content: text.slice(i, i + step) });
  return s + chunk({ content: "" }, "stop") + usage + DONE;
}

function run(input: string, tools: unknown = TOOLS, split?: number[]): { out: string; repaired: number } {
  const r = new ToolCallRepair(tools, true);
  const bytes = Buffer.from(input);
  const cuts = split ?? [bytes.length];
  const parts: Buffer[] = [];
  let at = 0;
  for (const c of [...cuts, bytes.length]) {
    if (c <= at) continue;
    parts.push(r.push(bytes.subarray(at, c)));
    at = c;
  }
  parts.push(r.finish());
  return { out: Buffer.concat(parts).toString("utf8"), repaired: r.repaired };
}

function events(out: string) {
  const ev = out.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
  const choices = ev.flatMap((e) => e.choices as { delta: Record<string, unknown>; finish_reason: string | null }[]);
  return {
    content: choices.map((c) => c.delta?.content ?? "").join(""),
    reasoning: choices.map((c) => c.delta?.reasoning ?? "").join(""),
    toolCalls: choices.flatMap((c) => (c.delta?.tool_calls as { id: string; function: { name: string; arguments: string } }[]) ?? []),
    finish: choices.map((c) => c.finish_reason).filter(Boolean),
    usage: ev.filter((e) => e.usage).length,
    done: out.includes("data: [DONE]"),
  };
}

test("stream: prose streams live, the call becomes tool_calls with finish tool_calls", () => {
  const text = `I'll read the files.\n${xml("read", { filePath: "/tmp/L/src/utils/paginate.ts" }, false)}`;
  const { out, repaired } = run(stream(text));
  const e = events(out);
  assert.equal(repaired, 1);
  assert.equal(e.content, "I'll read the files.\n");
  assert.equal(e.toolCalls.length, 1);
  assert.match(e.toolCalls[0]!.id, /^call_pc_/);
  assert.equal(e.toolCalls[0]!.function.name, "read");
  assert.deepEqual(JSON.parse(e.toolCalls[0]!.function.arguments), { filePath: "/tmp/L/src/utils/paginate.ts" });
  assert.deepEqual(e.finish, ["tool_calls"]);
  assert.equal(e.usage, 1);
  assert.ok(e.done);
  assert.ok(out.endsWith(usage + DONE), "usage and [DONE] pass through unchanged");
});

test("stream: prose before a call is sent before the call starts (live, not at the end)", () => {
  const r = new ToolCallRepair(TOOLS, true);
  const first = r.push(Buffer.from(chunk({ content: "Reading it now. " }))).toString();
  assert.equal(events(first).content, "Reading it now. ");
  // A partial marker is held back, then released when it turns out not to be one.
  const held = r.push(Buffer.from(chunk({ content: "a <tool" }))).toString();
  assert.equal(events(held).content, "a ");
  const rel = r.push(Buffer.from(chunk({ content: "s> list" }))).toString();
  assert.equal(events(rel).content, "<tools> list");
});

test("stream: the real L leak becomes four tool calls and ids are unique", () => {
  const { out, repaired } = run(stream(L_TEXT, 9));
  const e = events(out);
  assert.equal(repaired, 4);
  assert.equal(e.content, "");
  assert.equal(new Set(e.toolCalls.map((t) => t.id)).size, 4);
  assert.deepEqual(e.toolCalls.map((t) => (t as unknown as { index: number }).index), [0, 1, 2, 3]);
});

test("stream: Hermes and bare JSON", () => {
  assert.equal(run(stream('<tool_call>{"name":"read","arguments":{"filePath":"/a"}}</tool_call>')).repaired, 1);
  const bare = run(stream('\n{"name": "read", "arguments": {"filePath": "/a"}}', 4));
  assert.equal(bare.repaired, 1);
  assert.equal(events(bare.out).content, "\n");
  // A JSON answer that is not a call is held, then flushed unchanged.
  const ans = run(stream('{"result": 42, "ok": true}'));
  assert.equal(ans.repaired, 0);
  assert.equal(events(ans.out).content, '{"result": 42, "ok": true}');
  assert.deepEqual(events(ans.out).finish, ["stop"]);
});

test("stream: the e2e fenced JSON call is repaired; a fenced code answer passes unchanged", () => {
  const { out, repaired } = run(stream(E2E_TEXT, 2), BASH);
  const e = events(out);
  assert.equal(repaired, 1);
  assert.equal(e.content, "");
  assert.equal(e.toolCalls[0]!.function.name, "bash");
  assert.deepEqual(e.finish, ["tool_calls"]);
  const code = "```ts\nexport const VERSION = 1;\n```\nThat adds it.";
  const c = run(stream(code, 2), BASH);
  assert.equal(c.repaired, 0);
  assert.equal(events(c.out).content, code);
  assert.deepEqual(events(c.out).finish, ["stop"]);
  // A single backtick at the start is only held until it turns out to be inline code.
  assert.equal(events(run(stream("`x` is set", 1), BASH).out).content, "`x` is set");
});

test("stream: unknown tools and malformed XML are flushed as text, finish unchanged", () => {
  for (const text of [`ok ${xml("delete_everything", { path: "/" })}`, "Look: <function=read>\n<parameter=filePath>\n/a\n</function> done"]) {
    const { out, repaired } = run(stream(text, 3));
    const e = events(out);
    assert.equal(repaired, 0);
    assert.equal(e.content, text);
    assert.equal(e.toolCalls.length, 0);
    assert.deepEqual(e.finish, ["stop"]);
  }
});

test("stream: native tool_calls are never doubled", () => {
  const s =
    chunk({ content: xml("read", { filePath: "/a" }) }) +
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"filePath":"/a"}' } }] }, "tool_calls") +
    DONE;
  const e = events(run(s).out);
  assert.equal(e.toolCalls.length, 1);
  assert.equal(e.toolCalls[0]!.id, "call_1");
});

test("stream: splitting at every byte boundary gives the same output", () => {
  const input = stream(`Plan: read then edit ✓.\n${xml("edit", { filePath: "/a", oldString: "é", newString: "e", replaceAll: "false" })}`, 6, { reasoning: "think ✓" });
  const norm = (s: string) => s.replace(/call_pc_[0-9a-f]+_/g, "call_pc_X_");
  const whole = norm(run(input).out);
  const n = Buffer.byteLength(input);
  for (let cut = 1; cut < n; cut++) assert.equal(norm(run(input, TOOLS, [cut]).out), whole, `cut at ${cut}`);
  // And byte by byte.
  assert.equal(norm(run(input, TOOLS, Array.from({ length: n }, (_, i) => i + 1)).out), whole);
  assert.equal(events(whole).toolCalls.length, 1);
});

test("stream: reasoning deltas and plain answers pass through byte for byte", () => {
  const plain = stream("Here is the answer, no tools needed.", 4, { reasoning: "thinking about <tool_call> syntax" });
  assert.equal(run(plain).out, plain);
  const e = events(run(stream(xml("read", { filePath: "/a" }), 5, { reasoning: "hmm" })).out);
  assert.equal(e.reasoning, "hmm");
  assert.equal(e.toolCalls.length, 1);
});

test("stream: no tools in the request → byte-identical, even for call-shaped text", () => {
  const input = stream(L_TEXT);
  for (const tools of [undefined, []]) {
    const r = new ToolCallRepair(tools, true);
    assert.equal(Buffer.concat([r.push(Buffer.from(input)), r.finish()]).toString(), input);
    assert.equal(r.repaired, 0);
  }
});

test("stream: a stream cut off before its finish event flushes held text", () => {
  const s = chunk({ content: "x " }) + chunk({ content: "<function=read>\n<parameter=filePath>" });
  const e = events(run(s).out);
  assert.equal(e.content, "x <function=read>\n<parameter=filePath>");
});

test("non-streaming: message content is rewritten into tool_calls", () => {
  const body = { id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: `Sure.\n${L_TEXT}` }, finish_reason: "stop" }], usage: { prompt_tokens: 1 } };
  const r = new ToolCallRepair(TOOLS, false);
  assert.equal(r.push(Buffer.from(JSON.stringify(body))).length, 0);
  const out = JSON.parse(r.finish().toString());
  assert.equal(out.choices[0].message.content, "Sure.\n");
  assert.equal(out.choices[0].message.tool_calls.length, 4);
  assert.equal(out.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(out.usage, { prompt_tokens: 1 });
  // Plain answers and error bodies come back byte for byte.
  for (const raw of [JSON.stringify({ ...body, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }), '{"error":"boom"}', "not json"]) {
    const p = new ToolCallRepair(TOOLS, false);
    p.push(Buffer.from(raw));
    assert.equal(p.finish().toString(), raw);
  }
});
