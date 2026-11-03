/** Tiny Prometheus registry: counters, gauges and fixed-bucket histograms. */
type Labels = Record<string, string>;

const key = (name: string, labels: Labels) =>
  name + (Object.keys(labels).length ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/"/g, "'")}"`).join(",")}}` : "");

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, () => number | undefined>();
  private hist = new Map<string, { buckets: number[]; counts: number[]; sum: number; n: number; name: string; labels: Labels }>();
  private help = new Map<string, string>();

  inc(name: string, labels: Labels = {}, by = 1, help?: string): void {
    if (help) this.help.set(name, help);
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  gauge(name: string, fn: () => number | undefined, help?: string): void {
    if (help) this.help.set(name, help);
    this.gauges.set(name, fn);
  }

  observe(name: string, value: number, labels: Labels = {}, buckets = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300], help?: string): void {
    if (help) this.help.set(name, help);
    const k = key(name, labels);
    let h = this.hist.get(k);
    if (!h) {
      h = { buckets, counts: buckets.map(() => 0), sum: 0, n: 0, name, labels };
      this.hist.set(k, h);
    }
    h.buckets.forEach((b, i) => {
      if (value <= b) h.counts[i] = (h.counts[i] ?? 0) + 1;
    });
    h.sum += value;
    h.n++;
  }

  render(): string {
    const lines: string[] = [];
    const typed = new Set<string>();
    const head = (name: string, type: string) => {
      if (typed.has(name)) return;
      typed.add(name);
      const h = this.help.get(name);
      if (h) lines.push(`# HELP ${name} ${h}`);
      lines.push(`# TYPE ${name} ${type}`);
    };
    for (const [k, v] of this.counters) {
      head(k.split("{")[0] ?? k, "counter");
      lines.push(`${k} ${v}`);
    }
    for (const [name, fn] of this.gauges) {
      const v = fn();
      if (v === undefined || !Number.isFinite(v)) continue;
      head(name, "gauge");
      lines.push(`${name} ${v}`);
    }
    for (const h of this.hist.values()) {
      head(h.name, "histogram");
      h.buckets.forEach((b, i) => lines.push(`${key(`${h.name}_bucket`, { ...h.labels, le: String(b) })} ${h.counts[i]}`));
      lines.push(`${key(`${h.name}_bucket`, { ...h.labels, le: "+Inf" })} ${h.n}`);
      lines.push(`${key(`${h.name}_sum`, h.labels)} ${h.sum}`);
      lines.push(`${key(`${h.name}_count`, h.labels)} ${h.n}`);
    }
    return lines.join("\n") + "\n";
  }
}
