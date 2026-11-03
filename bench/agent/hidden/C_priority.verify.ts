import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";
import { TaskClient } from "../src/api/client.ts";

type T = { priority?: string; title: string };

test("defaults priority to medium", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "a" });
  assert.equal(res.status, 201);
  assert.equal((res.body as T).priority, "medium");
});

test("accepts explicit priority", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "a", priority: "high" });
  assert.equal(res.status, 201);
  assert.equal((res.body as T).priority, "high");
});

test("rejects invalid priority on create", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "a", priority: "urgent" });
  assert.equal(res.status, 400);
});

test("filters by priority, combinable with status", async () => {
  const { router } = buildApp();
  await router.handle("POST", "/tasks", { title: "h1", priority: "high" });
  await router.handle("POST", "/tasks", { title: "h2", priority: "high", status: "done" });
  await router.handle("POST", "/tasks", { title: "l1", priority: "low" });
  const all = await router.handle("GET", "/tasks?priority=high", undefined);
  assert.equal(all.status, 200);
  assert.deepEqual((all.body as { items: T[] }).items.map((t) => t.title).sort(), ["h1", "h2"]);
  const both = await router.handle("GET", "/tasks?priority=high&status=done", undefined);
  assert.deepEqual((both.body as { items: T[] }).items.map((t) => t.title), ["h2"]);
});

test("rejects invalid priority filter", async () => {
  const { router } = buildApp();
  const res = await router.handle("GET", "/tasks?priority=urgent", undefined);
  assert.equal(res.status, 400);
});

test("client.list sends priority query param", async () => {
  let seen = "";
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen = String(url);
    return new Response(JSON.stringify({ items: [], page: 1, pageSize: 20, total: 0 }), { status: 200 });
  }) as typeof fetch;
  try {
    await new TaskClient("http://x").list({ priority: "low" } as never);
  } finally {
    globalThis.fetch = orig;
  }
  assert.match(seen, /[?&]priority=low/);
});
