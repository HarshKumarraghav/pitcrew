// Records the dashboard's event stream while a scripted session runs, for the README GIF and the
// GitHub Pages replay. Dev only, no dependencies.
//
//   node --experimental-strip-types --no-warnings scripts/demo/record.mjs            # mock backend
//   node --experimental-strip-types --no-warnings scripts/demo/record.mjs --ollama   # real Ollama
//
// The default is the mock backend (test/mock-ollama.ts) on a simulated 24 GB machine, so a recording
// never loads or evicts models under a benchmark that is using Ollama. --ollama uses the real
// backend and memory probe; it needs qwen3.5:9b, qwen3.5:0.8b and qwen3.5:2b pulled.
// Either way the trace records which one it was, and the replay banner shows it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../../src/config.ts";
import { createGateway } from "../../src/server/http.ts";
import { MemoryMonitor, defaultProbe } from "../../src/system/memory.ts";
import { startMockOllama } from "../../test/mock-ollama.ts";

const G = 1024 ** 3;
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "site/trace.json");
const real = process.argv.includes("--ollama");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.PITCREW_LOG = "quiet";

let mock;
let probe = defaultProbe();
if (!real) {
  mock = await startMockOllama(
    [
      { name: "qwen3.5:9b", size: 6.6 * G },
      { name: "qwen3.5:2b", size: 1.9 * G },
      { name: "qwen3.5:0.8b", size: 1.0 * G },
    ],
    { tokenDelayMs: 70, loadDelayMs: 2500 },
  );
  // Simulated 24 GB Mac: apps and macOS hold about 13 GB; models take the rest of what they report.
  const loaded = () => [...mock.loaded.values()].reduce((a, b) => a + b, 0);
  probe = {
    async read() {
      return {
        t: Date.now(),
        totalBytes: 24 * G,
        availableBytes: 11 * G - loaded(),
        inactiveBytes: 1.5 * G,
        swapUsedBytes: 3.1 * G,
        swapTotalBytes: 4 * G,
        swapoutPages: 0,
        pageSize: 16384,
        pressure: "normal",
        gpuLimitBytes: 18 * G,
      };
    },
  };
}

const cfg = {
  ...DEFAULTS,
  backend: { ...DEFAULTS.backend, url: real ? DEFAULTS.backend.url : mock.url, parallel: 2 },
  memory: { ...DEFAULTS.memory, pollMs: 250 },
  scheduler: { ...DEFAULTS.scheduler, idleUnloadMs: 9000, backgroundEvictIdleMs: 2000 },
  context: { ...DEFAULTS.context, buckets: [8192, 16384, 32768] },
  router: { ...DEFAULTS.router, mode: "C", coder: "coder", light: "small" },
  models: {
    coder: { model: "qwen3.5:9b", primary: true, parallel: 1, minCtx: 16384, maxCtx: 32768, priority: "interactive" },
    small: { model: "qwen3.5:0.8b", maxCtx: 8192, priority: "interactive", warm: true, parallel: 2 },
    mid: { model: "qwen3.5:2b", maxCtx: 16384, priority: "background", parallel: 2 },
  },
  allowUndeclared: false,
  stateDir: mkdtempSync(join(tmpdir(), "pitcrew-demo-")),
};

const monitor = new MemoryMonitor(probe, cfg.memory);
await monitor.sample();
monitor.start();
const gw = createGateway(cfg, { monitor });
gw.scheduler.start(100);
if (real) gw.lag.start(); // spawn latency is a real measurement; keep it off the simulated machine
await gw.registry.refresh();
await new Promise((r) => gw.server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${gw.server.address().port}`;

// ── capture /governor/events ──
const t0 = Date.now();
const frames = [];
const ac = new AbortController();
const capture = (async () => {
  const res = await fetch(`${base}/governor/events`, { signal: ac.signal });
  const dec = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) frames.push({ at: Date.now() - t0, event, data: JSON.parse(data) });
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") throw e;
  }
})();
await sleep(300);

// ── the scripted session ──
const tools = [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
const ask = (model, content, extra = {}) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content }], ...extra }),
  }).then(async (r) => {
    await r.text();
    if (!r.ok) throw new Error(`${model}: HTTP ${r.status}`);
  });
const agentTurn = (n) => ask("auto", `step ${n}: ${"read the code and fix the failing test. ".repeat(60)}`, { tools, max_tokens: 40 });

await gw.warmUp(); // small helper loads and stays pinned
await sleep(1500);
const first = agentTurn(1); // coder loads, then streams
await sleep(600);
await ask("auto", "Generate a short title for this conversation.", { max_tokens: 12 }); // helper → light model, no wait
await first;
await sleep(1500);
await Promise.all([agentTurn(2), agentTurn(3), agentTurn(4)]); // burst: one slot, the rest queue
await sleep(2500);
await ask("mid", "Summarise the last test run.", { max_tokens: 30 }); // background: evicts the idle coder
await sleep(11000); // idle unload frees mid; the pinned helper stays
ac.abort();
await capture.catch(() => {});

await gw.close();
await mock?.close();

// The dashboard only seeds its log from the first state frame; drop the copies after that.
for (const f of frames.slice(1)) if (f.event === "state") delete f.data.events;
const trace = {
  recordedAt: new Date(t0).toISOString(),
  t0,
  backend: real ? "ollama" : "mock",
  machine: real ? "this machine (measured)" : "simulated 24 GB Mac",
  durationMs: Date.now() - t0,
  frames,
};
writeFileSync(out, JSON.stringify(trace));
console.log(`${frames.length} frames, ${(trace.durationMs / 1000).toFixed(1)} s, backend ${trace.backend} → ${out}`);
const logs = frames.filter((f) => f.event === "log");
for (const f of logs) console.log(`${(f.at / 1000).toFixed(1).padStart(5)}s  ${f.data.type.padEnd(8)} ${f.data.msg}`);
process.exit(0);
