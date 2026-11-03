import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../src/store/taskStore.ts";

test("count() counts all tasks or one status", () => {
  const s = new TaskStore();
  s.create({ title: "a" });
  s.create({ title: "b", status: "done" });
  assert.equal(s.count(), 2);
  assert.equal(s.count("done"), 1);
});
