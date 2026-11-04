import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { RouterConfig } from "../config.ts";
import { formatContext, retrieve, scanProject } from "../intel/index.ts";

/**
 * Per-step levers for agent turns (M7.3–7.5, M8.3). Every decision is made from the request's
 * own messages, so the gateway keeps no conversation state; the only cache is the retrieval
 * block per session, which must be byte-identical on every request to keep the prefix cache hot.
 *
 * Earlier messages are never rewritten. Additions go to two places only:
 *  - a stable block at the end of the first system message (same bytes every request), and
 *  - a short hint appended after the last message (this request only).
 */

export type StepClass = "first" | "after-read" | "after-edit" | "after-test-fail" | "after-error" | "repeat" | "after-other";

type Msg = { role?: string; content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[]; tool_call_id?: string };

const READ_ONLY = new Set(["read", "glob", "grep", "list", "ls", "todoread"]);
/** Error results as OpenCode reports them (captured 11-04, OpenCode 1.18.35). */
const TOOL_ERROR = /^(File not found|Could not find oldString|Error\b|error:|The user has specified a rule|Invalid|invalid arguments|Tool .* (not found|failed))|is not a valid tool|unknown tool/i;
const TEST_FAIL = /^# fail [1-9]|^not ok \d|^\s*FAIL\b|AssertionError|npm ERR!|\b[1-9]\d* (failed|failing)\b/m;
const EDIT_MISS = /^Could not find oldString/;

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}

function signature(m: Msg): string {
  return (m.tool_calls ?? []).map((t) => `${t.function?.name}(${typeof t.function?.arguments === "string" ? t.function.arguments : JSON.stringify(t.function?.arguments ?? {})})`).join("|");
}

