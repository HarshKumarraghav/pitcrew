import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/utils/paginate.ts";
import { buildApp } from "../src/server.ts";

test("paginate returns the requested page", () => {
  const p = paginate([1, 2, 3, 4], 2, 2);
  assert.deepEqual(p.items, [3, 4]);
  assert.equal(p.totalPages, 2);
});

test("paginate clamps page and pageSize", () => {
  const p = paginate([1, 2, 3], 0, 1000);
  assert.equal(p.page, 1);
  assert.equal(p.pageSize, 100);
});

test("GET /tasks reports the next page", async () => {
  const { router, store } = buildApp();
  for (let i = 0; i < 5; i++) store.create({ title: `t${i}` });
  const res = await router.handle("GET", "/tasks?pageSize=2", undefined);
  assert.equal((res.body as { nextPage: number | null }).nextPage, 2);
});
