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

export interface StepInfo {
  step: StepClass;
  /** Consecutive trailing assistant turns with the same tool calls (1 = no repeat). */
  repeat: number;
  tools: string[];
  /** Set when the last edit failed because oldString did not match. */
  editMiss?: { filePath: string; oldString: string };
  repeatedCall?: string;
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
    if (name === "bash" && TEST_FAIL.test(text)) testFail = true;
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

  // ── reasoning budget ──
  if (cfg.reasoningBudget.enabled) {
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
  if (cfg.testRepair && step.step === "after-test-fail") {
    hints.push(REPAIR_HINT);
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
