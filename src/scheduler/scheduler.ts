import type { MemoryPolicy, Priority } from "../config.ts";
import type { ThrashState } from "../system/memory.ts";

const GiB = 1024 ** 3;

export type UnitState = "unloaded" | "loading" | "ready" | "unloading" | "failed";
export type UnitKind = "llm" | "job";

/** What the scheduler needs to know about memory right now. */
export interface MemoryView {
  t: number;
  totalBytes: number;
  availableBytes: number;
  inactiveBytes: number;
  gpuLimitBytes?: number;
  state: ThrashState;
}

export interface UnitOps {
  /** Bring the unit into memory with the given context. May return the measured size. */
  load(ctx: number): Promise<{ bytes?: number } | void>;
  unload(): Promise<void>;
}

export interface Unit {
  key: string;
  kind: UnitKind;
  state: UnitState;
  ctx: number;
  bytes: number;
  inFlight: number;
  lastUsed: number;
  /** When this unit's memory was charged; used until the memory probe catches up. */
  chargedAt: number;
  pin: boolean;
  priority: Priority;
  foreign: boolean;
  draining: boolean;
  failedUntil: number;
  loads: number;
  lastLoadMs: number;
  ops?: UnitOps;
  /** For foreign units: last time the backend reported activity. */
  lastActivity: number;
  reason?: string;
}

export interface AcquireRequest {
  key: string;
  kind: UnitKind;
  priority: Priority;
  /** Context window required (LLMs); 0 for jobs. */
  ctx: number;
  /** Memory estimate for this unit at a given context. */
  estimate: (ctx: number) => number;
  ops: UnitOps;
  pin?: boolean;
  /** Max simultaneous requests on this unit (Ollama parallel slots; 1 for jobs). */
  parallel: number;
  signal?: AbortSignal;
  label?: string;
  /**
   * Memory policy override. The user's primary model uses "aggressive": it may load whenever it
   * fits the hard budget and memory is not thrashing, letting macOS compress idle apps.
   */
  policy?: MemoryPolicy;
}

export interface Lease {
  id: number;
  key: string;
  ctx: number;
  queuedMs: number;
  release(outcome?: { ok?: boolean; measuredBytes?: number }): void;
}

export interface SchedulerEvent {
  t: number;
  type:
    | "enqueue"
    | "start"
    | "finish"
    | "load"
    | "loaded"
    | "unload"
    | "evict"
    | "reject"
    | "timeout"
    | "thrash"
    | "wait"
    | "foreign";
  key?: string;
  id?: number;
  msg: string;
  data?: Record<string, unknown>;
}

export class SchedulerError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface SchedulerOptions {
  policy: MemoryPolicy;
  osReserveBytes: number;
  minFreeBytes: number;
  maxModelBytes?: number;
  maxConcurrent: number;
  queueTimeoutMs: number;
  idleUnloadMs: number;
  strictPriority: boolean;
  agingMs: number;
  evictForeign: boolean;
  foreignIdleMs: number;
  /** How long a fresh charge is assumed invisible to the memory probe. */
  probeLagMs: number;
  failCooldownMs: number;
  criticalHoldMs: number;
  recoverMs: number;
}

export const SCHED_DEFAULTS: Omit<SchedulerOptions, "osReserveBytes" | "minFreeBytes"> = {
  policy: "balanced",
  maxConcurrent: 2,
  queueTimeoutMs: 600_000,
  idleUnloadMs: 900_000,
  strictPriority: true,
  agingMs: 60_000,
  evictForeign: true,
  foreignIdleMs: 60_000,
  probeLagMs: 2500,
  failCooldownMs: 30_000,
  criticalHoldMs: 3000,
  recoverMs: 20_000,
};

interface Pending {
  id: number;
  req: AcquireRequest;
  enq: number;
  resolve: (l: Lease) => void;
  reject: (e: Error) => void;
  waitReason?: string;
  onAbort?: () => void;
}