export interface FailingTest {
  name: string;
  /** Short location, e.g. "tests/slugify.test.ts:13". */
  where?: string;
  /** Expected vs actual, or the first line of the error. */
  detail?: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const shortPath = (p: string) => p.replace(/^file:\/\//, "").split("/").slice(-2).join("/").replace(/:(\d+):\d+$/, ":$1");

/**
 * Failing tests in a test run's output: node:test (TAP), Jest, Vitest, pytest. Names plus a short
 * assertion summary taken from the output itself; at most `max`.
 */
export function failingTests(out: string, max = 8): FailingTest[] {
  const lines = out.split("\n");
  const found: FailingTest[] = [];
  const seen = new Set<string>();
  const add = (t: FailingTest) => {
    if (!t.name || seen.has(t.name) || found.length >= max) return;
    seen.add(t.name);
    found.push({ ...t, name: clip(t.name, 160), ...(t.detail ? { detail: clip(t.detail, 200) } : {}) });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // node:test: `not ok 3 - name` + an indented YAML block ending in `...`.
    const tap = /^(\s*)not ok \d+ - (.+?)\s*(?:#.*)?$/.exec(line);
    if (tap) {
      const yaml: string[] = [];
      for (let j = i + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]!) && !/^\s*(not )?ok \d+/.test(lines[j]!); j++) yaml.push(lines[j]!);
      const y = yaml.join("\n");
      if (/failureType: 'subtestsFailed'/.test(y)) continue; // a suite, its tests are listed too
      const field = (k: string) => new RegExp(`^\\s*${k}: (.+)$`, "m").exec(y)?.[1]?.trim();
      const loc = field("location")?.replace(/^'|'$/g, "");
      const exp = field("expected");
      const act = field("actual");
      const err = /^\s*error: (?:\|-?\s*\n\s*)?(.+)$/m.exec(y)?.[1]?.trim().replace(/^'|'$/g, "");
      add({ name: tap[2]!, where: loc ? shortPath(loc) : undefined, detail: exp !== undefined && act !== undefined ? `expected ${exp}, actual ${act}` : err });
      continue;
    }
    // pytest: `FAILED tests/test_x.py::test_name - AssertionError: …`
    const py = /^FAILED (\S+?)::(\S+)(?: - (.*))?$/.exec(line);
    if (py) {
      add({ name: py[2]!, where: py[1], detail: py[3] });
      continue;
    }
    // Jest: `● Suite › name`, then Expected:/Received: lines.
    const jest = /^\s*● (.+?)\s*$/.exec(line);
    if (jest && !/Test suite failed to run/.test(jest[1]!)) {
      const near = lines.slice(i + 1, i + 15);
      const ex = near.find((l) => /^\s*Expected\b/.test(l))?.trim();
      const rc = near.find((l) => /^\s*Received\b/.test(l))?.trim();
      add({ name: jest[1]!, detail: ex && rc ? `${ex}, ${rc}` : near.find((l) => l.trim())?.trim() });
      continue;
    }
    // Vitest: ` FAIL  tests/a.test.ts > suite > name`, then `AssertionError: …`.
    const vi = /^\s*FAIL\s+(\S+\.[cm]?[jt]sx?)\s+>\s+(.+?)\s*$/.exec(line);
    if (vi) add({ name: vi[2]!, where: vi[1], detail: lines.slice(i + 1, i + 12).find((l) => /Error:/.test(l))?.trim() });
  }
  return found;
}

/** Signals that the current approach is not working (each needs 3 in a row). */
export interface StuckSignal {
  kind: "same-failing-test" | "no-diff-progress" | "tool-error-streak";
  count: number;
  /** Test name, or the failing tool names. Never file contents. */
  detail?: string;
}

export interface StepInfo {
  step: StepClass;
  /** Consecutive trailing assistant turns with the same tool calls (1 = no repeat). */
  repeat: number;
  tools: string[];
  /** Set when the last edit failed because oldString did not match. */
  editMiss?: { filePath: string; oldString: string };
  repeatedCall?: string;
  /** Failing tests in the last test run (when step is after-test-fail). */
  failing?: FailingTest[];
  stuck?: StuckSignal;
}

const STUCK_AFTER = 3;
const EDIT_OK = /applied successfully|Wrote file successfully|^\s*$/i;

/** Every tool call in order, with its name, arguments and result text. */
function toolHistory(msgs: Msg[]): { name: string; args: Record<string, unknown>; result: string; turn: number }[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown>; turn: number }>();
  const out: { name: string; args: Record<string, unknown>; result: string; turn: number }[] = [];
  msgs.forEach((m, turn) => {
    if (m.role === "assistant") {
      for (const t of m.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          const a = typeof t.function?.arguments === "string" ? JSON.parse(t.function.arguments) : t.function?.arguments;
          if (a && typeof a === "object") args = a as Record<string, unknown>;
        } catch {
          // unparsable arguments
        }
        if (t.id) calls.set(t.id, { name: t.function?.name ?? "", args, turn });
      }
    } else if (m.role === "tool") {
      const c = calls.get(m.tool_call_id ?? "");
      if (c) out.push({ ...c, result: textOf(m.content) });
    }
  });
  return out;
}

