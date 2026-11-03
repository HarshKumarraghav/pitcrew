import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/server.ts";

test("loadConfig defaults and validation", () => {
  assert.deepEqual(loadConfig({}), { defaultPageSize: 20, maxPageSize: 100 });
  assert.throws(() => loadConfig({ TASKBOARD_MAX_PAGE_SIZE: "0" }), /TASKBOARD_MAX_PAGE_SIZE/);
});

test("GET /tasks clamps to the configured max", async () => {
  const { router, store } = buildApp(undefined, { defaultPageSize: 1, maxPageSize: 2 });
  for (let i = 0; i < 3; i++) store.create({ title: `t${i}` });
  const res = await router.handle("GET", "/tasks?pageSize=10", undefined);
  assert.equal((res.body as { items: unknown[] }).items.length, 2);
});
