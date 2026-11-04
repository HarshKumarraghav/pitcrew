#!/usr/bin/env node
// Builds the README benchmark charts (docs/img/bench-*.svg, light + dark) from the measured numbers
// in docs/BENCHMARKS.md. Static SVG, no dependencies: `node scripts/charts/build.mjs`.
// Colors: the first three slots of the dataviz reference palette, validated all-pairs in both modes
// (aqua is below 3:1 on the light surface, so every bar carries a visible value label).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "img");

const THEMES = {
  light: { surface: "#fcfcfb", primary: "#0b0b0b", secondary: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7", pitcrew: "#2a78d6", cloud: "#eb6834", plain: "#1baf7a" },
  dark: { surface: "#1a1a19", primary: "#ffffff", secondary: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835", pitcrew: "#3987e5", cloud: "#d95926", plain: "#199e70" },
};
const FONT = `system-ui, -apple-system, "Segoe UI", sans-serif`;
const W = 820;
const BAR = 16;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (x, y, s, { size = 12, fill, weight = 400, anchor = "start" } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;

/** A bar growing from x0, square at the baseline, 4px rounded data end. */
function bar(x0, y, w, h, fill) {
  if (w <= 0) return "";
  const r = Math.min(4, w, h / 2);
  return `<path d="M${x0},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 ${-r},${r} h${-(w - r)} z" fill="${fill}"/>`;
}

function header(t, c) {
  let s = text(0, 22, c.title, { size: 16, weight: 600, fill: t.primary });
  s += text(0, 42, c.subtitle, { size: 12.5, fill: t.secondary });
  let x = 0;
  for (const l of c.legend) {
    s += `<rect x="${x}" y="56" width="12" height="12" rx="3" fill="${t[l.key]}"/>`;
    s += text(x + 18, 66.5, l.label, { size: 12, fill: t.secondary });
    x += 18 + l.label.length * 6.6 + 22;
  }
  return s;
}

/** One panel of horizontal bars with its own axis. Rows: {label?, value, lo?, hi?, key, tip}. */
function panel(t, p, x, y, w, rowH) {
  const scale = (v) => (v / p.max) * w;
  let s = text(x, y, p.heading, { size: 12.5, weight: 600, fill: t.primary });
  const top = y + 12;
  const h = p.rows.length * rowH;
  for (const tick of p.ticks) {
    const tx = x + scale(tick);
    s += `<line x1="${tx}" y1="${top}" x2="${tx}" y2="${top + h}" stroke="${tick === 0 ? t.axis : t.grid}" stroke-width="1"/>`;
    s += text(tx, top + h + 14, p.fmt(tick), { size: 11, fill: t.muted, anchor: tick === 0 ? "start" : "middle" });
  }
  p.rows.forEach((r, i) => {
    const cy = top + i * rowH + rowH / 2;
    const by = cy - BAR / 2;
    const lo = r.lo ?? r.value;
    s += bar(x, by, scale(lo), BAR, t[r.key]);
    let end = x + scale(lo);
    if (r.hi !== undefined) {
      // A measured range: solid to the low end, a 2px whisker to the high end.
      const hx = x + scale(r.hi);
      s += `<line x1="${end}" y1="${cy}" x2="${hx}" y2="${cy}" stroke="${t[r.key]}" stroke-width="2" stroke-linecap="round"/>`;
      s += `<line x1="${hx}" y1="${cy - 5}" x2="${hx}" y2="${cy + 5}" stroke="${t[r.key]}" stroke-width="2" stroke-linecap="round"/>`;
      end = hx;
    }
    s += text(end + 6, cy + 4, r.tip, { size: 12, fill: t.secondary });
  });
  return { svg: s, bottom: top + h + 20 };
}

function svg(t, body, h, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="-16 -8 ${W} ${h}" role="img" aria-label="${esc(title)}" font-family='${FONT}'>
<rect x="-16" y="-8" width="${W}" height="${h}" rx="8" fill="${t.surface}"/>
${body}
</svg>
`;
}

/** Panels stacked vertically, row labels on the left. */
function stacked(t, c) {
  const labelW = 80;
  const tipRoom = 150; // value labels sit right of the longest bar
  const rowH = 26;
  let y = 96;
  let body = header(t, c);
  for (const p of c.panels) {
    p.rows.forEach((r, i) => (body += text(0, y + 12 + i * rowH + rowH / 2 + 4, r.label, { size: 12, fill: t.secondary })));
    const out = panel(t, p, labelW, y, W - 32 - labelW - tipRoom, rowH);
    body += out.svg;
    y = out.bottom + 18;
  }
  return svg(t, body, y + 8, c.title);
}

/** Panels side by side sharing the row labels. */
function sideBySide(t, c) {
  const labelW = 170;
  const rowH = 28;
  const gap = 24;
  const tipRoom = 78;
  const n = c.panels.length;
  const pw = (W - 32 - labelW - n * tipRoom - (n - 1) * gap) / n;
  const y = 96;
  let body = header(t, c);
  c.rows.forEach((label, i) => (body += text(0, y + 12 + i * rowH + rowH / 2 + 4, label, { size: 12, fill: t.secondary })));
  let bottom = 0;
  c.panels.forEach((p, k) => {
    const out = panel(t, p, labelW + k * (pw + tipRoom + gap), y, pw, rowH);
    body += out.svg;
    bottom = out.bottom;
  });
  if (c.note) body += text(0, bottom + 14, c.note, { size: 11, fill: t.muted });
  return svg(t, body, bottom + (c.note ? 30 : 10), c.title);
}

const pct = (v) => `${v}%`;
const sec = (v) => `${v} s`;
const LOCAL = [
  { key: "plain", label: "OpenCode → Ollama (plain)" },
  { key: "pitcrew", label: "OpenCode → Pit Crew → Ollama" },
];

const charts = {
  // docs/BENCHMARKS.md "M4" and "Final comparison" (qwen3.5:9b, 24 GB M5, valid runs only).
  "bench-routine": (t) =>
    stacked(t, {
      title: "Same model, same tasks: what Pit Crew changes on routine work",
      subtitle: "qwen3.5:9b on a 24 GB MacBook (M5), tasks A–F with hidden checks · plain: 3 runs, Pit Crew mode C: 2 runs",
      legend: LOCAL,
      panels: [
        { heading: "Tasks passed (higher is better)", max: 100, ticks: [0, 25, 50, 75, 100], fmt: pct, rows: [
          { label: "plain", value: 61, key: "plain", tip: "61% (11/18)" },
          { label: "Pit Crew", value: 92, key: "pitcrew", tip: "92% (11/12)" },
        ] },
        { heading: "Median time per passed task (lower is better)", max: 400, ticks: [0, 100, 200, 300, 400], fmt: sec, rows: [
          { label: "plain", value: 341, key: "plain", tip: "341 s" },
          { label: "Pit Crew", value: 123, key: "pitcrew", tip: "123 s" },
        ] },
        { heading: "Wait before the agent's first step, range of run averages (lower is better)", max: 400, ticks: [0, 100, 200, 300, 400], fmt: sec, rows: [
          { label: "plain", lo: 275, hi: 370, key: "plain", tip: "275–370 s" },
          { label: "Pit Crew", lo: 9, hi: 20, key: "pitcrew", tip: "9–20 s" },
        ] },
      ],
    }),
  "bench-vs-cloud": (t) =>
    sideBySide(t, {
      title: "Local vs cloud: routine work is close, hard work is not (yet)",
      subtitle: "Same 16 tasks, prompts, hidden checks and 900 s limit · local = qwen3.5:9b, free, offline",
      legend: [...LOCAL, { key: "cloud", label: "Claude Code (cloud)" }],
      rows: ["OpenCode → Ollama", "OpenCode → Pit Crew", "Claude Code · Opus 4.5", "Claude Code · Opus 4.6", "Claude Code · Opus 4.7"],
      panels: [
        { heading: "Routine A–F passed", max: 100, ticks: [0, 50, 100], fmt: pct, rows: [
          { value: 61, key: "plain", tip: "61%" },
          { value: 92, key: "pitcrew", tip: "92%" },
          { value: 100, key: "cloud", tip: "100%" },
          { value: 100, key: "cloud", tip: "100%" },
          { value: 100, key: "cloud", tip: "100%" },
        ] },
        { heading: "Hard G–P passed", max: 100, ticks: [0, 50, 100], fmt: pct, rows: [
          { value: 13, key: "plain", tip: "13% (1/8)" },
          { value: 13, key: "pitcrew", tip: "13% (1/8)" },
          { value: 93, key: "cloud", tip: "93%" },
          { value: 90, key: "cloud", tip: "90%" },
          { value: 100, key: "cloud", tip: "100%" },
        ] },
      ],
      note: "Local hard-task numbers are 1 run each; routine 2–3 runs; Claude 3 runs per model (≈ $17–31 API-equivalent per 48 tasks).",
    }),
  "bench-load": (t) =>
    stacked(t, {
      title: "Six clients, three models, one 24 GB Mac: the trade-off",
      subtitle: "Load test round 2, median of 3 interleaved repeats · 18/18 requests succeeded in both setups",
      legend: [{ key: "plain", label: "Ollama direct" }, { key: "pitcrew", label: "through Pit Crew" }],
      panels: [
        { heading: "Coding agent, p95 latency (the request you are waiting on)", max: 40, ticks: [0, 10, 20, 30, 40], fmt: sec, rows: [
          { label: "direct", value: 27.9, key: "plain", tip: "27.9 s" },
          { label: "Pit Crew", value: 14.9, key: "pitcrew", tip: "14.9 s" },
        ] },
        { heading: "Background chat, p95 latency (yields to the agent)", max: 40, ticks: [0, 10, 20, 30, 40], fmt: sec, rows: [
          { label: "direct", value: 16.2, key: "plain", tip: "16.2 s" },
          { label: "Pit Crew", value: 32.8, key: "pitcrew", tip: "32.8 s" },
        ] },
        { heading: "Total time for all 18 requests", max: 50, ticks: [0, 10, 20, 30, 40, 50], fmt: sec, rows: [
          { label: "direct", value: 39.9, key: "plain", tip: "39.9 s" },
          { label: "Pit Crew", value: 43.0, key: "pitcrew", tip: "43.0 s" },
        ] },
      ],
    }),
};

mkdirSync(OUT, { recursive: true });
for (const [name, make] of Object.entries(charts)) {
  for (const [mode, t] of Object.entries(THEMES)) {
    const file = join(OUT, `${name}${mode === "dark" ? "-dark" : ""}.svg`);
    writeFileSync(file, make(t));
    console.log(file);
  }
}
