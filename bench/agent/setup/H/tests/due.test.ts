import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";
import { TaskStore } from "../src/store/taskStore.ts";

const clock = () => new Date("2026-03-01T00:00:00Z");

test("POST /tasks stores a due date", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "pay rent", dueDate: "2026-03-05T00:00:00.000Z" });
  assert.equal(res.status, 201);
  assert.equal((res.body as { dueDate: string }).dueDate, "2026-03-05T00:00:00.000Z");
});

test("POST /tasks rejects an invalid due date", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "x", dueDate: "next tuesday" });
  assert.equal(res.status, 400);
});

test("GET /tasks?dueBefore filters by due date", async () => {
  const { router, store } = buildApp();
  store.create({ title: "early", dueDate: "2026-02-01T00:00:00.000Z" });
  store.create({ title: "late", dueDate: "2026-04-01T00:00:00.000Z" });
  store.create({ title: "none" });
  const res = await router.handle("GET", "/tasks?dueBefore=2026-03-01T00:00:00.000Z", undefined);
  assert.deepEqual((res.body as { items: { title: string }[] }).items.map((t) => t.title), ["early"]);
});

test("GET /tasks/overdue lists unfinished tasks past their due date", async () => {
  const { router, store } = buildApp(new TaskStore(clock));
  store.create({ title: "late", dueDate: "2026-02-01T00:00:00.000Z" });
  store.create({ title: "done late", dueDate: "2026-02-01T00:00:00.000Z", status: "done" });
  store.create({ title: "future", dueDate: "2026-05-01T00:00:00.000Z" });
  const res = await router.handle("GET", "/tasks/overdue", undefined);
  assert.deepEqual((res.body as { title: string }[]).map((t) => t.title), ["late"]);
});
