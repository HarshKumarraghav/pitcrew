import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";

// API contract tests: other teams rely on these behaviours.

test("PATCH accepts a task object read back from GET", async () => {
  const { router, store } = buildApp();
  const t = store.create({ title: "round trip" });
  const got = (await router.handle("GET", `/tasks/${t.id}`, undefined)).body as Record<string, unknown>;
  const res = await router.handle("PATCH", `/tasks/${t.id}`, { ...got, status: "done" });
  assert.equal(res.status, 200);
  assert.equal(store.get(t.id)?.status, "done");
});

test("titles with surrounding whitespace are accepted", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "  Ship it!  " });
  assert.equal(res.status, 201);
  assert.equal((res.body as { slug: string }).slug, "ship-it");
});

test("a 120-character title is accepted", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "x".repeat(120) });
  assert.equal(res.status, 201);
});

test("POST accepts an explicit status", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "in flight", status: "doing" });
  assert.equal(res.status, 201);
  assert.equal((res.body as { status: string }).status, "doing");
});

test("unknown ids are 404", async () => {
  const { router } = buildApp();
  assert.equal((await router.handle("GET", "/tasks/999", undefined)).status, 404);
  assert.equal((await router.handle("PATCH", "/tasks/999", { status: "done" })).status, 404);
  assert.equal((await router.handle("DELETE", "/tasks/999", undefined)).status, 404);
});
