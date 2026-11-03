import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";

type T = { id: number; title: string; slug: string; status: string };

test("POST rejects unknown body fields", async () => {
  const { router, store } = buildApp();
  const res = await router.handle("POST", "/tasks", { title: "a", priority: "high" });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: "unknown field: priority" });
  assert.equal(store.getAllTasks().length, 0);
});

test("POST title length limits apply after trimming, and the trimmed title is stored", async () => {
  const { router } = buildApp();
  const long = await router.handle("POST", "/tasks", { title: "x".repeat(121) });
  assert.equal(long.status, 400);
  assert.deepEqual(long.body, { error: "title too long" });
  const padded = await router.handle("POST", "/tasks", { title: `   ${"y".repeat(120)}   ` });
  assert.equal(padded.status, 201);
  assert.equal((padded.body as T).title, "y".repeat(120));
  const trimmed = await router.handle("POST", "/tasks", { title: "  Write docs \n" });
  assert.equal((trimmed.body as T).title, "Write docs");
  for (const title of ["", "   ", "\n\t", 42, null]) {
    const r = await router.handle("POST", "/tasks", { title });
    assert.equal(r.status, 400, JSON.stringify(title));
    assert.deepEqual(r.body, { error: "title is required" }, JSON.stringify(title));
  }
});

test("POST still validates status", async () => {
  const { router } = buildApp();
  const r = await router.handle("POST", "/tasks", { title: "a", status: "blocked" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: "invalid status" });
});

test("ids that are not positive integers are 400 on GET, PATCH and DELETE", async () => {
  const { router, store } = buildApp();
  store.create({ title: "a" });
  for (const id of ["abc", "0", "-1", "1.5", "1abc"]) {
    for (const [method, body] of [["GET", undefined], ["PATCH", { status: "done" }], ["DELETE", undefined]] as const) {
      const r = await router.handle(method, `/tasks/${id}`, body);
      assert.equal(r.status, 400, `${method} ${id}`);
      assert.deepEqual(r.body, { error: "invalid id" }, `${method} ${id}`);
    }
  }
  assert.equal(store.getAllTasks().length, 1);
  assert.equal(store.get(1)?.status, "todo");
});

test("unknown numeric ids are still 404", async () => {
  const { router } = buildApp();
  assert.equal((await router.handle("GET", "/tasks/7", undefined)).status, 404);
  assert.equal((await router.handle("PATCH", "/tasks/7", { status: "done" })).status, 404);
  assert.equal((await router.handle("DELETE", "/tasks/7", undefined)).status, 404);
});

test("PATCH rejects fields that are not Task fields", async () => {
  const { router, store } = buildApp();
  const t = store.create({ title: "a" });
  const r = await router.handle("PATCH", `/tasks/${t.id}`, { status: "done", assignee: "bob" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: "unknown field: assignee" });
  assert.equal(store.get(t.id)?.status, "todo");
});

test("PATCH accepts a full task object and only changes status", async () => {
  const { router, store } = buildApp();
  const t = store.create({ title: "a" });
  const r = await router.handle("PATCH", `/tasks/${t.id}`, { ...t, title: "renamed?", status: "doing" });
  assert.equal(r.status, 200);
  assert.equal(store.get(t.id)?.status, "doing");
  assert.equal(store.get(t.id)?.title, "a");
});

test("PATCH requires a JSON object body", async () => {
  const { router, store } = buildApp();
  const t = store.create({ title: "a" });
  for (const body of [null, "done", ["done"], 5]) {
    const r = await router.handle("PATCH", `/tasks/${t.id}`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const bad = await router.handle("PATCH", `/tasks/${t.id}`, { status: "blocked" });
  assert.deepEqual(bad.body, { error: "invalid status" });
});
