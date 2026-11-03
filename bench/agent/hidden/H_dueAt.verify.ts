import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../src/server.ts";
import { TaskStore } from "../src/store/taskStore.ts";
import { TaskClient } from "../src/api/client.ts";

type T = { title: string; dueAt?: unknown; dueDate?: unknown };
const MAR1 = Date.UTC(2026, 2, 1);
const FEB1 = Date.UTC(2026, 1, 1);
const APR1 = Date.UTC(2026, 3, 1);

test("POST /tasks stores dueAt as a number and no dueDate", async () => {
  const { router } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "pay rent", dueAt: MAR1 });
  assert.equal(res.status, 201);
  const body = res.body as T;
  assert.equal(body.dueAt, MAR1);
  assert.equal(typeof body.dueAt, "number");
  assert.equal("dueDate" in body, false);
  const plain = await router.handle("POST", "/tasks", { title: "no due" });
  assert.equal(plain.status, 201);
  assert.equal((plain.body as T).dueAt, undefined);
});

test("POST /tasks rejects non-integer / negative / string dueAt", async () => {
  const { router, store } = buildApp();
  for (const bad of ["2026-03-01T00:00:00.000Z", String(MAR1), -1, 1.5]) {
    const res = await router.handle("POST", "/tasks", { title: "x", dueAt: bad });
    assert.equal(res.status, 400, `dueAt=${JSON.stringify(bad)}`);
    assert.deepEqual(res.body, { error: "invalid dueAt" });
  }
  assert.equal(store.getAllTasks().length, 0);
});

test("GET /tasks?dueBefore takes epoch milliseconds", async () => {
  const { router, store } = buildApp();
  store.create({ title: "early", dueAt: FEB1 } as never);
  store.create({ title: "late", dueAt: APR1 } as never);
  store.create({ title: "edge", dueAt: MAR1 } as never);
  store.create({ title: "none" });
  const res = await router.handle("GET", `/tasks?dueBefore=${MAR1}`, undefined);
  assert.equal(res.status, 200);
  assert.deepEqual((res.body as { items: T[] }).items.map((t) => t.title), ["early"]);
  const all = await router.handle("GET", `/tasks?dueBefore=${APR1 + 1}`, undefined);
  assert.deepEqual((all.body as { items: T[] }).items.map((t) => t.title), ["early", "late", "edge"]);
});

test("GET /tasks?dueBefore rejects non-millisecond values", async () => {
  const { router } = buildApp();
  for (const bad of ["2026-03-01T00:00:00.000Z", "abc", "1.5", "-5"]) {
    const res = await router.handle("GET", `/tasks?dueBefore=${encodeURIComponent(bad)}`, undefined);
    assert.equal(res.status, 400, bad);
    assert.deepEqual(res.body, { error: "invalid dueBefore" });
  }
});

test("GET /tasks/overdue works with dueAt", async () => {
  const { router, store } = buildApp(new TaskStore(() => new Date(MAR1)));
  store.create({ title: "late", dueAt: FEB1 } as never);
  store.create({ title: "done late", dueAt: FEB1, status: "done" } as never);
  store.create({ title: "future", dueAt: APR1 } as never);
  store.create({ title: "none" });
  const res = await router.handle("GET", "/tasks/overdue", undefined);
  assert.equal(res.status, 200);
  assert.deepEqual((res.body as T[]).map((t) => t.title), ["late"]);
});

test("TaskClient sends dueBefore and dueAt as numbers", async () => {
  const seen: { url: string; body?: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), body: init?.body as string | undefined });
    const payload = init?.method === "POST" ? { id: 1, title: "x", dueAt: MAR1 } : { items: [], page: 1, pageSize: 20, total: 0 };
    return new Response(JSON.stringify(payload), { status: init?.method === "POST" ? 201 : 200 });
  }) as typeof fetch;
  try {
    const c = new TaskClient("http://x");
    await c.list({ dueBefore: MAR1 } as never);
    await c.create({ title: "x", dueAt: MAR1 } as never);
  } finally {
    globalThis.fetch = orig;
  }
  assert.match(seen[0]!.url, new RegExp(`[?&]dueBefore=${MAR1}(&|$)`));
  assert.deepEqual(JSON.parse(seen[1]!.body!), { title: "x", dueAt: MAR1 });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test("dueDate no longer appears in src/ or tests/", () => {
  const root = new URL("..", import.meta.url).pathname;
  const hits = ["src", "tests"]
    .flatMap((d) => files(join(root, d)))
    .filter((f) => readFileSync(f, "utf8").includes("dueDate"));
  assert.deepEqual(hits, []);
});
