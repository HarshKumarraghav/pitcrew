#!/usr/bin/env node
// Minimal OpenAI-compatible server that records every request body and replies "ok".
// Used to measure exactly what a coding agent sends (system prompt, tool schemas) without a model.
// usage: node capture-server.mjs <port> <outdir>
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 11599);
const out = process.argv[3] ?? "/tmp/pitcrew-capture";
mkdirSync(out, { recursive: true });
let n = 0;

createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "capture", object: "model" }] }));
    return;
  }
  const file = join(out, `req-${String(++n).padStart(3, "0")}.json`);
  writeFileSync(file, body);
  const parsed = body ? JSON.parse(body) : {};
  const id = "chatcmpl-capture";
  if (parsed.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "capture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: "assistant", content: "ok" });
    chunk({}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created: 0, model: "capture", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 } }));
  }
}).listen(port, "127.0.0.1", () => console.log(`capture server on 127.0.0.1:${port} → ${out}`));
