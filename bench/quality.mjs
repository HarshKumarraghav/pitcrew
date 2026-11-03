#!/usr/bin/env node
// M8.2 quality score beyond pass/fail, same rubric for every agent:
//   hidden checks passed (fraction) · tests weakened or existing tests edited · diff size vs the
//   reference solution (lines added+removed; ≫ 1 means sprawling changes) · pass.
// Score per task (0–100): 60 × hidden-check fraction + 20 × (tests not weakened/edited)
//   + 20 × size factor (1 if ≤ 2× the reference, falling linearly to 0 at 6×). A task without a
//   verifier uses its pass/fail for the first term. Blind human review is separate (blind-pack.mjs).
//
// usage: node bench/quality.mjs [label-prefix…]   (default: every results dir)
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { TASKS } from "./agent/tasks.mjs";
import { prepareTaskDir, evaluate, overlay } from "./agent/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "agent", "results");
const CACHE = join(HERE, "agent", "reference", "sizes.json");

/** Reference diff size per task (computed once by applying the reference solution). */
export function referenceSizes() {
  let cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  let dirty = false;
  for (const [k, task] of Object.entries(TASKS)) {
    if (cache[k] !== undefined || !task.reference?.overlay) continue;
    const dir = join(tmpdir(), "pitcrew-refsize", k);
    const rev = prepareTaskDir(task, dir);
    overlay(dir, task.reference.overlay);
    const r = evaluate(task, dir, "", rev);
    cache[k] = r.diff.added + r.diff.removed;
    dirty = true;
  }
  if (dirty) {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  }
  return cache;
}

export function score(t, refSize) {
  const hidden = t.verify ? (t.verify.pass + t.verify.fail ? t.verify.pass / (t.verify.pass + t.verify.fail) : 0) : t.success ? 1 : 0;
  const weakened = Boolean(t.diff?.testsWeakened) || t.checks?.existingTestsUntouched === false;
  const size = t.diff ? t.diff.added + t.diff.removed : undefined;
  const ratio = size !== undefined && refSize ? size / refSize : undefined;
  const sizeFactor = ratio === undefined ? 1 : ratio <= 2 ? 1 : Math.max(0, 1 - (ratio - 2) / 4);
  return { hidden, weakened, ratio, total: Math.round(60 * hidden + 20 * (weakened ? 0 : 1) + 20 * sizeFactor) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prefixes = process.argv.slice(2);
  const refs = referenceSizes();
  const runs = readdirSync(RESULTS).filter((d) => !prefixes.length || prefixes.some((p) => d.startsWith(p)));
  const byCfg = new Map();
  for (const run of runs) {
    const cfg = run.replace(/-r\d+$/, "");
    for (const f of readdirSync(join(RESULTS, run)).filter((x) => /^[A-Z]\.json$/.test(x))) {
      const t = JSON.parse(readFileSync(join(RESULTS, run, f), "utf8"));
      if (!t.diff || t.invalid) continue; // pre-M7.1 runs have no diff record; slept runs are invalid
      const s = score(t, refs[t.task]);
      if (!byCfg.has(cfg)) byCfg.set(cfg, []);
      byCfg.get(cfg).push({ task: t.task, success: t.success, ...s });
    }
  }
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  console.log("| configuration | tasks scored | pass | quality score (mean) | routine A–F | hard G–P | hidden checks | tests weakened/edited | diff / reference (median) |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const [cfg, rows] of [...byCfg].sort()) {
    const ratios = rows.map((r) => r.ratio).filter((x) => x !== undefined).sort((a, b) => a - b);
    const med = ratios.length ? ratios[Math.floor(ratios.length / 2)] : NaN;
    const part = (set) => avg(rows.filter((r) => set.includes(r.task)).map((r) => r.total));
    console.log(`| \`${cfg}\` | ${rows.length} | ${rows.filter((r) => r.success).length}/${rows.length} | ${avg(rows.map((r) => r.total)).toFixed(1)} | ${part("ABCDEF").toFixed(1)} | ${part("GHIJKLMNOP").toFixed(1)} | ${(100 * avg(rows.map((r) => r.hidden))).toFixed(0)}% | ${rows.filter((r) => r.weakened).length} | ${Number.isFinite(med) ? med.toFixed(2) + "×" : "—"} |`);
  }
}
