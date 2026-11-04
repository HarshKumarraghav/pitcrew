import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, type RouterConfig } from "../src/config.ts";
import { applyLevers, classifyStep, editExcerpt, failingTests, type LeverContext } from "../src/server/levers.ts";

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

// ─────────────── Phase 1: failing-test quotes and stuck signals ───────────────

const TEST_OUT = SESSION.messages[9]!.content as string;

test("failing tests are read from node:test, pytest, Jest and Vitest output", () => {
  const t = failingTests(TEST_OUT);
  assert.deepEqual(t[0], { name: "collapses repeated whitespace into a single hyphen", where: "tests/slugify.test.ts:13", detail: "expected 'fix-the-bug', actual 'fix---the--bug'" });
  assert.ok(t.length >= 2);
  const nested = "not ok 1 - suite\n  ---\n  failureType: 'subtestsFailed'\n  ...\n    not ok 1 - inner\n      ---\n      error: |-\n        boom happened\n      ...";
  assert.deepEqual(failingTests(nested), [{ name: "inner", where: undefined, detail: "boom happened" }]);
  assert.deepEqual(failingTests("FAILED tests/test_calc.py::test_add - assert 3 == 4\nFAILED tests/test_calc.py::test_sub"), [
    { name: "test_add", where: "tests/test_calc.py", detail: "assert 3 == 4" },
    { name: "test_sub", where: "tests/test_calc.py", detail: undefined },
  ]);
  const jest = "  ● math › adds\n\n    expect(received).toBe(expected)\n\n    Expected: 4\n    Received: 3\n";
  assert.deepEqual(failingTests(jest), [{ name: "math › adds", detail: "Expected: 4, Received: 3" }]);
  const vitest = " FAIL  tests/a.test.ts > math > adds\nAssertionError: expected 3 to be 4\n";
  assert.deepEqual(failingTests(vitest), [{ name: "math > adds", where: "tests/a.test.ts", detail: "AssertionError: expected 3 to be 4" }]);
  assert.deepEqual(failingTests("# pass 13\n# fail 0"), []);
});

test("test-repair hint quotes the failing tests and their assertions", () => {
  const b = upTo(10) as Record<string, unknown>;
  applyLevers(b, on({ testRepair: true }), ctx());
  const hint = (b.messages as { content: string }[]).at(-1)!.content;
  assert.match(hint, /- collapses repeated whitespace into a single hyphen \(tests\/slugify\.test\.ts:13\): expected 'fix-the-bug', actual 'fix---the--bug'/);
  assert.match(hint, /do not modify, skip or delete tests/);
});

type M = Record<string, unknown>;
let nextId = 0;
const call = (name: string, args: Record<string, unknown>, result: string): M[] => {
  const id = `call_t${nextId++}`;
  return [
    { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: id, content: result },
  ];
};
const convo = (...turns: M[][]) => ({ messages: [SESSION.messages[0], SESSION.messages[1], ...turns.flat()], tools: SESSION.tools }) as Record<string, unknown>;
const npmTest = (out = TEST_OUT) => call("bash", { command: "npm test", description: "Run tests" }, out);
const edit = (oldString: string, newString: string, ok = true) => call("edit", { filePath: "/r/src/a.ts", oldString, newString }, ok ? "Edit applied successfully." : "Could not find oldString in the file.");

test("stuck: the same test failing in 3 runs in a row", () => {
  assert.equal(classifyStep(convo(npmTest(), edit("a", "b"), npmTest())).stuck, undefined, "2 runs is not stuck");
  const three = convo(npmTest(), edit("a", "b"), npmTest(), edit("c", "d"), npmTest());
  const st = classifyStep(three);
  assert.deepEqual(st.stuck, { kind: "same-failing-test", count: 3, detail: "collapses repeated whitespace into a single hyphen" });
  // A passing run in between resets the streak; a later non-test step does not re-fire it.
  assert.equal(classifyStep(convo(npmTest(), npmTest("# pass 5\n# fail 0"), npmTest(), npmTest())).stuck, undefined);
  assert.equal(classifyStep(convo(npmTest(), npmTest(), npmTest(), call("read", { filePath: "/r/a" }, "<content>"))).stuck, undefined);
  // The hint is off by default and on with stuckHints; thinking is never cut while stuck.
  const r0 = applyLevers(three, on(), ctx());
  assert.ok(!r0.applied.some((a) => a.startsWith("hint:stuck")));
  const b = convo(npmTest(), edit("a", "b"), npmTest(), edit("c", "d"), npmTest());
  const r = applyLevers(b, on({ stuckHints: true }), ctx());
  assert.ok(r.applied.includes("hint:stuck-same-failing-test"), r.applied.join(","));
  assert.match((b.messages as { content: string }[]).at(-1)!.content, /"collapses repeated whitespace into a single hyphen" has failed 3 test runs in a row/);
});

test("stuck: edits that change nothing (failed, repeated, or undone)", () => {
  assert.equal(classifyStep(convo(edit("a", "b"), edit("b", "a"), edit("a", "b"))).stuck, undefined, "first edit made progress; 2 useless");
  const st = classifyStep(convo(edit("a", "b"), edit("b", "a"), edit("a", "b"), edit("x", "y", false)));
  assert.deepEqual(st.stuck, { kind: "no-diff-progress", count: 3 });
  assert.equal(classifyStep(convo(edit("a", "b"), edit("c", "d"), edit("e", "f"))).stuck, undefined, "distinct successful edits are progress");
  const b = convo(edit("a", "b"), edit("b", "a"), edit("a", "b"), edit("x", "y", false));
  assert.ok(applyLevers(b, on({ stuckHints: true }), ctx()).applied.includes("hint:stuck-no-diff-progress"));
});

test("stuck: three failed tool calls in a row", () => {
  const miss = (f: string) => call("read", { filePath: f }, `File not found: ${f}`);
  assert.equal(classifyStep(convo(miss("/a"), miss("/b"))).stuck, undefined);
  const st = classifyStep(convo(miss("/a"), miss("/b"), call("glob", { pattern: "x" }, "Error: bad pattern")));
  assert.deepEqual(st.stuck, { kind: "tool-error-streak", count: 3, detail: "read, glob" });
  assert.equal(classifyStep(convo(miss("/a"), miss("/b"), call("read", { filePath: "/c" }, "<content>"))).stuck, undefined);
});
