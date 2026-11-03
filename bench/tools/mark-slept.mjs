#!/usr/bin/env node
// Marks agent results recorded before sleep detection existed as invalid when the Mac was asleep
// during the run (from `pmset -g log`: Sleep → next Wake/DarkWake). Adds `sleptS` and `invalid`.
// usage: node bench/tools/mark-slept.mjs [results-dir…]   (default: all of bench/agent/results)
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "results");
const log = execSync("pmset -g log", { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const sleeps = [];
let start;
for (const line of log.split("\n")) {
  const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}) (Sleep|Wake|DarkWake) {2,}/.exec(line);
  if (!m) continue;
  const t = Date.parse(m[1].replace(" ", "T").replace(/ ([+-]\d\d)(\d\d)$/, "$1:$2"));
  if (m[2] === "Sleep") {
    if (/Entering Sleep state/.test(line)) start ??= t;
  } else if (start !== undefined) {
    sleeps.push([start, t]);
    start = undefined;
  }
}
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(RESULTS).map((d) => join(RESULTS, d));
let marked = 0;
for (const dir of dirs) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir).filter((x) => /^[A-Z]\.json$/.test(x))) {
    const p = join(dir, f);
    const r = JSON.parse(readFileSync(p, "utf8"));
    if (!r.startedAtMs || r.sleptBy === "clock") continue; // measured by the harness itself
    const slept = sleeps.reduce((a, [s, e]) => a + Math.max(0, Math.min(e, r.endedAtMs) - Math.max(s, r.startedAtMs)), 0) / 1000;
    r.sleptS = Math.round(slept);
    r.sleptBy = "pmset";
    delete r.invalid;
    if (slept > 5) {
      r.invalid = `machine slept ${Math.round(slept)} s (pmset log)`;
      marked++;
      console.log(`${dir.split("/").pop()}/${f}: ${r.invalid}`);
    }
    writeFileSync(p, JSON.stringify(r, null, 2));
  }
}
console.log(`${sleeps.length} sleep periods in the power log; ${marked} results marked invalid`);
