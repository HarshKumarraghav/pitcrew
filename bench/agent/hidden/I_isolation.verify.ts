import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";
import { TaskStore } from "../src/store/taskStore.ts";

test("pollute module state first (order must not matter)", () => {
  const s = new TaskStore();
  for (let i = 0; i < 5; i++) s.create({ title: "Write docs" });
});

test("ids are per store, even when stores are used interleaved", () => {
  const s1 = new TaskStore();
  const s2 = new TaskStore();
  assert.equal(s1.create({ title: "a" }).id, 1);
  assert.equal(s2.create({ title: "b" }).id, 1);
  assert.equal(s1.create({ title: "c" }).id, 2);
  assert.equal(s2.create({ title: "d" }).id, 2);
});

test("slugs are unique per store, not across stores", () => {
  const s1 = new TaskStore();
  const s2 = new TaskStore();
  assert.equal(s1.create({ title: "Write docs" }).slug, "write-docs");
  assert.equal(s2.create({ title: "Write docs" }).slug, "write-docs");
  assert.equal(s1.create({ title: "Write docs" }).slug, "write-docs-2");
  assert.equal(s2.create({ title: "Write docs" }).slug, "write-docs-2");
  assert.equal(s1.create({ title: "Write docs" }).slug, "write-docs-3");
});

test("deleting in one store frees the slug only in that store", () => {
  const s1 = new TaskStore();
  const s2 = new TaskStore();
  const a = s1.create({ title: "Plan" });
  s2.create({ title: "Plan" });
  assert.equal(s1.remove(a.id), true);
  assert.equal(s1.create({ title: "Plan" }).slug, "plan");
  assert.equal(s2.create({ title: "Plan" }).slug, "plan-2");
});

test("ids are not reused after delete", () => {
  const s = new TaskStore();
  const a = s.create({ title: "a" });
  s.remove(a.id);
  assert.equal(s.create({ title: "b" }).id, 2);
});

test("many fresh apps each start clean", async () => {
  for (let i = 0; i < 20; i++) {
    const { router } = buildApp();
    const res = await router.handle("POST", "/tasks", { title: "Write docs" });
    assert.equal((res.body as { id: number }).id, 1);
    assert.equal((res.body as { slug: string }).slug, "write-docs");
  }
});
