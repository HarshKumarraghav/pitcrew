#!/usr/bin/env node
// Scripted fake OpenAI-compatible model: answers agent requests (those with tools) with a fixed
// sequence of tool calls and records every request body. Shows exactly how a coding agent sends
// tool results and errors back, without running a model.
// usage: node script-server.mjs <port> <outdir> <script.json>
//   script.json: [{ "tool": "read", "args": { "filePath": "…" } }, …, { "text": "done" }]
import { createServer } from "node:http";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 11598);
const out = process.argv[3] ?? "/tmp/pitcrew-script";
const script = JSON.parse(readFileSync(process.argv[4], "utf8"));
mkdirSync(out, { recursive: true });
let n = 0;
let step = 0;

createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "script", object: "model" }] }));
  }
  const parsed = body ? JSON.parse(body) : {};
  writeFileSync(join(out, `req-${String(++n).padStart(3, "0")}.json`), body);
  const agent = Array.isArray(parsed.tools) && parsed.tools.length > 0;
  const item = agent ? (script[step++] ?? { text: "done" }) : { text: "Scripted title" };
  const id = "chatcmpl-script";
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish = null) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "script", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (item.tool) {
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name: item.tool, arguments: JSON.stringify(item.args) } }] });
    chunk({}, "tool_calls");
  } else {
    chunk({ role: "assistant", content: item.text });
    chunk({}, "stop");
  }
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}).listen(port, "127.0.0.1", () => console.log(`script server on ${port} → ${out}`));