const isTestRun = (h: { name: string; result: string }) => h.name === "bash" && (TEST_FAIL.test(h.result) || /^# (pass|fail) \d+|\bTests?:\s+\d+|\b\d+ passed\b/m.test(h.result));

/** Stuck signals that fire on this step (the trigger must be in the latest tool results). */
export function stuckSignal(msgs: Msg[], lastA: number): StuckSignal | undefined {
  const hist = toolHistory(msgs);
  const latest = hist.filter((h) => h.turn === lastA);
  if (!latest.length) return undefined;

  // Same failing test in the last 3 test runs.
  if (latest.some(isTestRun)) {
    const runs = hist.filter(isTestRun).map((h) => new Set(failingTests(h.result, 50).map((t) => t.name)));
    let common = runs.at(-1) ?? new Set<string>();
    let n = common.size ? 1 : 0;
    for (let i = runs.length - 2; i >= 0 && n && n < 99; i--) {
      const next = new Set([...common].filter((x) => runs[i]!.has(x)));
      if (!next.size) break;
      common = next;
      n++;
    }
    if (n >= STUCK_AFTER) return { kind: "same-failing-test", count: n, detail: [...common][0] };
  }

  // Edits that change nothing: failed, a repeat of an earlier edit, or the inverse of one.
  if (latest.some((h) => h.name === "edit" || h.name === "write")) {
    const seen = new Set<string>();
    const useless: boolean[] = [];
    for (const h of hist) {
      if (h.name !== "edit" && h.name !== "write") continue;
      const f = String(h.args.filePath ?? "");
      const key = h.name === "edit" ? `e\0${f}\0${h.args.oldString}\0${h.args.newString}` : `w\0${f}\0${h.args.content}`;
      const inverse = h.name === "edit" ? `e\0${f}\0${h.args.newString}\0${h.args.oldString}` : "";
      useless.push(TOOL_ERROR.test(h.result.slice(0, 300)) || !EDIT_OK.test(h.result.slice(0, 200)) || seen.has(key) || seen.has(inverse));
      seen.add(key);
    }
    let n = 0;
    for (let i = useless.length - 1; i >= 0 && useless[i]; i--) n++;
    if (n >= STUCK_AFTER) return { kind: "no-diff-progress", count: n };
  }

  // Tool-error streak across turns.
  let n = 0;
  for (let i = hist.length - 1; i >= 0 && TOOL_ERROR.test(hist[i]!.result.slice(0, 300)); i--) n++;
  if (n >= STUCK_AFTER) return { kind: "tool-error-streak", count: n, detail: [...new Set(hist.slice(-n).map((h) => h.name))].join(", ") };
  return undefined;
}

export function classifyStep(body: Record<string, unknown>): StepInfo {
  const msgs = ((body.messages as Msg[] | undefined) ?? []).filter(Boolean);
  let lastA = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === "assistant") { lastA = i; break; }
  const last = msgs[msgs.length - 1];
  if (lastA < 0 || last?.role === "user" || last?.role === "system") return { step: "first", repeat: 1, tools: [] };
  const a = msgs[lastA]!;
  const results = msgs.slice(lastA + 1).filter((m) => m.role === "tool");
  const nameOf = (id?: string) => a.tool_calls?.find((t) => t.id === id)?.function?.name ?? "";
  const tools = results.map((r) => nameOf(r.tool_call_id));

  // Repeat count over the trailing assistant turns.
  const sig = signature(a);
  let repeat = 1;
  if (sig) {
    for (let i = lastA - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role !== "assistant") continue;
      if (signature(m) === sig) repeat++;
      else break;
    }
  }
  const info: StepInfo = { step: "after-other", repeat, tools };
  if (repeat >= 2) info.repeatedCall = sig.slice(0, 200);

  let error = false;
  let testFail = false;
  for (const r of results) {
    const text = textOf(r.content);
    const name = nameOf(r.tool_call_id);
    if (TOOL_ERROR.test(text.slice(0, 300))) error = true;
    if (name === "bash" && TEST_FAIL.test(text)) {
      testFail = true;
      info.failing = failingTests(text);
    }
    if ((name === "edit" || name === "write") && EDIT_MISS.test(text)) {
      const call = a.tool_calls?.find((t) => t.id === r.tool_call_id);
      try {
        const args = typeof call?.function?.arguments === "string" ? JSON.parse(call.function.arguments) : call?.function?.arguments;
        if (args?.filePath) info.editMiss = { filePath: String(args.filePath), oldString: String(args.oldString ?? "") };
      } catch {
        // unparsable arguments: no excerpt
      }
    }
  }
  // Escalation order: a repeated call or an error means the cheap path is not working.
  if (repeat >= 2) info.step = "repeat";
  else if (error) info.step = "after-error";
  else if (testFail) info.step = "after-test-fail";
  else if (tools.length && tools.every((t) => READ_ONLY.has(t))) info.step = "after-read";
  else if (tools.some((t) => t === "edit" || t === "write")) info.step = "after-edit";
  const stuck = stuckSignal(msgs, lastA);
  if (stuck) info.stuck = stuck;
  return info;
}

