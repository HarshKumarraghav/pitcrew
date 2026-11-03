import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as client from "../src/api/client.ts";
import * as errors from "../src/api/errors.ts";
import * as query from "../src/api/query.ts";
import * as index from "../src/api/index.ts";

const src = (p: string) => readFileSync(new URL(`../src/api/${p}`, import.meta.url), "utf8");

test("old import path still exports the same public API", () => {
  assert.equal(typeof client.TaskClient, "function");
  assert.equal(typeof client.ApiError, "function");
  assert.equal(typeof client.buildQuery, "function");
  assert.equal(client.DEFAULT_TIMEOUT_MS, 10_000);
});

test("ApiError and buildQuery live in their new modules and are not duplicated", () => {
  assert.equal(errors.ApiError, client.ApiError);
  assert.equal(query.buildQuery, client.buildQuery);
  assert.match(src("errors.ts"), /class ApiError\b/);
  assert.match(src("query.ts"), /function buildQuery\b|const buildQuery\b/);
  assert.doesNotMatch(src("client.ts"), /class ApiError\b/);
  assert.doesNotMatch(src("client.ts"), /function buildQuery\b|const buildQuery\s*=/);
});

test("index re-exports the public API (same identities)", () => {
  assert.equal(index.TaskClient, client.TaskClient);
  assert.equal(index.ApiError, client.ApiError);
  assert.equal(index.buildQuery, client.buildQuery);
  assert.equal(index.DEFAULT_TIMEOUT_MS, 10_000);
});

test("ApiError behaviour is unchanged", () => {
  const e = new errors.ApiError("GET", "/tasks/1", 404, "not found");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof client.ApiError);
  assert.equal(e.name, "ApiError");
  assert.equal(e.message, "GET /tasks/1 failed: 404 not found");
  assert.equal(e.isNotFound, true);
  assert.equal(new errors.ApiError("POST", "/tasks", 400).message, "POST /tasks failed: 400");
});

test("buildQuery behaviour is unchanged", () => {
  assert.equal(query.buildQuery({ status: "done", page: undefined, pageSize: 5 }), "?status=done&pageSize=5");
  assert.equal(query.buildQuery({ a: "", b: 0 }), "?b=0");
  assert.equal(query.buildQuery({}), "");
});

test("client still throws ApiError, find() still maps 404, headers still sent", async () => {
  const orig = globalThis.fetch;
  const seen: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    if (String(url).endsWith("/tasks/9")) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    if (String(url).endsWith("/tasks/8")) return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    return new Response(JSON.stringify({ items: [], page: 1, pageSize: 20, total: 0 }), { status: 200 });
  }) as typeof fetch;
  try {
    const c = new index.TaskClient("http://api/", { headers: { authorization: "Bearer t" } });
    await assert.rejects(c.get(9), (e: unknown) => e instanceof errors.ApiError && e.status === 404 && e.code === "not found");
    assert.equal(await c.find(9), undefined);
    await assert.rejects(c.find(8), (e: unknown) => e instanceof client.ApiError && e.status === 500);
    await c.list({ status: "todo", page: 3 });
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(seen.at(-1)!.url, "http://api/tasks?status=todo&page=3");
  assert.equal(seen.at(-1)!.headers.authorization, "Bearer t");
});
