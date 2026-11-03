import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";
import { TaskStore } from "../src/store/taskStore.ts";

test("listTasks exists and getAllTasks is gone", () => {
  const s = new TaskStore() as unknown as Record<string, unknown>;
  assert.equal(typeof s.listTasks, "function");
  assert.equal(s.getAllTasks, undefined);
});

test("countByStatus counts every status", () => {
  const s = new TaskStore();
  s.create({ title: "a" });
  s.create({ title: "b", status: "done" });
  s.create({ title: "c", status: "done" });
  assert.deepEqual(s.countByStatus(), { todo: 1, doing: 0, done: 2 });
});

test("GET /tasks/stats returns counts (not shadowed by /tasks/:id)", async () => {
  const { router, store } = buildApp();
  store.create({ title: "a", status: "doing" });
  const res = await router.handle("GET", "/tasks/stats", undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { todo: 0, doing: 1, done: 0 });
});

test("GET /tasks/:id still works", async () => {
  const { router, store } = buildApp();
  const t = store.create({ title: "a" });
  const res = await router.handle("GET", `/tasks/${t.id}`, undefined);
  assert.equal(res.status, 200);
});
