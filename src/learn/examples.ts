import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { projectDir, scanProject, retrieve, formatContext } from "../intel/index.ts";

/** Patterns that must never end up in a training set. */
export const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["OpenAI/Anthropic-style key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["generic secret assignment", /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i],
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function scanSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export interface Example {
  id: string;
  createdAt: string;
  task: string;
  context: string;
  patch: string;
  tests: { command: string; passed: boolean; summary: string };
  provenance: { repo: string; base: string; head: string; license: string; author: "human-reviewed" };
  approved: boolean;
}

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], env: env ?? process.env });
}

/** Diff of the working tree (including new, untracked files) against `base`, via a throwaway index. */
export function workingDiff(root: string, base: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "pitcrew-idx-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
  try {
    git(root, ["read-tree", base], env);
    git(root, ["add", "-A", "."], env);
    return git(root, ["diff", "--cached", base, "--", "."], env);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function detectLicense(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof pkg.license === "string") return pkg.license;
  } catch {
    // no package.json
  }
  for (const f of ["LICENSE", "LICENSE.md", "COPYING"]) {
    const p = join(root, f);
    if (existsSync(p)) return readFileSync(p, "utf8").split("\n")[0]?.trim().slice(0, 80) || "see LICENSE";
  }
  return "unknown";
}

export function learnDir(root: string, stateDir?: string): string {
  return join(projectDir(root, stateDir), "learn");
}

/**
 * Capture one reviewed task as a training example: the diff against `base`, the context
 * Pit Crew would retrieve for the task, and proof that the tests pass. Refuses on failing tests
 * or anything that looks like a secret. Writes only when `approved` is true.
 */
export function collectExample(opts: {
  repo: string;
  task: string;
  base?: string;
  testCommand?: string;
  approved: boolean;
  stateDir?: string;
}): { example: Example; problems: string[]; written?: string } {
  const root = resolve(opts.repo);
  const base = opts.base ?? "HEAD";
  const patch = workingDiff(root, base);
  const head = git(root, ["rev-parse", "--short", "HEAD"]).trim();
  const { index, sources } = scanProject(root);
  const hits = retrieve(root, opts.task, { k: 6, index, sources });
  const context = formatContext(opts.task, hits, index);
  const testCommand = opts.testCommand ?? index.profile.testCommand ?? "npm test";
  const [cmd, ...args] = testCommand.split(" ");
  // A parent node:test run leaks NODE_TEST_CONTEXT, which makes a nested `node --test` report as a
  // subtest and exit 0 even on failures. Run the project's tests in a clean environment.
  const { NODE_TEST_CONTEXT: _ctx, ...cleanEnv } = process.env;
  const run = spawnSync(cmd!, args, { cwd: root, encoding: "utf8", timeout: 10 * 60_000, env: cleanEnv });
  const passed = run.status === 0;
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const summary = out.split("\n").filter((l) => /^# (tests|pass|fail)|passed|failed|Tests:/i.test(l)).slice(-4).join(" | ") || `exit ${run.status}`;

  const problems: string[] = [];
  if (!patch.trim()) problems.push(`no changes relative to ${base}`);
  if (!passed) problems.push(`tests failed (${testCommand}): ${summary}`);
  const secrets = scanSecrets(patch + context + opts.task);
  if (secrets.length) problems.push(`possible secrets: ${secrets.join(", ")}`);
  if ((patch.match(EMAIL) ?? []).length) problems.push("patch contains e-mail addresses (personal data) — review or redact");
  if (patch.length > 200_000) problems.push("patch larger than 200 kB — too big for a training example");

  const example: Example = {
    id: createHash("sha1").update(opts.task + patch).digest("hex").slice(0, 12),
    createdAt: new Date().toISOString(),
    task: opts.task,
    context,
    patch,
    tests: { command: testCommand, passed, summary },
    provenance: { repo: root, base, head, license: detectLicense(root), author: "human-reviewed" },
    approved: opts.approved,
  };
  if (problems.length || !opts.approved) return { example, problems };
  const dir = learnDir(root, opts.stateDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "examples.jsonl");
  appendFileSync(file, JSON.stringify(example) + "\n");
  return { example, problems, written: file };
}

export function loadExamples(file: string): Example[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Example);
}

