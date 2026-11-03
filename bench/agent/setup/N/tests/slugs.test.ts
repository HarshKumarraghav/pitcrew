import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";
import { TaskStore } from "../src/store/taskStore.ts";

test("duplicate titles get numbered slugs", () => {
  const s = new TaskStore();
  assert.deepEqual(["A", "A", "A"].map((t) => s.create({ title: t }).slug), ["a", "a-2", "a-3"]);
});

test("a freed slug is reused by the next duplicate", () => {
  const s = new TaskStore();
  s.create({ title: "A" });
  const b = s.create({ title: "A" });
  s.create({ title: "A" });
  s.remove(b.id);
  assert.equal(s.create({ title: "A" }).slug, "a-2");
  assert.equal(s.create({ title: "A" }).slug, "a-4");
});

test("findBySlug", () => {
  const s = new TaskStore();
  const a = s.create({ title: "Write docs" });
  assert.equal(s.findBySlug("write-docs")?.id, a.id);
  s.remove(a.id);
  assert.equal(s.findBySlug("write-docs"), undefined);
});

test("POST /tasks/import creates all tasks", async () => {
  const { router, store } = buildApp();
  const res = await router.handle("POST", "/tasks/import", [{ title: "a" }, { title: "b", status: "done" }]);
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { imported: 2 });
  assert.equal(store.getAllTasks("done").length, 1);
});

test("POST /tasks/import is all-or-nothing", async () => {
  const { router, store } = buildApp();
  const res = await router.handle("POST", "/tasks/import", [{ title: "a" }, { title: "" }]);
  assert.equal(res.status, 400);
  assert.equal(store.getAllTasks().length, 0);
});
