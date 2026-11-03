import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectExample, exportDataset, planTune, scanSecrets, learnDir } from "../src/learn/examples.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "agent", "fixture");

function repoWithChange(change: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "pitcrew-learn-"));
  cpSync(FIXTURE, dir, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  g("init", "-q");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  change(dir);
  return dir;
}

test("secret scanner catches common credentials", () => {
  assert.deepEqual(scanSecrets("const k = 'AKIAABCDEFGHIJKLMNOP'"), ["AWS access key"]);
  assert.ok(scanSecrets('api_key = "abcd1234efgh5678"').includes("generic secret assignment"));
  assert.deepEqual(scanSecrets("const x = 1"), []);
});

test("collects an approved example only when tests pass, outside the repo", () => {
  const state = mkdtempSync(join(tmpdir(), "pitcrew-state-"));
  const repo = repoWithChange((d) => {
    const p = join(d, "src/utils/paginate.ts");
    writeFileSync(p, readFileSync(p, "utf8").replace("Math.min(100,", "Math.min(200,"));
  });
  const r = collectExample({ repo, task: "allow page sizes up to 200", approved: true, stateDir: state });
  assert.deepEqual(r.problems, []);
  assert.ok(r.written?.startsWith(state));
  assert.equal(r.example.tests.passed, true);
  assert.match(r.example.patch, /Math\.min\(200/);
  assert.match(r.example.context, /paginate/);
});

test("refuses failing tests and secrets; does not write unapproved examples", () => {
  const state = mkdtempSync(join(tmpdir(), "pitcrew-state-"));
  const broken = repoWithChange((d) => writeFileSync(join(d, "src/utils/slugify.ts"), "export function slugify(t: string) { return t; }\n"));
  const r1 = collectExample({ repo: broken, task: "simplify slugify", approved: true, stateDir: state });
  assert.ok(r1.problems.some((p) => p.startsWith("tests failed")));
  assert.equal(r1.written, undefined);

  const leaky = repoWithChange((d) => writeFileSync(join(d, "src/config.ts"), 'export const token = "ghp_' + "a".repeat(36) + '";\n'));
  const r2 = collectExample({ repo: leaky, task: "add config", approved: true, stateDir: state });
  assert.ok(r2.problems.some((p) => p.includes("GitHub token")));

  const ok = repoWithChange((d) => writeFileSync(join(d, "src/x.ts"), "export const x = 1;\n"));
  const r3 = collectExample({ repo: ok, task: "add x", approved: false, stateDir: state });
  assert.equal(r3.written, undefined, "unapproved examples are never written");
});

test("exports MLX-LM chat-format splits and rejects bad rows", () => {
  const state = mkdtempSync(join(tmpdir(), "pitcrew-state-"));
  const repo = repoWithChange((d) => writeFileSync(join(d, "src/y.ts"), "export const y = 2;\n"));
  const r = collectExample({ repo, task: "add y", approved: true, stateDir: state });
  const file = r.written!;
  // Append a tampered row (tests failed) and a duplicate.
  const bad = { ...r.example, id: "ffffffffffff", tests: { ...r.example.tests, passed: false } };
  writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify(bad) + "\n" + JSON.stringify(r.example) + "\n");
  const out = join(learnDir(repo, state), "dataset");
  const rep = exportDataset(file, out);
  assert.equal(rep.total, 3);
  assert.equal(rep.kept, 1);
  assert.deepEqual(rep.rejected.map((x) => x.reason).sort(), ["duplicate", "tests did not pass"]);
  const rows = readFileSync(join(out, "train.jsonl"), "utf8") + readFileSync(join(out, "valid.jsonl"), "utf8");
  const msg = JSON.parse(rows.trim().split("\n")[0]!).messages;
  assert.deepEqual(msg.map((m: { role: string }) => m.role), ["system", "user", "assistant"]);
});

test("tune plan refuses tiny datasets and insufficient memory, and never runs anything", () => {
  const p = planTune({ dataDir: "/d", hfModel: "Qwen/Qwen3.5-9B", paramsB: 9.7, availableGiB: 3, trainRows: 4, adapterDir: "/a" });
  assert.equal(p.ok, false);
  assert.equal(p.reasons.length, 2);
  assert.equal(p.command[0], "mlx_lm.lora");
  const ok = planTune({ dataDir: "/d", hfModel: "Qwen/Qwen3.5-0.8B", paramsB: 0.8, availableGiB: 12, trainRows: 80, adapterDir: "/a" });
  assert.equal(ok.ok, true);
});
