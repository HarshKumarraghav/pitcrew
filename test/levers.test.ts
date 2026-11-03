import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, type RouterConfig } from "../src/config.ts";
import { applyLevers, classifyStep, editExcerpt, type LeverContext } from "../src/server/levers.ts";

// Real OpenCode request (scripted tool calls, no model): read ok, read missing, edit miss, failing
// npm test, glob, the same glob again, grep.
const SESSION = JSON.parse(readFileSync(new URL("./fixtures/opencode-session.json", import.meta.url), "utf8")) as { messages: Record<string, unknown>[]; tools: unknown[] };
const upTo = (n: number) => ({ messages: SESSION.messages.slice(0, n), tools: SESSION.tools });
const on = (over: Partial<RouterConfig> = {}): RouterConfig => ({ ...DEFAULTS.router, reasoningBudget: { enabled: true, afterRead: "low", maxTokens: {} }, ...over });
const ctx = (): LeverContext => ({ session: "s1", blocks: new Map() });

/** A copy of the bench fixture repo, with the captured session pointed at it. */
function repoSession() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pitcrew-lever-")));
  cpSync(new URL("../bench/agent/fixture", import.meta.url), dir, { recursive: true });
  const msgs = structuredClone(SESSION.messages).map((m) => (typeof m.content === "string" ? { ...m, content: m.content.replaceAll("/private/tmp/pc-script/repo", dir) } : m));
  for (const m of msgs) for (const t of (m.tool_calls as { function: { arguments: string } }[] | undefined) ?? []) t.function.arguments = t.function.arguments.replaceAll("/private/tmp/pc-script/repo", dir);
  return { dir, msgs };
}

test("step classes from the captured OpenCode session", () => {
  const steps = [2, 4, 6, 8, 10, 12, 14, 16].map((n) => classifyStep(upTo(n)));
  assert.deepEqual(steps.map((s) => s.step), ["first", "after-read", "after-error", "after-error", "after-test-fail", "after-read", "repeat", "after-read"]);
  assert.equal(steps[3]!.editMiss?.oldString, "THIS DOES NOT EXIST");
  assert.equal(steps[6]!.repeat, 2);
});

test("reasoning budget: cheaper thinking only right after a successful read-only tool", () => {
  const afterRead = upTo(16);
  const r = applyLevers(afterRead, on(), ctx());
  assert.equal((afterRead as Record<string, unknown>).reasoning_effort, "low");
  assert.deepEqual(r.applied, ["reasoning:low"]);
  for (const n of [2, 6, 10, 14]) {
    const b = upTo(n) as Record<string, unknown>;
    applyLevers(b, on(), ctx());
    assert.equal(b.reasoning_effort, undefined, `full thinking at ${classifyStep(upTo(n)).step}`);
  }
  const off = upTo(16) as Record<string, unknown>;
  applyLevers(off, DEFAULTS.router, ctx());
  assert.equal(off.reasoning_effort, undefined, "levers are off by default");
  const capped = upTo(16) as Record<string, unknown>;
  applyLevers(capped, on({ reasoningBudget: { enabled: true, afterRead: "none", maxTokens: { "after-read": 2048 } } }), ctx());
  assert.equal(capped.max_tokens, 2048);
  assert.equal(capped.reasoning_effort, "none");
});

test("injected context is byte-identical on every request and earlier messages are never changed", () => {
  const { msgs } = repoSession();
  const cfg = on({ injectContext: { enabled: true, k: 4, maxChars: 3000 }, planFirst: true });
  const c = ctx();
  const a = { messages: msgs.slice(0, 4), tools: SESSION.tools } as Record<string, unknown>;
  const b = { messages: msgs.slice(0, 12), tools: SESSION.tools } as Record<string, unknown>;
  applyLevers(a, cfg, c);
  applyLevers(b, cfg, c);
  const am = a.messages as { content: string }[];
  const bm = b.messages as { content: string }[];
  assert.equal(am[0]!.content, bm[0]!.content, "same system block on both requests");
  assert.match(am[0]!.content, /<pitcrew>[\s\S]*Relevant files[\s\S]*src\/utils\/slugify\.ts/);
  assert.match(am[0]!.content, /short plan/);
  assert.ok(am[0]!.content.startsWith(msgs[0]!.content as string), "system prompt only extended at the end");
  assert.deepEqual(bm.slice(1), msgs.slice(1, 12), "all other messages untouched");
});

test("loop hint after three identical tool calls; edit-miss hint carries the current file", () => {
  const { dir, msgs } = repoSession();
  const glob = msgs.slice(10, 12);
  const looped = { messages: [...msgs.slice(0, 12), ...glob, ...glob], tools: SESSION.tools } as Record<string, unknown>;
  const r = applyLevers(looped, on({ loopHints: true }), ctx());
  assert.ok(r.applied.includes("hint:loop"));
  const lastMsg = (looped.messages as { role: string; content: string }[]).at(-1)!;
  assert.equal(lastMsg.role, "user");
  assert.match(lastMsg.content, /same tool call 3 times/);

  const miss = { messages: msgs.slice(0, 8), tools: SESSION.tools } as Record<string, unknown>;
  const r2 = applyLevers(miss, on({ loopHints: true }), ctx());
  assert.ok(r2.applied.includes("hint:edit-excerpt"), r2.applied.join(","));
  assert.match((miss.messages as { content: string }[]).at(-1)!.content, /export function slugify/);
  // A path outside the working directory is never read.
  const outside = structuredClone(msgs.slice(0, 8));
  (outside[6] as { tool_calls: { function: { arguments: string } }[] }).tool_calls[0]!.function.arguments = JSON.stringify({ filePath: "/etc/hosts", oldString: "x", newString: "y" });
  const r3 = applyLevers({ messages: outside, tools: SESSION.tools }, on({ loopHints: true }), ctx());
  assert.ok(!r3.applied.includes("hint:edit-excerpt"));
  void dir;
});

test("test-driven repair hint after failing test output", () => {
  const b = upTo(10) as Record<string, unknown>;
  const r = applyLevers(b, on({ testRepair: true }), ctx());
  assert.deepEqual(r.applied, ["hint:test-repair"]);
  assert.match((b.messages as { content: string }[]).at(-1)!.content, /do not modify, skip or delete tests/);
});

test("edit excerpt centres on the closest line", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const ex = editExcerpt(text, "  line 50  \nsomething else");
  assert.match(ex, /^38: line 38/);
  assert.match(ex, /50: line 50/);
});
