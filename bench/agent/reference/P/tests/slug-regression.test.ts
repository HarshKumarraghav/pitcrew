import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/utils/slugify.ts";

test("punctuation inside words is dropped, not turned into a hyphen", () => {
  assert.equal(slugify("Don't panic"), "dont-panic");
  assert.equal(slugify("Q&A session"), "qa-session");
});
