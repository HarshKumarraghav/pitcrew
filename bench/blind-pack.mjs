#!/usr/bin/env node
// M8.2 blind review pack: for each configuration, up to 5 solved tasks; their diffs are written
// under anonymous, shuffled ids so the reviewer cannot tell which agent produced which. The answer
// key goes to a separate file — don't open it until the review is done.
//
// usage: node bench/blind-pack.mjs <label> <label> … [--out bench/results/blind] [--per 5] [--seed 1]
// Each <label> is a results config (repeats `-rN` are pooled). Diffs come from the task dirs in
// /tmp/qbench/<run>/<task>, so build the pack before those are cleaned up.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "agent", "results");
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const labels = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const OUT = opt("out", join(HERE, "results", "blind"));
const PER = Number(opt("per", 5));
let seed = Number(opt("seed", 1));
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const items = [];
for (const label of labels) {
  const runs = readdirSync(RESULTS).filter((d) => d === label || d.replace(/-r\d+$/, "") === label);
  const solved = runs.flatMap((run) =>
    readdirSync(join(RESULTS, run)).filter((f) => /^[A-Z]\.json$/.test(f)).map((f) => ({ run, t: JSON.parse(readFileSync(join(RESULTS, run, f), "utf8")) })),
  ).filter(({ run, t }) => t.success && existsSync(`/tmp/qbench/${run}/${t.task}/.git`) && t.baseRev);
  // Prefer tasks that every configuration solved, so reviewers compare like with like.
  solved.sort(() => rand() - 0.5);
  const seen = new Set();
  for (const s of solved) {
    if (seen.has(s.t.task) || seen.size >= PER) continue;
    seen.add(s.t.task);
    const dir = `/tmp/qbench/${s.run}/${s.t.task}`;
    execSync("git add -A -N", { cwd: dir });
    const diff = execSync(`git diff ${s.t.baseRev} -- . ':!.verify'`, { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    items.push({ label, run: s.run, task: s.t.task, name: s.t.name, diff });
  }
}
items.sort(() => rand() - 0.5);
mkdirSync(OUT, { recursive: true });
const key = [];
items.forEach((it, i) => {
  const id = `R${String(i + 1).padStart(2, "0")}-${createHash("sha1").update(it.run + it.task + seed).digest("hex").slice(0, 4)}`;
  writeFileSync(join(OUT, `${id}.diff`), `# Task ${it.task}: ${it.name}\n# Review: correctness, minimality, tests kept honest, readability (1–5 each)\n\n${it.diff}`);
  key.push({ id, label: it.label, run: it.run, task: it.task });
});
writeFileSync(join(OUT, "ANSWER-KEY.json"), JSON.stringify(key, null, 2));
writeFileSync(join(OUT, "scores.csv"), "id,task,correctness,minimality,tests_honest,readability,notes\n" + key.map((k) => `${k.id},${k.task},,,,,`).join("\n") + "\n");
console.log(`${items.length} diffs → ${OUT} (fill scores.csv; ANSWER-KEY.json reveals the agents)`);