export type Admission =
  | { kind: "fits" }
  | { kind: "evict"; victims: Unit[] }
  | { kind: "wait"; reason: string }
  | { kind: "never"; reason: string };

const fmt = (b: number) => `${(b / GiB).toFixed(1)}G`;

export class Scheduler {
  readonly units = new Map<string, Unit>();
  readonly events: SchedulerEvent[] = [];
  private queue: Pending[] = [];
  private running = 0;
  private nextId = 1;
  private opts: SchedulerOptions;
  private mem: () => MemoryView | undefined;
  private refreshMem: () => Promise<unknown>;
  private now: () => number;
  private listeners = new Set<(e: SchedulerEvent) => void>();
  private busy = new Set<string>();
  private criticalSince = 0;
  private okSince = 0;
  private degraded = false;
  private timer?: NodeJS.Timeout;
  private dispatching = false;
  private redispatch = false;
  readonly stats = { started: 0, finished: 0, failed: 0, rejected: 0, timedOut: 0, loads: 0, evictions: 0, queueWaitMs: [] as number[] };

  constructor(
    opts: Partial<SchedulerOptions> & Pick<SchedulerOptions, "osReserveBytes" | "minFreeBytes">,
    mem: () => MemoryView | undefined,
    refreshMem: () => Promise<unknown> = async () => undefined,
    now: () => number = Date.now,
  ) {
    this.opts = { ...SCHED_DEFAULTS, ...opts };
    this.mem = mem;
    this.refreshMem = refreshMem;
    this.now = now;
  }

  // ───────────────────────────── public API ─────────────────────────────

