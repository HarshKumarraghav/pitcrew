import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler, SchedulerError, type AcquireRequest, type MemoryView, type UnitOps } from "../src/scheduler/scheduler.ts";
import type { ThrashState } from "../src/system/memory.ts";

const G = 1024 ** 3;

/** A pretend machine: loads consume available memory, unloads give it back. */
function machine(opts: { total?: number; available: number; gpu?: number; queueTimeoutMs?: number }) {
  let clock = 1_000_000;
  const mem = {
    total: opts.total ?? 24 * G,
    available: opts.available,
    inactive: 0,
    gpu: opts.gpu ?? 18 * G,
    state: "ok" as ThrashState,
    thrashing: false,
  };
  const log: string[] = [];
  const view = (): MemoryView => ({
    t: clock,
    totalBytes: mem.total,
    availableBytes: mem.available,
    inactiveBytes: mem.inactive,
    gpuLimitBytes: mem.gpu,
    state: mem.state,
    thrashing: mem.thrashing,
  });
  const sched = new Scheduler(
    { osReserveBytes: 4 * G, minFreeBytes: 1 * G, probeLagMs: 0, maxConcurrent: 2, queueTimeoutMs: opts.queueTimeoutMs ?? 5000, idleUnloadMs: 0, criticalHoldMs: 1000, recoverMs: 1000, agingMs: 60_000 },
    view,
    async () => undefined,
    () => clock,
  );
  const ops = (key: string, size: number, loadDelay = 0): UnitOps => ({
    async load() {
      log.push(`load:${key}`);
      if (loadDelay) await new Promise((r) => setTimeout(r, loadDelay));
      mem.available -= size;
      return { bytes: size };
    },
    async unload() {
      log.push(`unload:${key}`);
      mem.available += size;
    },
  });
  const req = (key: string, size: number, extra: Partial<AcquireRequest> = {}): AcquireRequest => ({
    key,
    kind: "llm",
    priority: "interactive",
    ctx: 8192,
    estimate: () => size,
    ops: ops(key, size),
    parallel: 1,
    ...extra,
  });
  return {
    sched,
    mem,
    log,
    req,
    ops,
    advance: (ms: number) => {
      clock += ms;
      sched.tick();
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test("loads once, then reuses the resident model", async () => {
  const m = machine({ available: 12 * G });
  const a = await m.sched.acquire(m.req("coder", 8 * G));
  a.release();
  const b = await m.sched.acquire(m.req("coder", 8 * G));
  b.release();
  assert.deepEqual(m.log, ["load:coder"]);
});

test("rejects immediately when a model can never fit the budget", async () => {
  const m = machine({ available: 20 * G, gpu: 10 * G });
  await assert.rejects(m.sched.acquire(m.req("huge", 12 * G)), (e: SchedulerError) => e.status === 507);
  assert.deepEqual(m.log, []);
});

test("evicts an idle model to make room", async () => {
  const m = machine({ available: 9 * G });
  (await m.sched.acquire(m.req("small", 2 * G))).release();
  // 7G free now; coder needs 8G + 1G floor → must evict small.
  const l = await m.sched.acquire(m.req("coder", 8 * G));
  l.release();
  assert.deepEqual(m.log, ["load:small", "unload:small", "load:coder"]);
  assert.equal(m.sched.stats.evictions, 1);
});

test("never evicts a model that is mid-request; waits instead", async () => {
  const m = machine({ available: 9 * G });
  const busy = await m.sched.acquire(m.req("small", 2 * G));
  let got = false;
  const p = m.sched.acquire(m.req("coder", 8 * G)).then((l) => {
    got = true;
    return l;
  });
  await flush();
  assert.equal(got, false);
  const q = m.sched.snapshot().queue[0];
  assert.match(q?.reason ?? "", /free after reserves/);
  busy.release();
  (await p).release();
  assert.deepEqual(m.log, ["load:small", "unload:small", "load:coder"]);
});

test("interactive work is served before background work", async () => {
  const m = machine({ available: 12 * G });
  m.sched["opts"].maxConcurrent = 1;
  const first = await m.sched.acquire(m.req("coder", 4 * G));
  const order: string[] = [];
  const bg = m.sched.acquire(m.req("coder", 4 * G, { priority: "background", label: "bg" })).then((l) => {
    order.push("bg");
    l.release();
  });
  const fg = m.sched.acquire(m.req("coder", 4 * G, { label: "fg" })).then((l) => {
    order.push("fg");
    l.release();
  });
  await flush();
  first.release();
  await Promise.all([bg, fg]);
  assert.deepEqual(order, ["fg", "bg"]);
});

test("grows the context window only after in-flight work drains, then stays sticky", async () => {
  const m = machine({ available: 16 * G });
  const small = await m.sched.acquire(m.req("coder", 6 * G, { ctx: 8192 }));
  const big = m.sched.acquire(m.req("coder", 7 * G, { ctx: 32768 }));
  await flush();
  assert.deepEqual(m.log, ["load:coder"]);
  small.release();
  const l = await big;
  assert.equal(l.ctx, 32768);
  l.release();
  const again = await m.sched.acquire(m.req("coder", 6 * G, { ctx: 8192 }));
  assert.equal(again.ctx, 32768, "smaller request reuses the larger window");
  again.release();
  assert.deepEqual(m.log, ["load:coder", "unload:coder", "load:coder"]);
});

test("does not admit two loads against the same headroom", async () => {
  const m = machine({ available: 10 * G });
  const r1 = m.req("a", 6 * G);
  r1.ops = m.ops("a", 6 * G, 20);
  const r2 = m.req("b", 6 * G);
  r2.ops = m.ops("b", 6 * G, 20);
  const p1 = m.sched.acquire(r1);
  const p2 = m.sched.acquire(r2);
  await flush();
  assert.deepEqual(m.log, ["load:a"], "b must wait while a is loading");
  const l1 = await p1;
  l1.release();
  const l2 = await p2; // a is idle now → evicted for b
  l2.release();
  assert.deepEqual(m.log, ["load:a", "unload:a", "load:b"]);
});

test("holds loads while memory is critical and sheds idle models after the hold time", async () => {
  const m = machine({ available: 12 * G });
  (await m.sched.acquire(m.req("small", 2 * G))).release();
  m.mem.state = "critical";
  let done = false;
  const p = m.sched.acquire(m.req("coder", 4 * G)).then((l) => {
    done = true;
    l.release();
  });
  await flush();
  assert.equal(done, false);
  assert.match(m.sched.snapshot().queue[0]?.reason ?? "", /thrashing/);
  m.advance(10);
  m.advance(1500);
  await flush();
  assert.ok(m.log.includes("unload:small"), "idle model shed under thrash");
  assert.equal(m.sched.snapshot().maxConcurrent, 1);
  m.mem.state = "ok";
  m.advance(10);
  await p;
  m.advance(1500);
  assert.equal(m.sched.snapshot().maxConcurrent, 2, "recovers after the calm period");
});

test("queued requests time out with 503 and a reason", async () => {
  const m = machine({ available: 3 * G });
  const p = m.sched.acquire(m.req("coder", 8 * G));
  await flush();
  m.advance(6000);
  await assert.rejects(p, (e: SchedulerError) => e.status === 503 && /free after reserves/.test(e.message));
});

test("client abort removes a queued request", async () => {
  const m = machine({ available: 3 * G });
  const ac = new AbortController();
  const p = m.sched.acquire(m.req("coder", 8 * G, { signal: ac.signal }));
  await flush();
  ac.abort();
  await assert.rejects(p, (e: SchedulerError) => e.status === 499);
  assert.equal(m.sched.snapshot().queue.length, 0);
});

test("jobs reserve memory while running and can push idle LLMs out", async () => {
  const m = machine({ available: 10 * G });
  (await m.sched.acquire(m.req("coder", 6 * G))).release();
  const job = await m.sched.acquire({ ...m.req("image", 5 * G), kind: "job", ctx: 0 });
  assert.ok(m.log.includes("unload:coder"));
  assert.equal(m.sched.committed(), 5 * G);
  job.release();
  assert.equal(m.sched.committed(), 0);
});

test("counts models loaded outside the governor and evicts them only when idle long enough", async () => {
  const m = machine({ available: 6 * G, queueTimeoutMs: 120_000 });
  m.sched.observeResident([{ key: "other:7b", governed: false, bytes: 5 * G, activity: 1 }]);
  assert.equal(m.sched.committed(), 5 * G);
  m.sched.setForeignOps("other:7b", { load: async () => undefined, unload: async () => void (m.mem.available += 5 * G) });
  let done = false;
  const p = m.sched.acquire(m.req("coder", 7 * G)).then((l) => {
    done = true;
    l.release();
  });
  await flush();
  assert.equal(done, false, "foreign model was just seen; not evicted yet");
  m.advance(61_000);
  await p;
  assert.equal(done, true);
});

import { Footprint, parseArch, kvBytes } from "../src/models/footprint.ts";

test("footprint: hybrid attention counts only full-attention layers", () => {
  const a = parseArch({ model_info: { "general.architecture": "qwen35", "qwen35.block_count": 32, "qwen35.attention.head_count": 16, "qwen35.attention.head_count_kv": 4, "qwen35.attention.key_length": 256, "qwen35.attention.value_length": 256, "qwen35.full_attention_interval": 4 } });
  assert.equal(a.fullKvHeads, 8 * 4);
  assert.equal(kvBytes(a, 1, "f16"), 32 * 1024, "32 KiB per token");
});

test("footprint: unknown layout falls back to a conservative guess, then fits measurements", () => {
  const a = parseArch({ model_info: { "general.architecture": "qwen3_5", "qwen3_5.block_count": 32 } });
  assert.equal(a.known, false);
  const fp = new Footprint(7 * G, a, "f16");
  assert.ok(fp.estimate(32768) > 7 * G + 3 * G, "over-estimates before calibration");
  fp.observe({ ctx: 8192, parallel: 1, bytes: 7.5 * G });
  fp.observe({ ctx: 32768, parallel: 1, bytes: 8.25 * G });
  const per = (fp.estimate(65536) - fp.estimate(32768)) / 32768;
  assert.ok(Math.abs(per - 0.75 * G / 24576) < 1, "slope learned from two observations");
});

test("a primary model may load past soft headroom, but never past the budget or while thrashing", async () => {
  const m = machine({ available: 4 * G });
  // 4G free, 1G floor → 3G headroom; an 8G non-primary model must wait…
  let plain = false;
  const p1 = m.sched.acquire(m.req("other", 8 * G)).then((l) => { plain = true; l.release(); }).catch(() => undefined);
  await flush();
  assert.equal(plain, false);
  // …while the primary loads (budget is 17.2G).
  const l = await m.sched.acquire(m.req("coder", 8 * G, { policy: "aggressive" }));
  l.release();
  assert.ok(m.log.includes("load:coder"));
  m.mem.state = "critical";
  let blocked = true;
  m.sched.acquire(m.req("coder2", 2 * G, { policy: "aggressive" })).then((x) => { blocked = false; x.release(); }).catch(() => undefined);
  await flush();
  assert.equal(blocked, true, "critical pressure still holds even the primary");
  m.mem.state = "ok";
  void p1;
});

// ───────────── M10: load-test fixes ─────────────

test("fast lane: a loaded model keeps serving while degraded; new loads still hold", async () => {
  const m = machine({ available: 12 * G });
  (await m.sched.acquire(m.req("small", 1 * G, { parallel: 2, pin: true }))).release();
  const coder = await m.sched.acquire(m.req("coder", 6 * G));
  m.mem.state = "critical";
  m.advance(10);
  m.advance(1500);
  await flush();
  assert.equal(m.sched.snapshot().degraded, true);
  m.mem.state = "warn";
  // One coder request is running and the degraded cap is 1, yet both small requests start at once.
  const a = await m.sched.acquire(m.req("small", 1 * G, { parallel: 2, pin: true }));
  const b = await m.sched.acquire(m.req("small", 1 * G, { parallel: 2, pin: true }));
  let third = false;
  const c = m.sched.acquire(m.req("small", 1 * G, { parallel: 2, pin: true })).then((l) => { third = true; return l; });
  // A model that is not loaded still waits for a slot.
  let loaded = false;
  const other = m.sched.acquire(m.req("other", 1 * G)).then((l) => { loaded = true; return l; });
  await flush();
  assert.equal(third, false, "per-model slots (parallel=2) still apply");
  assert.equal(loaded, false, "loads stay behind the degraded cap");
  a.release();
  (await c).release();
  b.release();
  coder.release();
  (await other).release();
  assert.equal(loaded, true);
});

test("small helpers use the compressible-memory credit at warn, never at critical", async () => {
  const m = machine({ available: 2 * G });
  m.mem.inactive = 2 * G;
  m.mem.state = "warn";
  // 2G free − 1G floor = 1G strict headroom; + ½ of 2G inactive = 2G balanced headroom.
  const l = await m.sched.acquire(m.req("small", 1.2 * G));
  l.release();
  assert.ok(m.log.includes("load:small"));
  let big = false;
  m.sched.acquire(m.req("mid", 1.8 * G)).then((x) => { big = true; x.release(); }).catch(() => undefined);
  await flush();
  assert.equal(big, false, "models above the small-model size keep the strict policy at warn");
});

test("background work runs at warn and pauses only while apps are swapped out", async () => {
  const m = machine({ available: 12 * G });
  m.mem.state = "warn";
  (await m.sched.acquire(m.req("mid", 2 * G, { priority: "background" }))).release();
  m.mem.thrashing = true;
  let ran = false;
  const p = m.sched.acquire(m.req("mid", 2 * G, { priority: "background" })).then((l) => { ran = true; l.release(); });
  await flush();
  assert.equal(ran, false);
  assert.match(m.sched.snapshot().queue[0]?.reason ?? "", /swapped out/);
  m.mem.thrashing = false;
  m.advance(10);
  await p;
});

test("background requests evict an idle model only after it has been idle for 3 s", async () => {
  const m = machine({ available: 9 * G, queueTimeoutMs: 60_000 });
  (await m.sched.acquire(m.req("coder", 6 * G))).release();
  let ran = false;
  const p = m.sched.acquire(m.req("mid", 4 * G, { priority: "background" })).then((l) => { ran = true; l.release(); });
  await flush();
  assert.equal(ran, false, "coder was used a moment ago (between agent steps)");
  m.advance(1000);
  await flush();
  assert.equal(ran, false);
  m.advance(2500);
  await p;
  assert.deepEqual(m.log, ["load:coder", "unload:coder", "load:mid"]);
});

test("degraded mode recovers after a calm period even if the kernel stays at warn", async () => {
  const m = machine({ available: 12 * G });
  m.mem.state = "critical";
  m.advance(10);
  m.advance(1500);
  assert.equal(m.sched.snapshot().degraded, true);
  m.mem.state = "warn";
  m.advance(10);
  m.advance(1500);
  assert.equal(m.sched.snapshot().degraded, false);
});

test("thrash relief leaves a foreign model alone until it has been idle long enough", async () => {
  const m = machine({ available: 12 * G });
  let unloaded = 0;
  m.sched.observeResident([{ key: "other:9b", governed: false, bytes: 8 * G, activity: 1 }]);
  m.sched.setForeignOps("other:9b", { load: async () => undefined, unload: async () => void unloaded++ });
  m.mem.state = "critical";
  m.advance(10);
  m.advance(1500);
  await flush();
  assert.equal(unloaded, 0, "just seen: another client may be using it");
  m.mem.state = "ok";
  m.advance(30_000);
  m.advance(1500);
  assert.equal(m.sched.snapshot().degraded, false);
  m.mem.state = "critical";
  m.advance(40_000);
  m.advance(1500);
  await flush();
  assert.equal(unloaded, 1);
});

// ───────────── M9.1: resident-size cap ─────────────

test("a model that grew past its cap is reloaded once idle, and its growth is reserved", async () => {
  const m = machine({ available: 16 * G });
  const l = await m.sched.acquire(m.req("coder", 6 * G, { maxResidentBytes: 8 * G }));
  // The backend reports growth while a request runs: not recycled mid-request.
  m.sched.observeResident([{ key: "coder", governed: true, bytes: 10 * G, activity: 1 }]);
  m.advance(6000);
  await flush();
  assert.equal(m.sched.stats.recycles, 0, "never recycled while busy");
  l.release();
  // Growth is reserved: committed counts the 10G it is at now.
  assert.equal(m.sched.committed(), 10 * G);
  m.advance(2000);
  await flush();
  assert.equal(m.sched.stats.recycles, 0, "waits until idle for 5 s");
  m.advance(4000);
  await flush();
  await flush();
  assert.equal(m.sched.stats.recycles, 1);
  assert.deepEqual(m.log, ["load:coder", "unload:coder", "load:coder"]);
  const u = m.sched.units.get("coder")!;
  assert.equal(u.bytes, 6 * G);
  // After the reload it is expected to grow again up to the cap (8G), not to 10G.
  assert.equal(m.sched.committed(), 8 * G);
});

test("learned growth: a reload reserves its grown size, but is never refused outright for it", async () => {
  const m = machine({ available: 30 * G, gpu: 20 * G, queueTimeoutMs: 60_000 });
  (await m.sched.acquire(m.req("coder", 6 * G))).release();
  m.sched.observeResident([{ key: "coder", governed: true, bytes: 12 * G, activity: 1 }]);
  await m.sched.unload("coder");
  // A pinned 8G model takes part of the 18G budget (0.9 × 20G), leaving 10G.
  (await m.sched.acquire(m.req("other", 8 * G, { pin: true }))).release();
  let state = "waiting";
  const p = m.sched.acquire(m.req("coder", 6 * G)).then((x) => { state = "ok"; x.release(); }, (e) => { state = `rejected ${e.status}`; });
  await flush();
  // Plain estimate 6G would fit; the learned 12G does not → it waits (not a 507).
  assert.equal(state, "waiting");
  assert.match(m.sched.snapshot().queue[0]?.reason ?? "", /budget in use/);
  m.sched["units"].get("other")!.pin = false;
  m.advance(10);
  await p;
  assert.equal(state, "ok");
});
