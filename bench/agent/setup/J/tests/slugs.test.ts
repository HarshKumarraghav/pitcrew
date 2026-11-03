import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";

type T = { id: number; slug: string; title: string; url: string };

test("duplicate titles get unique slugs", async () => {
  const { router } = buildApp();
  const a = (await router.handle("POST", "/tasks", { title: "Write docs" })).body as T;
  const b = (await router.handle("POST", "/tasks", { title: "Write docs" })).body as T;
  assert.equal(a.slug, "write-docs");
  assert.equal(b.slug, "write-docs-2");
});

test("GET /tasks/by-slug/:slug finds a task", async () => {
  const { router } = buildApp();
  await router.handle("POST", "/tasks", { title: "Ship it" });
  const res = await router.handle("GET", "/tasks/by-slug/ship-it", undefined);
  assert.equal(res.status, 200);
  assert.equal((res.body as T).title, "Ship it");
  assert.equal((res.body as T).url, "/tasks/by-slug/ship-it");
});

test("GET /tasks/by-slug/:slug returns 404 once the task is deleted", async () => {
  const { router } = buildApp();
  const t = (await router.handle("POST", "/tasks", { title: "Old idea" })).body as T;
  assert.equal((await router.handle("DELETE", `/tasks/${t.id}`, undefined)).status, 204);
  const res = await router.handle("GET", "/tasks/by-slug/old-idea", undefined);
  assert.equal(res.status, 404);
});
