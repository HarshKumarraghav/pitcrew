import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";

const fixedNow = () => new Date("2026-01-01T00:00:00Z");

test("POST /tasks creates a task", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "Write docs" });
  assert.equal(res.status, 201);
  assert.equal((res.body as { slug: string }).slug, "write-docs");
});

test("POST /tasks rejects missing title", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", {});
  assert.equal(res.status, 400);
});

test("GET /tasks filters by status and paginates", async () => {
  const { router, store } = buildApp();
  for (let i = 0; i < 5; i++) store.create({ title: `t${i}`, status: i % 2 ? "done" : "todo" });
  const res = await router.handle("GET", "/tasks?status=todo&pageSize=2", undefined);
  const body = res.body as { items: unknown[]; total: number };
  assert.equal(res.status, 200);
  assert.equal(body.total, 3);
  assert.equal(body.items.length, 2);
});

test("PATCH /tasks/:id updates status", async () => {
  const { router, store } = buildApp();
  const t = store.create({ title: "x" });
  const res = await router.handle("PATCH", `/tasks/${t.id}`, { status: "done" });
  assert.equal(res.status, 200);
  assert.equal(store.get(t.id)?.status, "done");
});

test("createdAt uses the injected clock", async () => {
  const { router } = buildApp(new (await import("../src/store/taskStore.ts")).TaskStore(fixedNow));
  const res = await router.handle("POST", "/tasks", { title: "clock" });
  assert.equal((res.body as { createdAt: string }).createdAt, "2026-01-01T00:00:00.000Z");
});
