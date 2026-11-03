#!/usr/bin/env node
// Reproduce the decode stall seen on 11-04 (Ollama 0.40.11 MLX runner: long prompt prefilled, then
// ~0 tokens for 15 min). Sends a ~19k-token agent prompt with thinking on, cold-loaded each trial,
// alternating model variants (e.g. speculative decoding on vs off). A trial "hangs" if no output
// arrives for --stall seconds.
// usage: node bench/tools/hang-repro.mjs --models a,b [--trials 3] [--steps 6] [--stall 60] [--max 240]
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((x) => x.length));
const MODELS = (args.models ?? "pitcrew/qwen3.5-9b:32k").split(",");
const TRIALS = Number(args.trials ?? 3);
const STEPS = Number(args.steps ?? 6);
const STALL_S = Number(args.stall ?? 60);
const MAX_S = Number(args.max ?? 240);
const OLLAMA = "http://127.0.0.1:11434";
const base = JSON.parse(readFileSync(join(ROOT, "bench/load/opencode-request.json"), "utf8"));
const files = (d, o = []) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) files(p, o); else if (/\.ts$/.test(f)) o.push(p); } return o; };
const corpus = files(join(ROOT, "src")).map((p) => readFileSync(p, "utf8")).join("\n");
function messages(nonce) {
  const msgs = structuredClone(base.messages);
  msgs[0].content = `[trial ${nonce}]\n` + msgs[0].content;
  for (let i = 0; i < STEPS; i++) {
    msgs.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: `/repo/src/file${i}.ts` }) } }] });
    msgs.push({ role: "tool", tool_call_id: `c${i}`, content: corpus.slice(i * 9000, (i + 1) * 9000) });
  }
  msgs.push({ role: "user", content: "Based on these files, find one real bug in the scheduler and propose a minimal fix. Think it through, then call the edit tool." });
  return msgs;
}
async function unloadAll() {
  const j = await (await fetch(`${OLLAMA}/api/ps`)).json();
  for (const m of j.models) await fetch(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
  await new Promise((r) => setTimeout(r, 3000));
}
async function trial(model, n) {
  await unloadAll();
  const t0 = Date.now();
  const ac = new AbortController();
  let first = 0, last = Date.now(), chunks = 0, rchars = 0, cchars = 0, maxGap = 0, usage, hung = false;
  const watchdog = setInterval(() => {
    const gap = (Date.now() - last) / 1000;
    if (first && gap > STALL_S) { hung = true; ac.abort(); }
    if ((Date.now() - t0) / 1000 > MAX_S) ac.abort();
  }, 1000);
  try {
    const res = await fetch(`${OLLAMA}/v1/chat/completions`, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: messages(`${model}-${n}-${Date.now()}`), tools: base.tools, max_tokens: 4096, stream: true, stream_options: { include_usage: true } }) });
    let buf = "";
    for await (const c of res.body) {
      const now = Date.now();
      if (first) maxGap = Math.max(maxGap, (now - last) / 1000);
      first ||= now;
      last = now;
      chunks++;
      buf += Buffer.from(c).toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data: {")) continue;
        const e = JSON.parse(line.slice(6));
        if (e.usage) usage = e.usage;
        for (const ch of e.choices ?? []) { rchars += (ch.delta?.reasoning ?? "").length; cchars += (ch.delta?.content ?? "").length + JSON.stringify(ch.delta?.tool_calls ?? "").length - 2; }
      }
    }
  } catch (e) { if (!ac.signal.aborted) throw e; }
  clearInterval(watchdog);
  const r = { model, trial: n, hung, aborted: ac.signal.aborted, ttfbS: first ? (first - t0) / 1000 : null, wallS: (Date.now() - t0) / 1000, maxGapS: +maxGap.toFixed(1), chunks, reasoningChars: rchars, contentChars: cchars, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens };
  console.log(JSON.stringify(r));
  return r;
}
const out = [];
for (let n = 1; n <= TRIALS; n++) for (const m of MODELS) out.push(await trial(m, n));
await unloadAll();
const dir = join(ROOT, "bench", "results", "hang");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `hang-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(out, null, 2));
for (const m of MODELS) { const rs = out.filter((r) => r.model === m); console.log(`${m}: hung ${rs.filter((r) => r.hung).length}/${rs.length}, max gap ${Math.max(...rs.map((r) => r.maxGapS))} s`); }
