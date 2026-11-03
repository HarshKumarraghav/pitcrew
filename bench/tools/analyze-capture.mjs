#!/usr/bin/env node
// Summarise captured agent requests: how big are the system prompt, tool schemas and messages?
// usage: node analyze-capture.mjs <dir> [charsPerToken]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "/tmp/pitcrew-capture";
const cpt = Number(process.argv[3] ?? 3.2);
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const msgs = r.messages ?? [];
  const sys = msgs.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  const rest = msgs.filter((m) => m.role !== "system").map((m) => JSON.stringify(m.content)).join("\n");
  const tools = JSON.stringify(r.tools ?? []);
  const toolNames = (r.tools ?? []).map((t) => t.function?.name).filter(Boolean);
  const total = sys.length + rest.length + tools.length;
  console.log(
    JSON.stringify(
      {
        file: f,
        model: r.model,
        stream: r.stream,
        max_tokens: r.max_tokens ?? r.max_completion_tokens,
        temperature: r.temperature,
        messages: msgs.length,
        systemChars: sys.length,
        toolSchemaChars: tools.length,
        otherChars: rest.length,
        tools: toolNames,
        estTokens: Math.round(total / cpt),
      },
      null,
      1,
    ),
  );
}
