import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJob, type Config, type Priority } from "../config.ts";
import { OllamaClient, BackendError } from "../backend/ollama.ts";
import { runJob, type JobSpec } from "../backend/jobs.ts";
import { Registry, ModelError, DERIVED_NS, derivedName, type Resolved } from "../models/registry.ts";
import { Scheduler, SchedulerError, type Lease, type MemoryView } from "../scheduler/scheduler.ts";
import { MemoryMonitor } from "../system/memory.ts";
import { Metrics } from "./metrics.ts";
import { chooseContext, promptChars, requestedOutput, TokenCalibrator } from "./context.ts";
import { route } from "./router.ts";
import { StreamTap, RequestLog, derive, requestKind, sessionKey, tailShape, type RequestRecord } from "./telemetry.ts";

const GiB = 1024 ** 3;
const MAX_BODY = 64 * 1024 * 1024;

export interface Gateway {
  server: Server;
  scheduler: Scheduler;
  registry: Registry;
  monitor: MemoryMonitor;
  metrics: Metrics;
  /** Load and pin `warm` aliases; probes the backend's parallel slots on the first one. */
  warmUp(): Promise<void>;
  close(): Promise<void>;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorBody(message: string, type = "pitcrew_error") {
  return { error: { message, type } };
}

/** Find the last `"usage":{...}` object in a (possibly SSE) response tail. */
export function extractUsage(tail: string): { prompt_tokens?: number; completion_tokens?: number } | undefined {
  const re = /"usage"\s*:\s*(\{[^{}]*\})/g;
  let m: RegExpExecArray | null;
  let last: string | undefined;
  while ((m = re.exec(tail))) last = m[1];
  // Ollama-native responses report prompt_eval_count / eval_count instead.
  if (!last) {
    const p = /"prompt_eval_count"\s*:\s*(\d+)/.exec(tail);
    const c = /"eval_count"\s*:\s*(\d+)/.exec(tail);
    return p ? { prompt_tokens: Number(p[1]), completion_tokens: c ? Number(c[1]) : undefined } : undefined;
  }
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}

export function createGateway(cfg: Config, deps: { client?: OllamaClient; monitor: MemoryMonitor }): Gateway {
  const client = deps.client ?? new OllamaClient(cfg.backend.url);
  const monitor = deps.monitor;
  const registry = new Registry(cfg, client);
  const metrics = new Metrics();
  const tokens = new TokenCalibrator(cfg.context.charsPerToken);
  /** base model → currently loaded derived variant. */
  const loadedVariant = new Map<string, string>();
  const jobPeak = new Map<string, number>();
  const reqLog = cfg.telemetry.enabled ? new RequestLog(cfg.telemetry.path ?? join(cfg.stateDir, "requests.jsonl")) : undefined;

  const memView = (): MemoryView | undefined => {
    const s = monitor.latest;
    if (!s) return undefined;
    return {
      t: s.t,
      totalBytes: s.totalBytes,
      availableBytes: s.availableBytes,
      inactiveBytes: s.inactiveBytes,
      gpuLimitBytes: s.gpuLimitBytes,
      state: monitor.state,
      thrashing: monitor.thrashing,
    };
  };
  const scheduler = new Scheduler(
    {
      policy: cfg.memory.policy,
      osReserveBytes: cfg.memory.osReserveGiB * GiB,
      minFreeBytes: cfg.memory.minFreeGiB * GiB,
      maxModelBytes: cfg.memory.maxModelMemoryGiB ? cfg.memory.maxModelMemoryGiB * GiB : undefined,
      maxConcurrent: cfg.scheduler.maxConcurrent,
      queueTimeoutMs: cfg.scheduler.queueTimeoutMs,
      idleUnloadMs: cfg.scheduler.idleUnloadMs,
      strictPriority: cfg.scheduler.strictPriority,
      fastLane: cfg.scheduler.fastLane,
      backgroundEvictIdleMs: cfg.scheduler.backgroundEvictIdleMs,
    },
    memView,
    () => monitor.sample(),
  );

  // Metrics gauges read live state.
  metrics.gauge("pitcrew_memory_available_bytes", () => monitor.latest?.availableBytes, "Memory available without pushing apps to swap (measured)");
  metrics.gauge("pitcrew_swap_used_bytes", () => monitor.latest?.swapUsedBytes, "Swap in use (measured)");
  metrics.gauge("pitcrew_swapout_bytes_per_second", () => monitor.swapoutBps, "Smoothed swap-out rate (measured)");
  metrics.gauge("pitcrew_model_committed_bytes", () => scheduler.committed(), "Memory charged to resident models (measured when known, else estimated)");
  metrics.gauge("pitcrew_queue_depth", () => scheduler.snapshot().queue.length, "Requests waiting");
  metrics.gauge("pitcrew_running", () => scheduler.snapshot().running, "Requests running");
  scheduler.onEvent((e) => {
    if (e.type === "loaded") metrics.inc("pitcrew_model_loads_total", { model: e.key ?? "" }, 1, "Model loads");
    if (e.type === "evict") metrics.inc("pitcrew_evictions_total", { model: e.key ?? "" }, 1, "Evictions");
    if (process.env.PITCREW_LOG !== "quiet") console.log(`${new Date(e.t).toISOString().slice(11, 19)} ${e.type.padEnd(7)} ${e.msg}`);
  });

  // ─────────────── lease helpers ───────────────

  /**
   * Slots the backend gives every loaded model (OLLAMA_NUM_PARALLEL). The backend allocates KV
   * for all of them, so memory estimates use this; per-model request caps never exceed it.
   */
  let serverParallel = cfg.backend.parallel === "auto" ? 1 : cfg.backend.parallel;
  let parallelSource = cfg.backend.parallel !== "auto" ? "config" : cfg.backend.managed ? "managed (auto → 1)" : "not probed yet";

  function slotsFor(r: Resolved, weightsBytes: number): number {
    const want = r.spec.parallel ?? (r.spec.primary || weightsBytes > 3.5 * GiB ? 1 : 2);
    return Math.max(1, Math.min(want, serverParallel));
  }

  function priorityOf(req: IncomingMessage, fallback: Priority): Priority {
    const h = String(req.headers["x-pitcrew-priority"] ?? "").toLowerCase();
    return h === "background" || h === "interactive" ? h : fallback;
  }

  async function leaseLlm(r: Resolved, ctx: number, priority: Priority, signal: AbortSignal): Promise<Lease> {
    const fp = await registry.footprint(r.base);
    const parallel = slotsFor(r, fp.weightsBytes);
    const kvSlots = serverParallel;
    return scheduler.acquire({
      key: r.base,
      kind: "llm",
      priority,
      ctx,
      estimate: (c) => fp.estimate(c, kvSlots),
      parallel,
      pin: r.spec.pin || r.spec.warm,
      policy: r.spec.primary ? "aggressive" : undefined,
      signal,
      label: r.alias ? `${r.alias}(${r.base})` : r.base,
      ops: {
        load: async (c) => {
          const variant = await registry.ensureVariant(r, c);
          await client.load(variant, -1);
          loadedVariant.set(r.base, variant);
          const ps = await client.ps().catch(() => []);
          const hit = ps.find((m) => m.name === variant || m.model === variant);
          if (hit?.size) {
            registry.calibrate(r.base, { ctx: c, parallel: kvSlots, bytes: hit.size });
            return { bytes: hit.size };
          }
          return {};
        },
        unload: async () => {
          const v = loadedVariant.get(r.base);
          if (v) await client.unload(v);
          loadedVariant.delete(r.base);
        },
      },
    });
  }

  /** Resident already, or would load without evicting anything (router mode C). */
  async function canHost(alias: string): Promise<boolean> {
    const spec = cfg.models[alias];
    if (!spec || isJob(spec)) return false;
    let base: string;
    try {
      base = (await registry.resolve(alias)).base;
    } catch {
      return false;
    }
    const u = scheduler.units.get(base);
    if (u?.state === "ready" || u?.state === "loading") return true;
    const fp = await registry.footprint(base);
    const need = fp.estimate(spec.minCtx ?? cfg.context.buckets[0] ?? 8192, serverParallel);
    return scheduler.admission(base, need, "background").kind === "fits";
  }

  // ─────────────── route handlers ───────────────

  async function proxyModelRequest(req: IncomingMessage, res: ServerResponse, path: string, kind: "openai" | "native" | "embed"): Promise<void> {
    const receivedAt = Date.now();
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    let requested = String(body.model ?? "");
    if (!requested) throw new HttpError(400, "model is required");
    const chars = promptChars(body);
    // Telemetry facts are taken from the request as the client sent it (before any router patch).
    const reqKind = requestKind(body, chars, cfg.router.helperMaxPromptChars);
    const session = sessionKey(body);
    const tail = tailShape(body);
    let routeInfo: string | undefined;
    if (requested === cfg.router.name && kind !== "embed") {
      const lightFits = cfg.router.mode === "C" && cfg.router.light ? await canHost(cfg.router.light) : false;
      const d = route(body, chars, cfg.router, () => lightFits);
      requested = d.alias;
      Object.assign(body, d.patch);
      routeInfo = `${d.role}->${d.alias} (${d.why.replace(/→/g, "->")})`;
      metrics.inc("pitcrew_routed_total", { role: d.role, alias: d.alias }, 1, "Router decisions");
    }
    const r = await registry.resolve(requested);

    const promptTokens = tokens.tokens(r.base, chars);
    const outTokens = kind === "embed" ? 0 : requestedOutput(body, cfg.context.defaultMaxOutput);
    const choice = chooseContext({
      promptTokens,
      outputTokens: outTokens,
      buckets: cfg.context.buckets,
      minCtx: r.spec.minCtx,
      maxCtx: r.spec.maxCtx,
    });
    if (!choice.ok) {
      throw new HttpError(400, `context too large: ~${choice.needTokens} tokens needed (prompt ~${promptTokens} + output ${outTokens}), model limit ${choice.maxCtx}. Pit Crew refuses rather than silently truncating.`);
    }

    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    const t0 = Date.now();
    const priority = priorityOf(req, r.priority);
    const lease = await leaseLlm(r, choice.ctx, priority, ac.signal);
    const leaseMs = Date.now() - receivedAt;
    const variant = loadedVariant.get(r.base) ?? derivedName(r.base, lease.ctx, r.spec.parameters ?? {});
    const tap = new StreamTap(receivedAt);
    let status: RequestRecord["status"] = "error";
    let ok = false;
    try {
      const fwd: Record<string, unknown> = { ...body, model: variant };
      if (kind === "native") {
        // The derived model carries num_ctx; a per-request value would force a reload.
        const opts = { ...((body.options ?? {}) as Record<string, unknown>) };
        delete opts.num_ctx;
        fwd.options = opts;
        fwd.keep_alive = -1;
      }
      if (kind === "openai" && body.stream) {
        fwd.stream_options = { include_usage: true, ...((body.stream_options ?? {}) as object) };
      }
      const upstream = await fetch(cfg.backend.url.replace(/\/$/, "") + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fwd),
        signal: ac.signal,
      });
      const headers: Record<string, string> = {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "x-pitcrew-model": variant,
        "x-pitcrew-ctx": String(lease.ctx),
        "x-pitcrew-queued-ms": String(lease.queuedMs),
        ...(routeInfo ? { "x-pitcrew-route": routeInfo } : {}),
      };
      res.writeHead(upstream.status, headers);
      status = upstream.status;
      let tail = "";
      let first = true;
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          if (first) {
            first = false;
            metrics.observe("pitcrew_ttft_seconds", (Date.now() - t0) / 1000, { model: r.base }, undefined, "Time from request to first upstream byte, incl. queue + load (measured)");
          }
          res.write(chunk);
          tap.push(chunk);
          tail = (tail + Buffer.from(chunk).toString("utf8")).slice(-8192);
        }
      }
      res.end();
      ok = upstream.ok;
      const usage = extractUsage(tail);
      if (usage?.prompt_tokens) {
        tokens.observe(r.base, chars, usage.prompt_tokens);
        if (usage.prompt_tokens > lease.ctx * 0.97) {
          console.warn(`[pitcrew] ${r.base}: prompt used ${usage.prompt_tokens}/${lease.ctx} tokens — near the window limit`);
        }
      }
      metrics.inc("pitcrew_requests_total", { model: r.base, status: String(upstream.status) }, 1, "Requests forwarded");
      metrics.observe("pitcrew_request_seconds", (Date.now() - t0) / 1000, { model: r.base }, undefined, "End-to-end request time (measured)");
    } catch (e) {
      if (ac.signal.aborted) {
        status = "aborted";
        metrics.inc("pitcrew_requests_total", { model: r.base, status: "aborted" });
      } else throw e;
    } finally {
      lease.release({ ok });
      if (reqLog && kind !== "embed") {
        const t = tap.finish();
        const endAt = receivedAt + (t.endMs ?? Date.now() - receivedAt);
        void reqLog.write({
          t: new Date(receivedAt).toISOString(),
          tMs: receivedAt,
          path,
          requested: String(body.model ?? ""),
          alias: r.alias,
          base: r.base,
          variant,
          kind: reqKind,
          step: routeInfo?.split(" ")[0],
          session,
          priority,
          ctx: lease.ctx,
          promptChars: chars,
          tail,
          stream: Boolean(body.stream),
          status,
          leaseMs,
          queuedMs: lease.queuedMs,
          firstByteMs: t.firstByteMs,
          firstReasoningMs: t.firstReasoningMs,
          firstContentMs: t.firstContentMs,
          endMs: t.endMs,
          gapMs: reqLog.gap(session, receivedAt, endAt),
          promptTokens: t.promptTokens,
          completionTokens: t.completionTokens,
          reasoningTokens: t.reasoningTokens,
          reasoningChars: t.reasoningChars,
          contentChars: t.contentChars,
          toolCalls: t.toolCalls,
          finish: t.finish,
          ...derive(t, leaseMs, cfg.telemetry.coldPrefillTokPerS),
        });
      }
    }
  }

  async function handleJob(req: IncomingMessage, res: ServerResponse, endpoint: JobSpec["endpoint"]): Promise<void> {
    const raw = await readBody(req);
    const ct = String(req.headers["content-type"] ?? "");
    let body: Record<string, unknown> = {};
    if (ct.includes("application/json")) {
      try {
        body = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        throw new HttpError(400, "invalid JSON body");
      }
    }
    const model = String(body.model ?? req.headers["x-pitcrew-model"] ?? "");
    const spec = cfg.models[model];
    if (!isJob(spec) || spec.endpoint !== endpoint) {
      const options = Object.entries(cfg.models).filter(([, s]) => isJob(s) && s.endpoint === endpoint).map(([k]) => k);
      throw new HttpError(404, `no ${endpoint} model "${model}"; configured: ${options.join(", ") || "none"}`);
    }
    const [w, h] = String(body.size ?? "").split("x").map(Number);
    const vars: Record<string, string | number | undefined> = {
      prompt: body.prompt as string | undefined,
      input: body.input as string | undefined,
      voice: body.voice as string | undefined,
      speed: body.speed as number | undefined,
      seed: body.seed as number | undefined,
      steps: body.steps as number | undefined,
      width: w || undefined,
      height: h || undefined,
    };
    for (const k of Object.keys(vars)) if (vars[k] === undefined) delete vars[k];
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    const estimate = jobPeak.get(model) ?? spec.memoryGiB * GiB;
    const lease = await scheduler.acquire({
      key: `job:${model}`,
      kind: "job",
      priority: priorityOf(req, spec.priority ?? "background"),
      ctx: 0,
      estimate: () => estimate,
      parallel: 1,
      signal: ac.signal,
      label: `${model}(${endpoint})`,
      ops: { load: async () => undefined, unload: async () => undefined },
    });
    let ok = false;
    try {
      const result = await runJob(spec, vars, ac.signal);
      ok = true;
      if (result.peakRssBytes > 0) {
        // Keep the larger of declared and measured, so one light run cannot shrink the budget.
        jobPeak.set(model, Math.max(result.peakRssBytes * 1.1, (jobPeak.get(model) ?? 0) * 0.8, spec.memoryGiB * GiB * 0.5));
      }
      lease.release({ ok, measuredBytes: result.peakRssBytes });
      metrics.observe("pitcrew_job_seconds", result.ms / 1000, { model }, undefined, "Job run time (measured)");
      const headers = { "x-pitcrew-ms": String(result.ms), "x-pitcrew-peak-rss": String(result.peakRssBytes) };
      if (endpoint === "images") {
        sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: result.data.toString("base64") }] });
      } else if (endpoint === "speech") {
        res.writeHead(200, { "content-type": result.ext === "mp3" ? "audio/mpeg" : "audio/wav", ...headers });
        res.end(result.data);
      } else {
        sendJson(res, 200, { text: result.data.toString("utf8").trim() });
      }
    } catch (e) {
      lease.release({ ok: false });
      throw e;
    }
  }

  async function passthrough(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const upstream = await fetch(cfg.backend.url.replace(/\/$/, "") + path, {
      method: req.method,
      headers: { "content-type": String(req.headers["content-type"] ?? "application/json") },
      body: body && body.length ? new Uint8Array(body) : undefined,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(text);
  }

  async function listModels(res: ServerResponse): Promise<void> {
    await registry.refresh().catch(() => undefined);
    const data = [
      { id: cfg.router.name, object: "model", owned_by: "pitcrew", pitcrew: { kind: "router", mode: cfg.router.mode, coder: cfg.router.coder, light: cfg.router.light } },
      ...Object.entries(cfg.models).map(([id, s]) => ({
        id,
        object: "model",
        owned_by: "pitcrew",
        pitcrew: isJob(s) ? { kind: "job", endpoint: s.endpoint } : { kind: "llm", model: s.model, maxCtx: s.maxCtx },
      })),
      ...(cfg.allowUndeclared ? registry.localModels().map((m) => ({ id: m.name, object: "model", owned_by: "local" })) : []),
    ];
    sendJson(res, 200, { object: "list", data });
  }

  function state() {
    const s = monitor.latest;
    return {
      version: "0.1.0",
      backend: cfg.backend.url,
      backendParallel: { slots: serverParallel, source: parallelSource },
      router: cfg.router,
      memory: s && {
        totalBytes: s.totalBytes,
        availableBytes: s.availableBytes,
        inactiveBytes: s.inactiveBytes,
        swapUsedBytes: s.swapUsedBytes,
        swapTotalBytes: s.swapTotalBytes,
        swapoutBps: monitor.swapoutBps,
        pressure: s.pressure,
        state: monitor.state,
        gpuLimitBytes: s.gpuLimitBytes,
        measured: true,
      },
      scheduler: scheduler.snapshot(),
      aliases: Object.fromEntries(
        Object.entries(cfg.models).map(([k, v]) => [k, isJob(v) ? { kind: "job", endpoint: v.endpoint, memoryGiB: v.memoryGiB } : { kind: "llm", ...v }]),
      ),
      loadedVariants: Object.fromEntries(loadedVariant),
      events: scheduler.events.slice(-100),
    };
  }

  const guiPath = [join(dirname(fileURLToPath(import.meta.url)), "gui.html")].find((p) => existsSync(p));
  const sseClients = new Set<ServerResponse>();
  scheduler.onEvent((e) => {
    for (const c of sseClients) c.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
  });
  const sseTimer = setInterval(() => {
    if (!sseClients.size) return;
    const payload = JSON.stringify(state());
    for (const c of sseClients) c.write(`event: state\ndata: ${payload}\n\n`);
  }, 1000);
  sseTimer.unref();

  // ─────────────── warm helpers ───────────────

  async function warmUp(): Promise<void> {
    let probe = cfg.backend.parallel === "auto" && !cfg.backend.managed;
    for (const [alias, spec] of Object.entries(cfg.models)) {
      if (isJob(spec) || !spec.warm) continue;
      const r = await registry.resolve(alias);
      const ctx = Math.max(spec.minCtx ?? 0, cfg.context.buckets[0] ?? 8192);
      const lease = await leaseLlm(r, ctx, "interactive", new AbortController().signal);
      try {
        if (probe) {
          probe = false;
          const variant = loadedVariant.get(r.base);
          if (variant) {
            const p = await client.probeParallel(variant, 4);
            serverParallel = p.parallel;
            parallelSource = `probed on ${alias}: ${p.detail}`;
          }
        }
      } catch (e) {
        parallelSource = `probe failed (${(e as Error).message.slice(0, 80)}); assuming 1`;
      } finally {
        lease.release({ ok: true });
      }
      if (process.env.PITCREW_LOG !== "quiet") console.log(`warm    ${alias}(${r.base}) resident and pinned · backend slots ${serverParallel} (${parallelSource})`);
    }
  }

  // ─────────────── reconcile with the backend ───────────────

  const reconcile = async () => {
    try {
      const ps = await client.ps();
      const byVariant = new Map([...loadedVariant].map(([base, v]) => [v, base]));
      scheduler.observeResident(
        ps.map((m) => {
          const base = byVariant.get(m.name);
          return {
            key: base ?? m.name,
            governed: base !== undefined,
            bytes: m.size,
            activity: Date.parse(m.expires_at ?? "") || 0,
            ctx: m.context_length,
          };
        }),
      );
      for (const m of ps) {
        if (!byVariant.has(m.name)) scheduler.setForeignOps(m.name, { load: async () => undefined, unload: () => client.unload(m.name) });
      }
    } catch {
      // backend down: state() shows it; requests will fail with 502
    }
  };
  const reconcileTimer = setInterval(() => void reconcile(), 2000);
  reconcileTimer.unref();

  // ─────────────── router ───────────────

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/v1/completions" || path === "/v1/responses")) {
        return await proxyModelRequest(req, res, path, "openai");
      }
      if (req.method === "POST" && path === "/v1/embeddings") return await proxyModelRequest(req, res, path, "embed");
      if (req.method === "POST" && (path === "/api/chat" || path === "/api/generate")) return await proxyModelRequest(req, res, path, "native");
      if (req.method === "POST" && path === "/api/embed") return await proxyModelRequest(req, res, path, "embed");
      if (req.method === "POST" && path === "/v1/images/generations") return await handleJob(req, res, "images");
      if (req.method === "POST" && path === "/v1/audio/speech") return await handleJob(req, res, "speech");
      if (req.method === "POST" && path === "/v1/audio/transcriptions") return await handleJob(req, res, "transcriptions");
      if (req.method === "GET" && path === "/v1/models") return await listModels(res);
      if ((req.method === "GET" && (path === "/api/tags" || path === "/api/ps" || path === "/api/version")) || (req.method === "POST" && path === "/api/show")) {
        return await passthrough(req, res, path);
      }
      if (req.method === "GET" && path === "/governor/state") return sendJson(res, 200, state());
      if (req.method === "GET" && path === "/governor/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      if (req.method === "POST" && path === "/governor/unload") {
        const b = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { model?: string };
        if (!b.model) throw new HttpError(400, "model is required");
        const r = cfg.models[b.model];
        const key = r && !isJob(r) ? r.model : b.model;
        await scheduler.unload(key, "manual");
        return sendJson(res, 200, { ok: true, unloaded: key });
      }
      if (req.method === "GET" && path === "/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        return res.end(metrics.render());
      }
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        if (!guiPath) return sendJson(res, 404, errorBody("dashboard not bundled"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(readFileSync(guiPath));
      }
      if (req.method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true });
      sendJson(res, 404, errorBody(`no route ${req.method} ${path}`));
    } catch (e) {
      const err = e as Error & { status?: number };
      const status =
        e instanceof HttpError || e instanceof ModelError || e instanceof SchedulerError
          ? err.status ?? 500
          : e instanceof BackendError
            ? 502
            : (err as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED"
              ? 502
              : 500;
      if (status === 499) {
        res.destroy();
        return;
      }
      if (status === 503) res.setHeader?.("retry-after", "10");
      sendJson(res, status, errorBody(status === 502 && !(e instanceof BackendError) ? `backend unreachable at ${cfg.backend.url}` : err.message));
    }
  });

  return {
    server,
    scheduler,
    registry,
    monitor,
    metrics,
    warmUp,
    close: async () => {
      clearInterval(sseTimer);
      clearInterval(reconcileTimer);
      for (const c of sseClients) c.end();
      scheduler.stop();
      monitor.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export { DERIVED_NS };
