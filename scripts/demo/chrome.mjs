// Minimal headless-Chrome driver over the DevTools protocol (Node ≥ 22 built-in WebSocket).
// Shared by gif.mjs and shot.mjs. Dev only.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const CANDIDATES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export async function launch({ width = 1280, height = 800 } = {}) {
  const bin = CANDIDATES.find((p) => p && existsSync(p));
  if (!bin) throw new Error("Chrome not found; set CHROME=/path/to/chrome");
  const profile = mkdtempSync(join(tmpdir(), "pitcrew-chrome-"));
  const proc = spawn(bin, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", `--window-size=${width},${height}`, "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const wsUrl = await new Promise((res, rej) => {
    let err = "";
    proc.stderr.on("data", (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) res(m[1]);
    });
    proc.on("exit", (c) => rej(new Error(`chrome exited ${c}: ${err.slice(-500)}`)));
  });
  const port = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(`${msg.error.message}`)) : res(msg.result);
    } else if (msg.method) for (const fn of handlers.get(msg.method) ?? []) fn(msg.params);
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      pending.set(++id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, fn) => handlers.set(method, [...(handlers.get(method) ?? []), fn]);

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

  return {
    send,
    on,
    async goto(url) {
      const loaded = new Promise((r) => on("Page.loadEventFired", r));
      await send("Page.navigate", { url });
      await loaded;
    },
    async screenshot() {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      return Buffer.from(data, "base64");
    },
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return r.result.value;
    },
    async close() {
      ws.close();
      proc.kill();
      await new Promise((r) => proc.once("exit", r));
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Chrome's helper processes can still be writing to the temp profile; the OS cleans it up.
      }
    },
  };
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".gif": "image/gif" };

/** Serve a directory on 127.0.0.1 (fetch() does not work from file:// pages). */
export async function serveDir(dir) {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(dir, path.endsWith("/") ? `${path}index.html` : path);
    if (!file.startsWith(dir) || !existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}
