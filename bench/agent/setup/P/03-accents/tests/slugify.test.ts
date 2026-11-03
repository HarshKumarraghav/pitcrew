import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/utils/slugify.ts";

test("lowercases and hyphenates", () => {
  assert.equal(slugify("Write Docs"), "write-docs");
});

test("strips punctuation", () => {
  assert.equal(slugify("Ship it!"), "ship-it");
});

test("collapses repeated whitespace into a single hyphen", () => {
  assert.equal(slugify("Fix   the  Bug"), "fix-the-bug");
});

test("does not leave leading or trailing hyphens", () => {
  assert.equal(slugify("  -- Hello World --  "), "hello-world");
});

test("strips accents", () => {
  assert.equal(slugify("Crème brûlée"), "creme-brulee");
});
