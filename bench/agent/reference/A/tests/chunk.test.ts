import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk } from "../src/utils/chunk.ts";

test("chunk splits into groups", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("chunk rejects a non-positive size", () => {
  assert.throws(() => chunk([1], 0), RangeError);
});
