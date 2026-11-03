import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, TaskClient, buildQuery } from "../src/api/client.ts";

function mockFetch(status: number, body: unknown, seen: string[] = []) {
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  return seen;
}

const realFetch = globalThis.fetch;

test("buildQuery skips undefined values", () => {
  assert.equal(buildQuery({ status: "done", page: undefined, pageSize: 5 }), "?status=done&pageSize=5");
  assert.equal(buildQuery({}), "");
});

test("list sends query parameters", async () => {
  const seen = mockFetch(200, { items: [], page: 2, pageSize: 5, total: 0 });
  try {
    await new TaskClient("http://api/").list({ page: 2, pageSize: 5 });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, ["http://api/tasks?page=2&pageSize=5"]);
});

test("errors are ApiErrors carrying the status", async () => {
  mockFetch(404, { error: "not found" });
  try {
    await assert.rejects(new TaskClient("http://api").get(9), (e: unknown) => e instanceof ApiError && e.status === 404);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("find resolves to undefined on 404", async () => {
  mockFetch(404, { error: "not found" });
  try {
    assert.equal(await new TaskClient("http://api").find(9), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
