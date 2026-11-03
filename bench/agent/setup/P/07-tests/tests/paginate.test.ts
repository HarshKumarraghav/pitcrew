import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/utils/paginate.ts";

test("paginate clamps pageSize to 100", () => {
  assert.equal(paginate([1, 2, 3], 1, 1000).pageSize, 100);
});

test("paginate clamps page to 1", () => {
  assert.deepEqual(paginate([1, 2, 3], 0, 2).items, [1, 2]);
});
