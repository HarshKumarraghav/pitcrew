import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/utils/slugify.ts";
import { buildApp } from "../src/server.ts";
import { TaskStore } from "../src/store/taskStore.ts";
import { TaskClient } from "../src/api/client.ts";

test("punctuation inside words is removed again (pre-regression behaviour)", () => {
  assert.equal(slugify("Don't panic"), "dont-panic");
  assert.equal(slugify("Q&A session"), "qa-session");
  assert.equal(slugify("rock'n'roll"), "rocknroll");
  assert.equal(slugify("snake_case title"), "snakecase-title");
  assert.equal(slugify("C++ tips"), "c-tips");
});

test("accent stripping (added before the regression) still works", () => {
  assert.equal(slugify("Crème brûlée"), "creme-brulee");
  assert.equal(slugify("Über cool"), "uber-cool");
  assert.equal(slugify("Don’t café"), "dont-cafe");
});

test("original slug rules still hold", () => {
  assert.equal(slugify("Write Docs"), "write-docs");
  assert.equal(slugify("Ship it!"), "ship-it");
  assert.equal(slugify("Fix   the  Bug"), "fix-the-bug");
  assert.equal(slugify("  -- Hello World --  "), "hello-world");
  assert.equal(slugify("a - b"), "a-b");
});

test("later commits were not reverted", async () => {
  const s = new TaskStore();
  s.create({ title: "a" });
  s.create({ title: "b", status: "done" });
  assert.equal((s as TaskStore & { count(st?: string): number }).count("done"), 1);
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "  padded  " });
  assert.equal((res.body as { title: string }).title, "padded");
  let seen = "";
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen = String(url);
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  try {
    await new TaskClient("http://x").get("a/b" as never);
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(seen, "http://x/tasks/a%2Fb");
});
