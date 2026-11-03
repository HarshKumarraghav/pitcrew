import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";

test("DELETE /tasks/completed removes done tasks", async () => {
  const { router, store } = buildApp();
  store.create({ title: "a", status: "done" });
  store.create({ title: "b" });
  const res = await router.handle("DELETE", "/tasks/completed", undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { removed: 1 });
});

test("DELETE /tasks/:id rejects non-numeric ids", async () => {
  const { router } = buildApp();
  const res = await router.handle("DELETE", "/tasks/abc", undefined);
  assert.equal(res.status, 400);
});