export interface DatasetReport {
  total: number;
  kept: number;
  rejected: { id: string; reason: string }[];
  train: number;
  valid: number;
  files: string[];
}

const SYSTEM = "You are a coding agent working in this repository. Given the task and the relevant context, produce a unified diff that implements it and keeps the tests passing.";

/** Validate examples and export MLX-LM chat-format train/valid splits (deterministic split by id). */
export function exportDataset(examplesFile: string, outDir: string, validFraction = 0.2): DatasetReport {
  const all = loadExamples(examplesFile);
  const seen = new Set<string>();
  const rejected: DatasetReport["rejected"] = [];
  const kept: Example[] = [];
  for (const e of all) {
    const reason = !e.approved
      ? "not approved"
      : !e.tests?.passed
        ? "tests did not pass"
        : scanSecrets(e.patch + e.context + e.task).length
          ? "secret pattern"
          : seen.has(e.id)
            ? "duplicate"
            : !e.patch.trim()
              ? "empty patch"
              : undefined;
    if (reason) rejected.push({ id: e.id, reason });
    else {
      seen.add(e.id);
      kept.push(e);
    }
  }
  const toRow = (e: Example) =>
    JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Task: ${e.task}\n\n${e.context}` },
        { role: "assistant", content: e.patch },
      ],
    });
  const isValid = (e: Example) => parseInt(e.id.slice(0, 4), 16) / 0xffff < validFraction;
  let valid = kept.filter(isValid);
  let train = kept.filter((e) => !isValid(e));
  if (!valid.length && train.length > 1) valid = [train.pop()!];
  mkdirSync(outDir, { recursive: true });
  const files = [join(outDir, "train.jsonl"), join(outDir, "valid.jsonl"), join(outDir, "provenance.json")];
  writeFileSync(files[0]!, train.map(toRow).join("\n") + (train.length ? "\n" : ""));
  writeFileSync(files[1]!, valid.map(toRow).join("\n") + (valid.length ? "\n" : ""));
  writeFileSync(files[2]!, JSON.stringify(kept.map((e) => ({ id: e.id, ...e.provenance, createdAt: e.createdAt })), null, 2));
  return { total: all.length, kept: kept.length, rejected, train: train.length, valid: valid.length, files };
}

export interface TunePlan {
  ok: boolean;
  reasons: string[];
  command: string[];
  estimateGiB: number;
}

/**
 * Plan (never start) a LoRA run with mlx-lm. Training is an explicit, separate job: the caller must
 * run the printed command themselves, while no inference model is loaded.
 */
export function planTune(opts: { dataDir: string; hfModel: string; paramsB: number; availableGiB: number; trainRows: number; iters?: number; adapterDir: string }): TunePlan {
  // QLoRA-style rough budget: 4-bit weights (~0.55 GB per B params) + activations/optimizer for rank-8 adapters.
  const estimateGiB = Math.round((opts.paramsB * 0.55 + 2 + opts.paramsB * 0.25) * 10) / 10;
  const reasons: string[] = [];
  if (opts.trainRows < 50) reasons.push(`only ${opts.trainRows} training examples; collect ≥ 50 reviewed tasks before tuning is worth measuring`);
  if (estimateGiB > opts.availableGiB) reasons.push(`needs ≈ ${estimateGiB} GiB, only ${opts.availableGiB.toFixed(1)} GiB available — unload models and close apps first`);
  const command = [
    "mlx_lm.lora",
    "--model", opts.hfModel,
    "--train",
    "--data", opts.dataDir,
    "--batch-size", "1",
    "--num-layers", "8",
    "--iters", String(opts.iters ?? Math.max(100, opts.trainRows * 3)),
    "--grad-checkpoint",
    "--adapter-path", opts.adapterDir,
  ];
  return { ok: reasons.length === 0, reasons, command, estimateGiB };
}
