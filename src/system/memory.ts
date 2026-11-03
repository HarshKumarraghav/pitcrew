import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { totalmem, freemem, platform } from "node:os";

export type PressureLevel = "normal" | "warn" | "critical";

export interface MemorySnapshot {
  t: number;
  totalBytes: number;
  /** Memory a new allocation can take without pushing other apps into compression/swap. */
  availableBytes: number;
  /** Inactive anonymous memory; macOS can compress it, at some cost to those apps. */
  inactiveBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  /** Cumulative pages swapped out since boot (monotonic). */
  swapoutPages: number;
  pageSize: number;
  pressure: PressureLevel;
  /** Max memory the GPU may wire, if known (Metal recommendedMaxWorkingSetSize). */
  gpuLimitBytes?: number;
}

export interface MemoryProbe {
  read(): Promise<MemorySnapshot>;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (_err, stdout) => resolve(String(stdout ?? "")));
  });
}

export function parseVmStat(out: string): { pageSize: number; pages: Record<string, number> } {
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
  const pages: Record<string, number> = {};
  for (const line of out.split("\n")) {
    const m = /^"?([^":]+)"?:\s+(\d+)\.?$/.exec(line.trim());
    if (m?.[1] && m[2]) pages[m[1].trim()] = Number(m[2]);
  }
  return { pageSize, pages };
}

export function parseSwapUsage(s: string): { total: number; used: number } {
  const unit = (v: string, u: string) => Number(v) * (u === "G" ? 1024 ** 3 : u === "K" ? 1024 : 1024 ** 2);
  const t = /total = ([\d.]+)([KMG])/.exec(s);
  const u = /used = ([\d.]+)([KMG])/.exec(s);
  return {
    total: t?.[1] && t[2] ? unit(t[1], t[2]) : 0,
    used: u?.[1] && u[2] ? unit(u[1], u[2]) : 0,
  };
}

/** macOS: vm_stat + sysctl. No root needed. */
export class DarwinProbe implements MemoryProbe {
  async read(): Promise<MemorySnapshot> {
    const [vm, swap, level, mem, wired] = await Promise.all([
      run("vm_stat", []),
      run("sysctl", ["-n", "vm.swapusage"]),
      run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
      run("sysctl", ["-n", "hw.memsize"]),
      run("sysctl", ["-n", "iogpu.wired_limit_mb"]),
    ]);
    const { pageSize, pages } = parseVmStat(vm);
    const p = (k: string) => pages[k] ?? 0;
    const totalBytes = Number(mem.trim()) || totalmem();
    // Free pages plus file cache (clean, droppable) plus purgeable. Speculative pages are
    // already included in the file-backed count.
    const availableBytes = Math.min(
      totalBytes,
      (p("Pages free") + p("File-backed pages") + p("Pages purgeable")) * pageSize,
    );
    const anonInactive = Math.max(0, p("Pages inactive") - p("File-backed pages") / 2);
    const { total, used } = parseSwapUsage(swap);
    const lvl = Number(level.trim());
    const wiredMb = Number(wired.trim());
    return {
      t: Date.now(),
      totalBytes,
      availableBytes,
      inactiveBytes: anonInactive * pageSize,
      swapUsedBytes: used,
      swapTotalBytes: total,
      swapoutPages: p("Swapouts"),
      pageSize,
      pressure: lvl >= 4 ? "critical" : lvl >= 2 ? "warn" : "normal",
      // Metal's recommendedMaxWorkingSetSize is ~74% of RAM on Apple Silicon unless overridden.
      gpuLimitBytes: wiredMb > 0 ? wiredMb * 1024 * 1024 : Math.floor(totalBytes * 0.74),
    };
  }
}

/** Linux: /proc/meminfo + /proc/vmstat. */
export class LinuxProbe implements MemoryProbe {
  async read(): Promise<MemorySnapshot> {
    const [mi, vs, psi] = await Promise.all([
      readFile("/proc/meminfo", "utf8"),
      readFile("/proc/vmstat", "utf8").catch(() => ""),
      readFile("/proc/pressure/memory", "utf8").catch(() => ""),
    ]);
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(mi)?.[1] ?? 0) * 1024;
    const swapout = Number(/^pswpout (\d+)/m.exec(vs)?.[1] ?? 0);
    const some10 = Number(/some avg10=([\d.]+)/.exec(psi)?.[1] ?? 0);
    return {
      t: Date.now(),
      totalBytes: kb("MemTotal"),
      availableBytes: kb("MemAvailable"),
      inactiveBytes: kb("Inactive\\(anon\\)"),
      swapUsedBytes: kb("SwapTotal") - kb("SwapFree"),
      swapTotalBytes: kb("SwapTotal"),
      swapoutPages: swapout,
      pageSize: 4096,
      pressure: some10 > 40 ? "critical" : some10 > 10 ? "warn" : "normal",
    };
  }
}

/** Fallback for other platforms: Node's view only. */
export class NodeProbe implements MemoryProbe {
  async read(): Promise<MemorySnapshot> {
    return {
      t: Date.now(),
      totalBytes: totalmem(),
      availableBytes: freemem(),
      inactiveBytes: 0,
      swapUsedBytes: 0,
      swapTotalBytes: 0,
      swapoutPages: 0,
      pageSize: 4096,
      pressure: "normal",
    };
  }
}

export function defaultProbe(): MemoryProbe {
  const p = platform();
  return p === "darwin" ? new DarwinProbe() : p === "linux" ? new LinuxProbe() : new NodeProbe();
}

export type ThrashState = "ok" | "warn" | "critical";

/**
 * Polls a probe and turns raw counters into decisions: a smoothed swap-out rate and a
 * thrash state that combines it with the kernel's own pressure level.
 */
export class MemoryMonitor {
  latest?: MemorySnapshot;
  swapoutBps = 0;
  state: ThrashState = "ok";
  private prev?: MemorySnapshot;
  private timer?: NodeJS.Timeout;
  private listeners = new Set<(s: MemorySnapshot) => void>();
  private probe: MemoryProbe;
  private thrashBps: number;
  private pollMs: number;

  constructor(probe: MemoryProbe, opts: { thrashSwapoutMiBps: number; pollMs: number }) {
    this.probe = probe;
    this.thrashBps = opts.thrashSwapoutMiBps * 1024 * 1024;
    this.pollMs = opts.pollMs;
  }

  /** Apps are being pushed to swap faster than the configured threshold (smoothed). */
  get thrashing(): boolean {
    return this.swapoutBps > this.thrashBps;
  }

  async sample(): Promise<MemorySnapshot> {
    const s = await this.probe.read();
    if (this.prev) {
      const dt = Math.max(0.001, (s.t - this.prev.t) / 1000);
      const rate = (Math.max(0, s.swapoutPages - this.prev.swapoutPages) * s.pageSize) / dt;
      // EMA with ~5-sample memory: reacts within seconds, ignores one-off blips.
      this.swapoutBps = this.swapoutBps * 0.7 + rate * 0.3;
    }
    this.prev = s;
    this.latest = s;
    const thrashing = this.thrashing;
    this.state =
      s.pressure === "critical" || (thrashing && s.pressure === "warn")
        ? "critical"
        : thrashing || s.pressure === "warn"
          ? "warn"
          : "ok";
    for (const l of this.listeners) l(s);
    return s;
  }

  start(): void {
    if (this.timer) return;
    const tick = () => this.sample().catch(() => undefined);
    void tick();
    this.timer = setInterval(tick, this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  onSample(fn: (s: MemorySnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