/** `Working directory: …` from OpenCode's <env> block. */
export function workingDir(body: Record<string, unknown>): string | undefined {
  const msgs = (body.messages as Msg[] | undefined) ?? [];
  const sys = msgs.find((m) => m.role === "system");
  const m = /Working directory:\s*(\S+)/.exec(textOf(sys?.content));
  return m?.[1];
}

function firstUserText(body: Record<string, unknown>): string {
  const msgs = (body.messages as Msg[] | undefined) ?? [];
  return textOf(msgs.find((m) => m.role === "user")?.content);
}

/** A file inside `root` (symlinks resolved), or undefined. */
function inside(root: string, file: string): string | undefined {
  try {
    const r = realpathSync(root);
    const f = realpathSync(isAbsolute(file) ? file : resolve(root, file));
    const rel = relative(r, f);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? f : undefined;
  } catch {
    return undefined;
  }
}

/** The region of the file closest to where oldString was meant to match, with line numbers. */
export function editExcerpt(text: string, oldString: string, maxChars = 3000): string {
  const lines = text.split("\n");
  const probe = oldString.split("\n").map((l) => l.trim()).filter((l) => l.length > 3);
  let at = -1;
  for (const p of probe) {
    at = lines.findIndex((l) => l.includes(p));
    if (at >= 0) break;
  }
  const from = at >= 0 ? Math.max(0, at - 12) : 0;
  const to = Math.min(lines.length, at >= 0 ? at + Math.max(probe.length, 1) + 12 : 60);
  let out = "";
  for (let i = from; i < to; i++) {
    const row = `${i + 1}: ${lines[i]}\n`;
    if (out.length + row.length > maxChars) break;
    out += row;
  }
  return out;
}

export interface LeverResult {
  step: StepInfo;
  applied: string[];
}

export interface LeverContext {
  session?: string;
  /** Cache of the stable system block per session; owned by the gateway. */
  blocks: Map<string, string>;
}

const PLAN_LINE = "Before your first tool call, write a short plan: which files to inspect, what to change, and how you will verify it (which test command).";
const REPAIR_HINT = "[Pit Crew] The test run above failed. Read the failure, fix the source code so the failing tests pass, and do not modify, skip or delete tests. Then run the tests again.";

/** The repair hint, quoting the failing tests and their assertions when the output has them. */
export function repairHint(failing: FailingTest[] | undefined): string {
  if (!failing?.length) return REPAIR_HINT;
  const rows = failing.slice(0, 5).map((t) => `- ${t.name}${t.where ? ` (${t.where})` : ""}${t.detail ? `: ${t.detail}` : ""}`);
  const more = failing.length > 5 ? `\n- …and ${failing.length - 5} more` : "";
  return `[Pit Crew] The test run above failed:\n${rows.join("\n")}${more}\nFix the source code so these pass; do not modify, skip or delete tests. Then run the tests again.`;
}

export function stuckHint(s: StuckSignal): string {
  if (s.kind === "same-failing-test") {
    return `[Pit Crew] "${s.detail}" has failed ${s.count} test runs in a row, so the current approach is not working. Stop patching around it: re-read that test and the code it calls, write down the expected and the actual value, find where they diverge, then make one focused change.`;
  }
  if (s.kind === "no-diff-progress") {
    return `[Pit Crew] Your last ${s.count} edits changed nothing (they failed, repeated an earlier edit, or undid one). Read the current file before the next edit and make one small change you have not tried yet.`;
  }
  return `[Pit Crew] Your last ${s.count} tool calls all failed (${s.detail}). Read the error messages: use paths inside the working directory and the exact argument names the tool expects.`;
}

/**
 * Apply the enabled levers to an agent request body (mutates `body`). Returns what was done, for
 * telemetry. Levers are off unless enabled in `router.*`.
 */
