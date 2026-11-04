#!/usr/bin/env node
// Tool-call smoke test for a model before it is trusted with agent work (e.g. a low-bit 27B).
// Sends the real captured OpenCode request (bench/load/opencode-request.json) N times and counts
// valid structured tool calls (declared tool, JSON arguments), calls written as text (what
// router.repairToolCalls would rescue) and plain answers. Prints sizes and timings, never text.
//
// usage: node --experimental-strip-types bench/tools/toolcall-smoke.mjs --model <name> [--n 5] [--url http://127.0.0.1:11434/v1]
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTextToolCalls } from "../../src/server/toolcalls.ts";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
if (!args.model) throw new Error("--model required");
const N = Number(args.n ?? 5);
const URL_ = (args.url ?? "http://127.0.0.1:11434/v1").replace(/\/$/, "");
const HERE = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(HERE, "..", "load", "opencode-request.json"), "utf8"));
const names = new Set(base.tools.map((t) => t.function?.name));

const rows = [];
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  const res = await fetch(`${URL_}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...base, model: args.model, stream: false, max_tokens: Number(args["max-tokens"] ?? 2048) }),
  });
  const ms = Date.now() - t0;
  const body = await res.json().catch(() => ({}));
  const m = body.choices?.[0]?.message ?? {};
  const calls = m.tool_calls ?? [];
  let kind = "answer";
  if (!res.ok) kind = `http ${res.status}`;
  else if (calls.length) {
    const ok = calls.every((c) => names.has(c.function?.name) && (() => { try { JSON.parse(c.function.arguments); return true; } catch { return false; } })());
    kind = ok ? "tool_call" : "bad_tool_call";
  } else if (typeof m.content === "string" && parseTextToolCalls(m.content, base.tools)) kind = "text_tool_call";
  const row = { i: i + 1, kind, ms, tools: calls.map((c) => c.function?.name), promptTokens: body.usage?.prompt_tokens, completionTokens: body.usage?.completion_tokens };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const count = (k) => rows.filter((r) => r.kind === k).length;
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(JSON.stringify({
  model: args.model, n: N,
  validToolCalls: count("tool_call"), textToolCalls: count("text_tool_call"), badToolCalls: count("bad_tool_call"), answers: count("answer"),
  medianMs: ms[Math.floor(ms.length / 2)],
  verdict: count("tool_call") + count("text_tool_call") === N ? "usable (with repair on if any text calls)" : "not reliable for agent work",
}));
