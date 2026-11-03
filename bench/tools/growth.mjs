#!/usr/bin/env node
// M9.1 diagnosis: why does the coder grow from ~8 GB at load to 12–17 GB in use?
// Replays the captured OpenCode request, growing it step by step with real file contents as tool
// results, straight against Ollama, and logs /api/ps size after each request.
//   grow     — one session whose prompt keeps growing (shared prefix, like an agent run)
//   distinct — same prompt sizes, but every request has a unique prefix (no reuse possible)
// If memory tracks the number of distinct cached prompts rather than the window, the growth is
// prompt-cache/snapshot build-up, not KV at the context length.
//
// usage: node bench/tools/growth.mjs [--model pitcrew/qwen3.5-9b:32k] [--mode grow|distinct|both] [--steps 10]
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((x) => x.length));
const MODEL = args.model ?? "pitcrew/qwen3.5-9b:32k";
const MODES = (args.mode ?? "both") === "both" ? ["grow", "distinct"] : [args.mode];
const STEPS = Number(args.steps ?? 10);
const OLLAMA = "http://127.0.0.1:11434";
const base = JSON.parse(readFileSync(join(ROOT, "bench/load/opencode-request.json"), "utf8"));

// ~2k-token chunks of real source text to use as tool results.
function sourceFiles(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === "node_modules" || f.startsWith(".")) continue;
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|md|json)$/.test(f)) out.push(p);
  }
  return out;
}
const corpus = sourceFiles(join(ROOT, "src")).map((p) => readFileSync(p, "utf8")).join("\n").slice(0, 400_000);
const chunk = (i) => corpus.slice(i * 8000, (i + 1) * 8000);

async function ps() {
  const j = await (await fetch(`${OLLAMA}/api/ps`)).json();
  return j.models.find((m) => m.name === MODEL)?.size ?? 0;
}
async function unloadAll() {
  const j = await (await fetch(`${OLLAMA}/api/ps`)).json();
  for (const m of j.models) await fetch(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
  await new Promise((r) => setTimeout(r, 3000));
}
async function load() {
  await fetch(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model: MODEL, prompt: "", keep_alive: -1, stream: false }) });
  return ps();
}

function messagesFor(step, nonce) {
  const msgs = structuredClone(base.messages);
  if (nonce) msgs[0].content = `[session ${nonce}]\n` + msgs[0].content;
  for (let i = 0; i < step; i++) {
    msgs.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: `/repo/file${i}.ts` }) } }] });
    msgs.push({ role: "tool", tool_call_id: `c${i}`, content: chunk(i) });
  }
  return msgs;
}

async function send(messages) {
  const t0 = Date.now();
  const r = await fetch(`${OLLAMA}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: base.tools, max_tokens: 8, reasoning_effort: "none", stream: false }),
  });
  const j = await r.json();
  return { ms: Date.now() - t0, promptTokens: j.usage?.prompt_tokens, status: r.status };
}

const out = { model: MODEL, startedAt: new Date().toISOString(), runs: {} };
for (const mode of MODES) {
  await unloadAll();
  const loaded = await load();
  const rows = [{ step: "load", bytes: loaded }];
  console.log(`[${mode}] loaded ${(loaded / 1e9).toFixed(2)} GB`);
  for (let s = 0; s <= STEPS; s++) {
    const r = await send(messagesFor(s, mode === "distinct" ? `${s}-${Math.random().toString(36).slice(2)}` : undefined));
    const bytes = await ps();
    rows.push({ step: s, ...r, bytes });
    console.log(`[${mode}] step ${s}: prompt ${r.promptTokens} tok, ${r.ms} ms → resident ${(bytes / 1e9).toFixed(2)} GB`);
  }
  // Re-send the very first prompt: is it still cached (fast) or evicted?
  const again = await send(messagesFor(0, undefined));
  rows.push({ step: "repeat-0", ...again, bytes: await ps() });
  await unloadAll();
  const reloaded = await load();
  rows.push({ step: "reload", bytes: reloaded });
  console.log(`[${mode}] after reload ${(reloaded / 1e9).toFixed(2)} GB`);
  out.runs[mode] = rows;
}
await unloadAll();
const dir = join(ROOT, "bench", "results", "growth");
mkdirSync(dir, { recursive: true });
const file = join(dir, `growth-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`→ ${file}`);