  start(tickMs = 500): void {
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  onEvent(fn: (e: SchedulerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  acquire(req: AcquireRequest): Promise<Lease> {
    const est = req.estimate(req.ctx);
    const budget = this.budget();
    if (budget !== undefined && est > budget) {
      this.stats.rejected++;
      this.emit("reject", `${req.key} needs ${fmt(est)} but the model budget is ${fmt(budget)}`, req.key);
      return Promise.reject(
        new SchedulerError(`insufficient memory: ${req.key} needs ${fmt(est)}, model budget is ${fmt(budget)}`, 507),
      );
    }
    return new Promise<Lease>((resolve, reject) => {
      const p: Pending = { id: this.nextId++, req, enq: this.now(), resolve, reject };
      if (req.signal) {
        if (req.signal.aborted) return reject(new SchedulerError("client aborted", 499));
        p.onAbort = () => {
          if (this.removePending(p)) reject(new SchedulerError("client aborted", 499));
        };
        req.signal.addEventListener("abort", p.onAbort, { once: true });
      }
      this.queue.push(p);
      this.emit("enqueue", `#${p.id} ${req.priority} ${req.label ?? req.key} ctx=${req.ctx || "-"}`, req.key, p.id);
      this.dispatch();
    });
  }

  /** Reconcile with what the backend reports as resident (e.g. Ollama /api/ps). */
  observeResident(list: { key: string; governed: boolean; bytes: number; activity: number; ctx?: number }[]): void {
    const seen = new Set<string>();
    for (const r of list) {
      if (r.governed) {
        const u = this.units.get(r.key);
        if (!u) continue;
        seen.add(r.key);
        if (u.state === "ready" && r.bytes > 0) u.bytes = r.bytes;
        continue;
      }
      const key = `foreign:${r.key}`;
      seen.add(key);
      let u = this.units.get(key);
      if (!u) {
        u = this.newUnit(key, "llm", "background", false);
        u.foreign = true;
        u.state = "ready";
        u.lastActivity = r.activity;
        u.lastUsed = this.now();
        u.chargedAt = this.now();
        this.units.set(key, u);
        this.emit("foreign", `${r.key} loaded outside the governor (${fmt(r.bytes)})`, key);
      }
      if (r.activity !== u.lastActivity) {
        u.lastActivity = r.activity;
        u.lastUsed = this.now();
      }
      u.bytes = r.bytes;
      u.ctx = r.ctx ?? u.ctx;
    }
    for (const u of this.units.values()) {
      if (seen.has(u.key) || u.kind === "job") continue;
      if (u.foreign) {
        this.units.delete(u.key);
      } else if (u.state === "ready" && u.inFlight === 0 && !this.busy.has(u.key)) {
        // Unloaded behind our back (ollama stop, crash, restart).
        u.state = "unloaded";
        u.bytes = 0;
        this.emit("unload", `${u.key} is no longer resident (unloaded externally)`, u.key);
      }
    }
    this.dispatch();
  }

  /** Attach unload ops to a foreign unit so it can be evicted. */
  setForeignOps(name: string, ops: UnitOps): void {
    const u = this.units.get(`foreign:${name}`);
    if (u) u.ops = ops;
  }

  async unload(key: string, why = "manual"): Promise<void> {
    const u = this.units.get(key);
    if (!u || u.state !== "ready") return;
    if (u.inFlight > 0) throw new SchedulerError(`${key} is busy (${u.inFlight} in flight)`, 409);
    await this.doUnload(u, why);
    this.dispatch();
  }

  budget(): number | undefined {
    const m = this.mem();
    if (!m) return this.opts.maxModelBytes;
    const gpuCap = m.gpuLimitBytes ? m.gpuLimitBytes * 0.9 : m.totalBytes;
    const caps = [gpuCap, m.totalBytes - this.opts.osReserveBytes];
    if (this.opts.maxModelBytes) caps.push(this.opts.maxModelBytes);
    return Math.max(0, Math.min(...caps));
  }

  committed(): number {
    let sum = 0;
    for (const u of this.units.values()) if (u.state !== "unloaded" && u.state !== "failed") sum += u.bytes;
    return sum;
  }

  snapshot() {
    const m = this.mem();
    return {
      budgetBytes: this.budget(),
      committedBytes: this.committed(),
      headroomBytes: m ? this.headroom(m) : undefined,
      running: this.running,
      maxConcurrent: this.effectiveMaxConcurrent(),
      degraded: this.degraded,
      units: [...this.units.values()].map(({ ops: _ops, ...u }) => ({ ...u, idleMs: u.lastUsed ? Math.max(0, this.now() - u.lastUsed) : null })),
      queue: this.queue.map((p) => ({
        id: p.id,
        key: p.req.key,
        label: p.req.label,
        priority: this.effectivePriority(p),
        ctx: p.req.ctx,
        waitingMs: this.now() - p.enq,
        reason: p.waitReason,
      })),
      stats: { ...this.stats, queueWaitMs: undefined, queueWaitP95Ms: p95(this.stats.queueWaitMs) },
    };
  }

  // ───────────────────────────── memory math ─────────────────────────────

  /** Memory the next load may take, net of charges the probe has not seen yet. */
  headroom(m: MemoryView, policy: MemoryPolicy = this.policyNow()): number {
    if (policy === "aggressive") return Number.POSITIVE_INFINITY;
    let unseen = 0;
    for (const u of this.units.values()) {
      // Loading models and running jobs have not finished allocating; freshly loaded models
      // may not be reflected in the last probe sample yet.
      const pending = u.state === "loading" || (u.kind === "job" && u.state === "ready");
      if (pending || (u.state === "ready" && u.chargedAt > m.t - this.opts.probeLagMs)) unseen += u.bytes;
    }
    const bonus = policy === "balanced" ? m.inactiveBytes * 0.5 : 0;
    return m.availableBytes - this.opts.minFreeBytes + bonus - unseen;
  }

  private policyNow(): MemoryPolicy {
    const st = this.mem()?.state ?? "ok";
    return st === "ok" ? this.opts.policy : "strict";
  }

  admission(key: string, need: number, forPriority: Priority, policy?: MemoryPolicy): Admission {
    const m = this.mem();
    const budget = this.budget() ?? Number.POSITIVE_INFINITY;
    if (need > budget) return { kind: "never", reason: `needs ${fmt(need)}, budget ${fmt(budget)}` };
    if (m?.state === "critical") return { kind: "wait", reason: "memory is thrashing; holding new loads" };
    const committed = this.committed();
    const head = m ? this.headroom(m, policy ?? this.policyNow()) : Number.POSITIVE_INFINITY;
    if (committed + need <= budget && need <= head) return { kind: "fits" };

    const rank = (p: Priority) => (p === "interactive" ? 0 : 1);
    const wanted = new Set(
      this.queue.filter((p) => rank(this.effectivePriority(p)) <= rank(forPriority)).map((p) => p.req.key),
    );
    const victims = [...this.units.values()]
      .filter(
        (u) =>
          u.key !== key &&
          u.state === "ready" &&
          u.inFlight === 0 &&
          !this.busy.has(u.key) &&
          u.kind === "llm" &&
          !u.pin &&
          !wanted.has(u.key) &&
          (!u.foreign || (this.opts.evictForeign && u.ops && this.now() - u.lastUsed > this.opts.foreignIdleMs)),
      )
      .sort((a, b) => rank(b.priority) - rank(a.priority) || a.lastUsed - b.lastUsed);
    let freed = 0;
    const chosen: Unit[] = [];
    for (const v of victims) {
      chosen.push(v);
      freed += v.bytes;
      if (committed - freed + need <= budget && need <= head + freed) return { kind: "evict", victims: chosen };
    }
    const reason =
      committed + need > budget
        ? `needs ${fmt(need)}; ${fmt(committed)} of ${fmt(budget)} model budget in use`
        : `needs ${fmt(need)}; only ${fmt(Math.max(0, head))} free after reserves`;
    return { kind: "wait", reason };
  }

  // ───────────────────────────── dispatch ─────────────────────────────

  private effectiveMaxConcurrent(): number {
    return this.degraded ? 1 : this.opts.maxConcurrent;
  }

  private effectivePriority(p: Pending): Priority {
    if (p.req.priority === "background" && this.now() - p.enq > this.opts.agingMs) return "interactive";
    return p.req.priority;
  }

  private ordered(): Pending[] {
    return [...this.queue].sort((a, b) => {
      const pa = this.effectivePriority(a) === "interactive" ? 0 : 1;
      const pb = this.effectivePriority(b) === "interactive" ? 0 : 1;
      return pa - pb || a.enq - b.enq;
    });
  }

  dispatch(): void {
    if (this.dispatching) {
      this.redispatch = true;
      return;
    }
    this.dispatching = true;
    try {
      do {
        this.redispatch = false;
        this.dispatchOnce();
      } while (this.redispatch);
    } finally {
      this.dispatching = false;
    }
  }

  private dispatchOnce(): void {
    const memState = this.mem()?.state ?? "ok";
    const interactiveWaiting = this.queue.some((p) => this.effectivePriority(p) === "interactive");
    // Draining is re-derived every pass so an aborted grow request cannot block a unit forever.
    for (const u of this.units.values()) u.draining = false;
    // Each loop either starts an item, kicks a load, or skips; plans already made this pass
    // reserve their memory so two loads are never admitted against the same headroom.
    for (const p of this.ordered()) {
      if (this.running >= this.effectiveMaxConcurrent()) {
        p.waitReason ??= "all slots busy";
        continue;
      }
      const prio = this.effectivePriority(p);
      if (prio === "background" && memState !== "ok") {
        p.waitReason = `background paused (memory ${memState})`;
        continue;
      }
      if (prio === "background" && this.opts.strictPriority && interactiveWaiting) {
        p.waitReason = "waiting for interactive work";
        continue;
      }
      const u = this.unitFor(p.req);
      if (this.busy.has(u.key)) {
        p.waitReason = u.state === "loading" ? "loading model" : "model busy (load/unload)";
        continue;
      }
      if (u.state === "failed" && this.now() < u.failedUntil) {
        p.waitReason = `load failed recently: ${u.reason ?? ""}`;
        continue;
      }

      if (u.kind === "job") {
        if (u.inFlight >= p.req.parallel) {
          p.waitReason = "job runner busy";
          continue;
        }
        const need = p.req.estimate(0);
        const plan = this.admission(u.key, need, prio, p.req.policy);
        if (plan.kind === "fits") {
          u.state = "ready";
          u.bytes = need;
          u.chargedAt = this.now();
          this.startItem(p, u);
        } else if (plan.kind === "evict") {
          p.waitReason = "evicting idle models";
          void this.evictThenDispatch(u.key, plan.victims);
        } else this.handlePlan(p, u, plan, 0);
        continue;
      }

      if (u.state === "ready") {
        if (u.ctx >= p.req.ctx && !u.draining) {
          if (u.inFlight < p.req.parallel) this.startItem(p, u);
          else p.waitReason = "model slots busy";
          continue;
        }
        if (u.ctx < p.req.ctx) {
          // Needs a bigger window: stop new work on this unit, reload once it drains.
          u.draining = true;
          if (u.inFlight > 0) {
            p.waitReason = `draining ${u.key} to grow context ${u.ctx}→${p.req.ctx}`;
            continue;
          }
          const extra = Math.max(0, p.req.estimate(p.req.ctx) - u.bytes);
          const plan = this.admission(u.key, extra, prio, p.req.policy);
          if (plan.kind === "fits" || plan.kind === "evict") {
            void this.reload(u, p.req.ctx, plan.kind === "evict" ? plan.victims : [], p.req);
          } else this.handlePlan(p, u, plan, p.req.ctx);
          continue;
        }
        p.waitReason = "model draining";
        continue;
      }

      // unloaded or failed-and-cooled-down
      const need = p.req.estimate(p.req.ctx);
      const plan = this.admission(u.key, need, prio, p.req.policy);
      if (plan.kind === "fits" || plan.kind === "evict") {
        void this.loadUnit(u, p.req, plan.kind === "evict" ? plan.victims : []);
        p.waitReason = "loading model";
      } else this.handlePlan(p, u, plan, p.req.ctx);
    }
  }

  private handlePlan(p: Pending, u: Unit, plan: Admission, _ctx: number): void {
    if (plan.kind === "never") {
      this.removePending(p);
      this.stats.rejected++;
      this.emit("reject", `#${p.id} ${u.key}: ${plan.reason}`, u.key, p.id);
      p.reject(new SchedulerError(`insufficient memory: ${plan.reason}`, 507));
      return;
    }
    if (plan.kind === "wait") {
      // Log only when the kind of reason changes, not every time a free-memory figure moves.
      const shape = (r?: string) => r?.replace(/[\d.]+G/g, "#");
      if (shape(p.waitReason) !== shape(plan.reason)) this.emit("wait", `#${p.id} ${u.key}: ${plan.reason}`, u.key, p.id);
      p.waitReason = plan.reason;
    }
  }

  private unitFor(req: AcquireRequest): Unit {
    let u = this.units.get(req.key);
    if (!u) {
      u = this.newUnit(req.key, req.kind, req.priority, req.pin ?? false);
      this.units.set(req.key, u);
    }
    u.ops = req.ops;
    if (req.priority === "interactive") u.priority = "interactive";
    if (req.pin) u.pin = true;
    return u;
  }

  private newUnit(key: string, kind: UnitKind, priority: Priority, pin: boolean): Unit {
    return {
      key,
      kind,
      state: "unloaded",
      ctx: 0,
      bytes: 0,
      inFlight: 0,
      lastUsed: 0,
      chargedAt: 0,
      pin,
      priority,
      foreign: false,
      draining: false,
      failedUntil: 0,
      loads: 0,
      lastLoadMs: 0,
      lastActivity: 0,
    };
  }

  private startItem(p: Pending, u: Unit): void {
    this.removePending(p);
    u.inFlight++;
    u.lastUsed = this.now();
    this.running++;
    this.stats.started++;
    const queuedMs = this.now() - p.enq;
    this.stats.queueWaitMs.push(queuedMs);
    if (this.stats.queueWaitMs.length > 2000) this.stats.queueWaitMs.shift();
    this.emit("start", `#${p.id} ${p.req.label ?? u.key} ctx=${u.ctx || "-"} (queued ${queuedMs}ms)`, u.key, p.id, {
      queuedMs,
    });
    let released = false;
    p.resolve({
      id: p.id,
      key: u.key,
      ctx: u.ctx,
      queuedMs,
      release: (outcome) => {
        if (released) return;
        released = true;
        u.inFlight--;
        u.lastUsed = this.now();
        this.running--;
        if (outcome?.ok === false) this.stats.failed++;
        else this.stats.finished++;
        if (u.kind === "job") {
          u.state = "unloaded";
          u.bytes = 0;
        }
        this.emit("finish", `#${p.id} ${u.key} ${outcome?.ok === false ? "failed" : "done"}`, u.key, p.id, {
          measuredBytes: outcome?.measuredBytes,
        });
        this.dispatch();
      },
    });
  }

  private removePending(p: Pending): boolean {
    const i = this.queue.indexOf(p);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    if (p.onAbort) p.req.signal?.removeEventListener("abort", p.onAbort);
    return true;
  }

  // ───────────────────────────── load / unload ─────────────────────────────

  private async evict(victims: Unit[], forKey: string): Promise<void> {
    for (const v of victims) {
      this.stats.evictions++;
      this.emit("evict", `${v.key} (idle ${Math.round((this.now() - v.lastUsed) / 1000)}s, frees ${fmt(v.bytes)}) for ${forKey}`, v.key);
      await this.doUnload(v, `evicted for ${forKey}`);
    }
    if (victims.length) await this.refreshMem();
  }

  private async evictThenDispatch(forKey: string, victims: Unit[]): Promise<void> {
    this.busy.add(forKey);
    try {
      await this.evict(victims, forKey);
    } finally {
      this.busy.delete(forKey);
      this.dispatch();
    }
  }

  private async loadUnit(u: Unit, req: AcquireRequest, victims: Unit[]): Promise<void> {
    this.busy.add(u.key);
    // Charge synchronously so other items admitted in the same dispatch pass see it.
    const est = req.estimate(req.ctx);
    u.state = "loading";
    u.bytes = est;
    u.ctx = req.ctx;
    u.chargedAt = this.now();
    try {
      await this.evict(victims, u.key);
      this.emit("load", `${u.key} ctx=${req.ctx} est ${fmt(est)}`, u.key);
      const t0 = this.now();
      const r = await req.ops.load(req.ctx);
      u.lastLoadMs = this.now() - t0;
      u.loads++;
      this.stats.loads++;
      if (r && r.bytes) u.bytes = r.bytes;
      u.state = "ready";
      u.chargedAt = this.now();
      u.lastUsed = this.now();
      u.draining = false;
      this.emit("loaded", `${u.key} ${fmt(u.bytes)} in ${(u.lastLoadMs / 1000).toFixed(1)}s (est ${fmt(est)})`, u.key, undefined, {
        bytes: u.bytes,
        estimate: est,
        ms: u.lastLoadMs,
      });
    } catch (e) {
      u.state = "failed";
      u.bytes = 0;
      u.reason = (e as Error).message.slice(0, 200);
      u.failedUntil = this.now() + this.opts.failCooldownMs;
      this.emit("reject", `load ${u.key} failed: ${u.reason}`, u.key);
      this.failQueued(u.key, new SchedulerError(`failed to load ${u.key}: ${u.reason}`, 502));
    } finally {
      this.busy.delete(u.key);
      this.dispatch();
    }
  }

  private async reload(u: Unit, ctx: number, victims: Unit[], req: AcquireRequest): Promise<void> {
    this.busy.add(u.key);
    try {
      this.emit("unload", `${u.key} ctx ${u.ctx}→${ctx} (growing context)`, u.key);
      await u.ops?.unload();
      u.state = "unloaded";
      u.bytes = 0;
    } catch (e) {
      this.emit("reject", `unload ${u.key} failed: ${(e as Error).message}`, u.key);
    } finally {
      this.busy.delete(u.key);
    }
    await this.loadUnit(u, req, victims);
  }

  private async doUnload(u: Unit, why: string): Promise<void> {
    this.busy.add(u.key);
    u.state = "unloading";
    try {
      await u.ops?.unload();
      this.emit("unload", `${u.key} (${why})`, u.key);
      if (u.foreign) this.units.delete(u.key);
    } catch (e) {
      this.emit("reject", `unload ${u.key} failed: ${(e as Error).message}`, u.key);
    } finally {
      u.state = "unloaded";
      u.bytes = 0;
      u.draining = false;
      this.busy.delete(u.key);
    }
  }

  private failQueued(key: string, err: Error): void {
    for (const p of [...this.queue]) {
      if (p.req.key !== key) continue;
      this.removePending(p);
      this.stats.rejected++;
      p.reject(err);
    }
  }

  // ───────────────────────────── periodic work ─────────────────────────────

  tick(): void {
    const now = this.now();
    for (const p of [...this.queue]) {
      if (now - p.enq > this.opts.queueTimeoutMs) {
        this.removePending(p);
        this.stats.timedOut++;
        this.emit("timeout", `#${p.id} ${p.req.key} waited ${Math.round((now - p.enq) / 1000)}s: ${p.waitReason ?? ""}`, p.req.key, p.id);
        p.reject(new SchedulerError(`queue timeout: ${p.waitReason ?? "busy"}`, 503));
      }
    }

    const st = this.mem()?.state ?? "ok";
    if (st === "critical") {
      this.criticalSince ||= now;
      this.okSince = 0;
      if (!this.degraded && now - this.criticalSince >= this.opts.criticalHoldMs) {
        this.degraded = true;
        this.emit("thrash", "memory critical: concurrency → 1, evicting idle models, holding loads");
        const idle = [...this.units.values()]
          .filter((u) => u.state === "ready" && u.inFlight === 0 && !u.pin && !this.busy.has(u.key) && (!u.foreign || u.ops))
          .sort((a, b) => (a.priority === "background" ? -1 : 1) - (b.priority === "background" ? -1 : 1));
        void (async () => {
          for (const u of idle) {
            this.stats.evictions++;
            await this.doUnload(u, "thrash relief");
          }
          this.dispatch();
        })();
      }
    } else {
      this.criticalSince = 0;
      if (st === "ok") this.okSince ||= now;
      if (this.degraded && this.okSince && now - this.okSince >= this.opts.recoverMs) {
        this.degraded = false;
        this.emit("thrash", "memory recovered: normal scheduling resumed");
      }
    }

    if (this.opts.idleUnloadMs > 0) {
      for (const u of this.units.values()) {
        if (u.state === "ready" && !u.pin && !u.foreign && u.inFlight === 0 && !this.busy.has(u.key) && u.kind === "llm" && now - u.lastUsed > this.opts.idleUnloadMs) {
          void this.doUnload(u, `idle ${Math.round((now - u.lastUsed) / 60000)}m`).then(() => this.dispatch());
        }
      }
    }
    this.dispatch();
  }

  private emit(type: SchedulerEvent["type"], msg: string, key?: string, id?: number, data?: Record<string, unknown>): void {
    const e: SchedulerEvent = { t: this.now(), type, msg, key, id, data };
    this.events.push(e);
    if (this.events.length > 500) this.events.shift();
    for (const l of this.listeners) l(e);
  }
}

function p95(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}
