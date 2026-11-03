import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";
import { TaskStore } from "../src/store/taskStore.ts";

const clock = () => new Date("2026-03-01T00:00:00Z");

test("POST /tasks stores dueAt", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "pay rent", dueAt: Date.UTC(2026, 2, 5) });
  assert.equal(res.status, 201);
  assert.equal((res.body as { dueAt: number }).dueAt, Date.UTC(2026, 2, 5));
});

test("POST /tasks rejects an invalid dueAt", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "x", dueAt: "next tuesday" });
  assert.equal(res.status, 400);
});

test("GET /tasks?dueBefore filters by due time (epoch ms)", async () => {
  const { router, store } = buildApp();
  store.create({ title: "early", dueAt: Date.UTC(2026, 1, 1) });
  store.create({ title: "late", dueAt: Date.UTC(2026, 3, 1) });
  store.create({ title: "none" });
  const res = await router.handle("GET", `/tasks?dueBefore=${Date.UTC(2026, 2, 1)}`, undefined);
  assert.deepEqual((res.body as { items: { title: string }[] }).items.map((t) => t.title), ["early"]);
});

test("GET /tasks/overdue lists unfinished tasks past their due date", async () => {
  const { router, store } = buildApp(new TaskStore(clock));
  store.create({ title: "late", dueAt: Date.UTC(2026, 1, 1) });
  store.create({ title: "done late", dueAt: Date.UTC(2026, 1, 1), status: "done" });
  store.create({ title: "future", dueAt: Date.UTC(2026, 4, 1) });
  const res = await router.handle("GET", "/tasks/overdue", undefined);
  assert.deepEqual((res.body as { title: string }[]).map((t) => t.title), ["late"]);
});
