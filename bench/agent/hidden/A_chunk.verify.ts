import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk } from "../src/utils/chunk.ts";

test("splits evenly", () => assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]));
test("last group shorter", () => assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]));
test("empty input", () => assert.deepEqual(chunk([], 3), []));
test("size larger than input", () => assert.deepEqual(chunk(["a"], 5), [["a"]]));
test("does not mutate input", () => {
  const a = [1, 2, 3];
  chunk(a, 2);
  assert.deepEqual(a, [1, 2, 3]);
});
test("rejects zero", () => assert.throws(() => chunk([1], 0), RangeError));
test("rejects negative", () => assert.throws(() => chunk([1], -1), RangeError));
test("rejects non-integer", () => assert.throws(() => chunk([1], 1.5), RangeError));
