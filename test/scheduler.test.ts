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
  };
  const log: string[] = [];
  const view = (): MemoryView => ({
    t: clock,
    totalBytes: mem.total,
    availableBytes: mem.available,
    inactiveBytes: mem.inactive,
    gpuLimitBytes: mem.gpu,
    state: mem.state,
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
