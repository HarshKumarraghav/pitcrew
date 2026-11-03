import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";

type T = { id: number; slug: string };

test("duplicate titles get numbered slugs", async () => {
  const { router } = buildApp();
  const a = (await router.handle("POST", "/tasks", { title: "Write docs" })).body as T;
  const b = (await router.handle("POST", "/tasks", { title: "Write docs" })).body as T;
  assert.equal(a.slug, "write-docs");
  assert.equal(b.slug, "write-docs-2");
});

test("a deleted task gives its slug back", async () => {
  const { router } = buildApp();
  const a = (await router.handle("POST", "/tasks", { title: "Plan sprint" })).body as T;
  await router.handle("DELETE", `/tasks/${a.id}`, undefined);
  const b = (await router.handle("POST", "/tasks", { title: "Plan sprint" })).body as T;
  assert.equal(b.slug, "plan-sprint");
});

test("ids are sequential", async () => {
  const { store } = buildApp();
  const a = store.create({ title: "one" });
  const b = store.create({ title: "two" });
  assert.equal(b.id, a.id + 1);
});

test("a fresh app starts from a clean slate", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "Write docs" });
  assert.equal(res.status, 201);
  assert.equal((res.body as T).id, 1);
  assert.equal((res.body as T).slug, "write-docs");
});
