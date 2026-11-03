import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";
import { TaskStore } from "../src/store/taskStore.ts";
import { TaskClient } from "../src/api/client.ts";

type S = TaskStore & { removeByStatus(s: string): number };

test("removeByStatus removes only matching tasks and returns the count", () => {
  const s = new TaskStore() as S;
  s.create({ title: "a", status: "done" });
  s.create({ title: "b" });
  s.create({ title: "c", status: "done" });
  assert.equal(s.removeByStatus("done"), 2);
  assert.deepEqual(s.getAllTasks().map((t) => t.title), ["b"]);
  assert.equal(s.removeByStatus("done"), 0);
});

test("DELETE /tasks/completed is not shadowed by /tasks/:id", async () => {
  const { router, store } = buildApp();
  store.create({ title: "a", status: "done" });
  store.create({ title: "b", status: "doing" });
  store.create({ title: "c", status: "done" });
  const res = await router.handle("DELETE", "/tasks/completed", undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { removed: 2 });
  assert.deepEqual(store.getAllTasks().map((t) => t.title), ["b"]);
  const again = await router.handle("DELETE", "/tasks/completed", undefined);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { removed: 0 });
});

test("DELETE /tasks/:id still works for numeric ids", async () => {
  const { router, store } = buildApp();
  const t = store.create({ title: "a" });
  assert.equal((await router.handle("DELETE", `/tasks/${t.id}`, undefined)).status, 204);
  assert.equal((await router.handle("DELETE", `/tasks/${t.id}`, undefined)).status, 404);
  assert.equal((await router.handle("DELETE", "/tasks/999", undefined)).status, 404);
});

test("DELETE /tasks/:id rejects ids that are not positive integers", async () => {
  const { router, store } = buildApp();
  store.create({ title: "a" });
  for (const bad of ["abc", "1.5", "0", "-1", "completedd"]) {
    const res = await router.handle("DELETE", `/tasks/${bad}`, undefined);
    assert.equal(res.status, 400, bad);
    assert.deepEqual(res.body, { error: "invalid id" }, bad);
  }
  assert.equal(store.getAllTasks().length, 1);
});

test("TaskClient.clearCompleted sends DELETE /tasks/completed and resolves to the count", async () => {
  let seen = "";
  let method = "";
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen = String(url);
    method = String(init?.method);
    return new Response(JSON.stringify({ removed: 3 }), { status: 200 });
  }) as typeof fetch;
  try {
    const n = await (new TaskClient("http://x/") as TaskClient & { clearCompleted(): Promise<number> }).clearCompleted();
    assert.equal(n, 3);
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(method, "DELETE");
  assert.equal(seen, "http://x/tasks/completed");
});
