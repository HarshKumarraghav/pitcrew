import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";

test("POST rejects unknown fields and long titles, trims titles", async () => {
  const { router } = buildApp();
  assert.deepEqual((await router.handle("POST", "/tasks", { title: "a", foo: 1 })).body, { error: "unknown field: foo" });
  assert.deepEqual((await router.handle("POST", "/tasks", { title: "x".repeat(121) })).body, { error: "title too long" });
  assert.equal(((await router.handle("POST", "/tasks", { title: "  a  " })).body as { title: string }).title, "a");
});

test("non-numeric ids are rejected", async () => {
  const { router } = buildApp();
  assert.equal((await router.handle("GET", "/tasks/abc", undefined)).status, 400);
  assert.equal((await router.handle("DELETE", "/tasks/0", undefined)).status, 400);
});
