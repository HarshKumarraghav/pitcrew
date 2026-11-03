import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { buildApp } from "../src/server.ts";
import { TaskStore } from "../src/store/taskStore.ts";

type S = TaskStore & { findBySlug(s: string): { id: number } | undefined };

test("slug numbering and reuse are unchanged", () => {
  const s = new TaskStore();
  assert.deepEqual(["A", "A", "A", "B", "A"].map((t) => s.create({ title: t }).slug), ["a", "a-2", "a-3", "b", "a-4"]);
  s.remove(1);
  s.remove(3);
  assert.equal(s.create({ title: "A" }).slug, "a");
  assert.equal(s.create({ title: "A" }).slug, "a-3");
  assert.equal(s.create({ title: "A" }).slug, "a-5");
  assert.deepEqual(s.getAllTasks().map((t) => t.id), [2, 4, 5, 6, 7, 8]);
});

test("a task whose title looks like a numbered slug does not confuse numbering", () => {
  const s = new TaskStore();
  assert.equal(s.create({ title: "A 2" }).slug, "a-2");
  assert.equal(s.create({ title: "A" }).slug, "a");
  assert.equal(s.create({ title: "A" }).slug, "a-3");
});

test("findBySlug follows creates and removes", () => {
  const s = new TaskStore() as S;
  const a = s.create({ title: "Write docs" });
  const b = s.create({ title: "Write docs" });
  assert.equal(s.findBySlug("write-docs-2")?.id, b.id);
  s.remove(a.id);
  assert.equal(s.findBySlug("write-docs"), undefined);
  const c = s.create({ title: "Write docs" });
  assert.equal(s.findBySlug("write-docs")?.id, c.id);
});

test("import is still all-or-nothing", async () => {
  const { router, store } = buildApp();
  const res = await router.handle("POST", "/tasks/import", [{ title: "a" }, { title: "b", status: "nope" }]);
  assert.equal(res.status, 400);
  assert.equal(store.getAllTasks().length, 0);
});

test("importing 20,000 tasks is fast", () => {
  const server = new URL("../src/server.ts", import.meta.url).href;
  const code = `
    const { buildApp } = await import(${JSON.stringify(server)});
    const { router, store } = buildApp();
    const items = Array.from({ length: 20000 }, (_, i) => ({ title: "Follow up " + (i % 100) }));
    const t0 = performance.now();
    const res = await router.handle("POST", "/tasks/import", items);
    const ms = performance.now() - t0;
    const all = store.getAllTasks();
    console.log(JSON.stringify({ ms, status: res.status, n: all.length, last: all[all.length - 1].slug, first: all[0].slug }));
  `;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 25_000,
  });
  assert.notEqual(r.status, null, "import of 20,000 tasks did not finish within 25 s");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
  assert.equal(out.status, 201);
  assert.equal(out.n, 20000);
  assert.equal(out.first, "follow-up-0");
  assert.equal(out.last, "follow-up-99-200");
  // Generous bound: a hash-based lookup finishes in well under 1 s; the quadratic scan takes minutes.
  assert.ok(out.ms < 6000, `import took ${Math.round(out.ms)} ms`);
});
