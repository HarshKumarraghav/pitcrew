import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";

test("priority defaults to medium and can be filtered", async () => {
  const { router } = buildApp();
  const a = await router.handle("POST", "/tasks", { title: "a" });
  assert.equal((a.body as { priority: string }).priority, "medium");
  await router.handle("POST", "/tasks", { title: "b", priority: "high" });
  const res = await router.handle("GET", "/tasks?priority=high", undefined);
  assert.equal((res.body as { total: number }).total, 1);
});

test("invalid priority is rejected", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "a", priority: "urgent" });
  assert.equal(res.status, 400);
});