export function applyLevers(body: Record<string, unknown>, cfg: RouterConfig, ctx: LeverContext): LeverResult {
  const step = classifyStep(body);
  const applied: string[] = [];
  const msgs = [...((body.messages as Msg[] | undefined) ?? [])];

  // ── stable system block: retrieval context + plan-first instruction ──
  if ((cfg.injectContext.enabled || cfg.planFirst) && ctx.session) {
    let block = ctx.blocks.get(ctx.session);
    if (block === undefined) {
      block = buildBlock(body, cfg);
      ctx.blocks.set(ctx.session, block);
      if (ctx.blocks.size > 200) ctx.blocks.delete(ctx.blocks.keys().next().value!);
    }
    const si = msgs.findIndex((m) => m.role === "system");
    if (block && si >= 0) {
      const sys = msgs[si]!;
      msgs[si] = typeof sys.content === "string"
        ? { ...sys, content: `${sys.content}\n\n${block}` }
        : { ...sys, content: [...((sys.content as unknown[]) ?? []), { type: "text", text: `\n\n${block}` }] };
      applied.push("context");
    }
  }

  // ── reasoning budget (never cheaper while stuck: escalation rule) ──
  if (cfg.reasoningBudget.enabled && !step.stuck) {
    if (step.step === "after-read") {
      body.reasoning_effort = cfg.reasoningBudget.afterRead;
      applied.push(`reasoning:${cfg.reasoningBudget.afterRead}`);
    }
    const cap = cfg.reasoningBudget.maxTokens[step.step];
    if (cap) {
      const cur = Number(body.max_tokens ?? body.max_completion_tokens ?? Number.POSITIVE_INFINITY);
      if (cap < cur) {
        body.max_tokens = cap;
        delete body.max_completion_tokens;
        applied.push(`max_tokens:${cap}`);
      }
    }
  }

  // ── hints after the last message ──
  const hints: string[] = [];
  if (cfg.loopHints) {
    if (step.repeat >= 3) {
      hints.push(`[Pit Crew] You have made the same tool call ${step.repeat} times in a row and got the same result each time. Use the result you already have, or take a different step.`);
      applied.push("hint:loop");
    }
    if (step.editMiss) {
      const root = workingDir(body);
      const file = root ? inside(root, step.editMiss.filePath) : undefined;
      if (file) {
        try {
          if (statSync(file).size < 2_000_000) {
            const ex = editExcerpt(readFileSync(file, "utf8"), step.editMiss.oldString);
            hints.push(`[Pit Crew] The edit failed because oldString does not match the file exactly. Current content of ${step.editMiss.filePath} near the intended spot:\n${ex}Copy oldString from these lines exactly (without the line-number prefix).`);
            applied.push("hint:edit-excerpt");
          }
        } catch {
          // unreadable file: no hint
        }
      }
    }
  }
  if (cfg.stuckHints && step.stuck) {
    hints.push(stuckHint(step.stuck));
    applied.push(`hint:stuck-${step.stuck.kind}`);
  }
  if (cfg.testRepair && step.step === "after-test-fail") {
    hints.push(repairHint(step.failing));
    applied.push("hint:test-repair");
  }
  if (hints.length) msgs.push({ role: "user", content: hints.join("\n\n") });
  if (applied.length) body.messages = msgs;
  return { step, applied };
}

function buildBlock(body: Record<string, unknown>, cfg: RouterConfig): string {
  const parts: string[] = [];
  if (cfg.planFirst) parts.push(PLAN_LINE);
  if (cfg.injectContext.enabled) {
    const root = workingDir(body);
    const task = firstUserText(body);
    if (root && task) {
      try {
        const { index, sources } = scanProject(root);
        if (sources.length) {
          const hits = retrieve(root, task, { k: cfg.injectContext.k, index, sources });
          let ctxText = formatContext(task.slice(0, 200), hits, index);
          if (ctxText.length > cfg.injectContext.maxChars) ctxText = ctxText.slice(0, cfg.injectContext.maxChars) + "\n…\n";
          parts.push(`Repository map (from Pit Crew's index; verify by reading files):\n${ctxText}`);
        }
      } catch {
        // no index: no block
      }
    }
  }
  return parts.length ? `<pitcrew>\n${parts.join("\n\n")}\n</pitcrew>` : "";
}
