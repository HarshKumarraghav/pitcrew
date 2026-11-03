import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";
import { TaskStore } from "../src/store/taskStore.ts";

type S = TaskStore & { hasSlug(s: string): boolean; findBySlug(s: string): { id: number } | undefined };
type T = { id: number; slug: string; title: string };

test("by-slug returns 404 after delete", async () => {
  const { router } = buildApp();
  const t = (await router.handle("POST", "/tasks", { title: "Old idea" })).body as T;
  await router.handle("DELETE", `/tasks/${t.id}`, undefined);
  const res = await router.handle("GET", "/tasks/by-slug/old-idea", undefined);
  assert.equal(res.status, 404);
});

test("the store forgets the slug of a deleted task", () => {
  const s = new TaskStore() as S;
  const t = s.create({ title: "Old idea" });
  assert.equal(s.hasSlug("old-idea"), true);
  s.remove(t.id);
  assert.equal(s.hasSlug("old-idea"), false);
  assert.equal(s.findBySlug("old-idea"), undefined);
});

test("a deleted task's slug can be reused by a new task", async () => {
  const { router } = buildApp();
  const a = (await router.handle("POST", "/tasks", { title: "Write docs" })).body as T;
  await router.handle("DELETE", `/tasks/${a.id}`, undefined);
  const b = (await router.handle("POST", "/tasks", { title: "Write docs" })).body as T;
  assert.equal(b.slug, "write-docs");
  const res = await router.handle("GET", "/tasks/by-slug/write-docs", undefined);
  assert.equal(res.status, 200);
  assert.equal((res.body as T).id, b.id);
});

test("deleting one duplicate leaves the other reachable and unique", async () => {
  const { router } = buildApp();
  const a = (await router.handle("POST", "/tasks", { title: "Plan" })).body as T;
  const b = (await router.handle("POST", "/tasks", { title: "Plan" })).body as T;
  assert.equal(b.slug, "plan-2");
  await router.handle("DELETE", `/tasks/${a.id}`, undefined);
  assert.equal((await router.handle("GET", "/tasks/by-slug/plan-2", undefined)).status, 200);
  const c = (await router.handle("POST", "/tasks", { title: "Plan" })).body as T;
  assert.equal(c.slug, "plan");
  const d = (await router.handle("POST", "/tasks", { title: "Plan" })).body as T;
  assert.equal(d.slug, "plan-3");
});

test("deleting an unknown id is still a 404", async () => {
  const { router } = buildApp();
  assert.equal((await router.handle("DELETE", "/tasks/42", undefined)).status, 404);
});
