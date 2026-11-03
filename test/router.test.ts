import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, route } from "../src/server/router.ts";
import { DEFAULTS } from "../src/config.ts";

const cfg = (mode: "A" | "B" | "C") => ({ ...DEFAULTS.router, mode });
const title = { messages: [{ role: "user", content: "Generate a title for: fix the login bug" }] };
const agent = { messages: [{ role: "user", content: "fix it" }], tools: [{ type: "function", function: { name: "read" } }] };

test("tool-carrying requests are agent turns; short tool-less ones are helpers", () => {
  assert.equal(classify(agent, 500, DEFAULTS.router), "agent");
  assert.equal(classify(title, 300, DEFAULTS.router), "helper");
  assert.equal(classify(title, 50_000, DEFAULTS.router), "agent", "long tool-less (compaction) stays on the coder");
});

test("mode A sends everything to the coder", () => {
  assert.equal(route(title, 300, cfg("A"), () => true).alias, "coder");
});

test("mode B sends helpers to the light model and caps their output", () => {
  const d = route({ ...title, max_tokens: 4096 }, 300, cfg("B"), () => false);
  assert.equal(d.alias, "small");
  assert.equal(d.patch.max_tokens, 512);
  assert.equal(d.patch.reasoning_effort, "none");
});

test("mode C uses the light model only when it fits without eviction", () => {
  assert.equal(route(title, 300, cfg("C"), () => true).alias, "small");
  const d = route(title, 300, cfg("C"), () => false);
  assert.equal(d.alias, "coder");
  assert.match(d.why, /eviction/);
  assert.equal(route(agent, 300, cfg("C"), () => true).alias, "coder");
});
