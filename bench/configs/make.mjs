#!/usr/bin/env node
// Generates the gateway configs used by the benchmark runs (bench/configs/*.json) from
// examples/pitcrew.config.json, so every variant differs from "today" in exactly the named way.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(HERE, "..", "..", "examples", "pitcrew.config.json"), "utf8"));
const clone = () => structuredClone(base);
const LEVERS = {
  reasoning: (c) => (c.router.reasoningBudget = { enabled: true, afterRead: "low", maxTokens: {} }),
  context: (c) => (c.router.injectContext = { enabled: true, k: 6, maxChars: 3000 }),
  hints: (c) => (c.router.loopHints = true),
  repair: (c) => (c.router.testRepair = true),
  plan: (c) => (c.router.planFirst = true),
};
const cap = (c) => (c.models.coder.maxResidentGiB = 10);
const out = {
  today: clone(),
  cap: (() => { const c = clone(); cap(c); return c; })(),
  "levers-all": (() => { const c = clone(); cap(c); for (const f of Object.values(LEVERS)) f(c); return c; })(),
};
for (const drop of Object.keys(LEVERS)) {
  const c = clone();
  cap(c);
  for (const [k, f] of Object.entries(LEVERS)) if (k !== drop) f(c);
  out[`levers-minus-${drop}`] = c;
}
for (const [name, c] of Object.entries(out)) writeFileSync(join(HERE, `${name}.json`), JSON.stringify(c, null, 2) + "\n");
console.log(Object.keys(out).join(" "));
