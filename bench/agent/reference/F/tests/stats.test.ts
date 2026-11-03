import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";

test("GET /tasks/stats counts tasks per status", async () => {
  const { router, store } = buildApp();
  store.create({ title: "a" });
  store.create({ title: "b", status: "done" });
  const res = await router.handle("GET", "/tasks/stats", undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { todo: 1, doing: 0, done: 1 });
});
