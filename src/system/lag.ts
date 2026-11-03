import { spawn } from "node:child_process";

/**
 * "Does my Mac lag": how long it takes to start and finish a trivial process. Under memory
 * pressure this jumps from a few ms to hundreds, well before apps visibly stall.
 */
export class LagProbe {
  readonly samples: number[] = [];
  private timer?: NodeJS.Timeout;
  private everyMs: number;

  constructor(everyMs = 2000) {
    this.everyMs = everyMs;
  }

  once(): Promise<number> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const p = spawn("/usr/bin/true", [], { stdio: "ignore" });
      p.on("exit", () => resolve(performance.now() - t0));
      p.on("error", () => resolve(Number.NaN));
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.once().then((ms) => {
        if (!Number.isFinite(ms)) return;
        this.samples.push(ms);
        if (this.samples.length > 150) this.samples.shift();
      });
    }, this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  summary(): { lastMs?: number; p50Ms?: number; p95Ms?: number; n: number } {
    const s = [...this.samples].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]! * 10) / 10 : undefined);
    const last = this.samples.at(-1);
    return { lastMs: last === undefined ? undefined : Math.round(last * 10) / 10, p50Ms: q(0.5), p95Ms: q(0.95), n: s.length };
  }
}
