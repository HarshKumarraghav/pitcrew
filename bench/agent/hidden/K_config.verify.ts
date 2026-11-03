import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { TaskStore } from "../src/store/taskStore.ts";

type P = { items: unknown[]; pageSize: number; total: number };
const D = "TASKBOARD_DEFAULT_PAGE_SIZE";
const M = "TASKBOARD_MAX_PAGE_SIZE";

test("defaults", () => {
  assert.deepEqual({ ...loadConfig({}) }, { defaultPageSize: 20, maxPageSize: 100 });
});

test("reads both variables from the given env", () => {
  assert.deepEqual({ ...loadConfig({ [D]: "5", [M]: "50" }) }, { defaultPageSize: 5, maxPageSize: 50 });
  assert.deepEqual({ ...loadConfig({ [M]: "500" }) }, { defaultPageSize: 20, maxPageSize: 500 });
});

test("rejects values that are not positive integers, naming the variable", () => {
  for (const bad of ["0", "-5", "abc", "1.5", "10abc"]) {
    assert.throws(() => loadConfig({ [D]: bad }), (e: Error) => e instanceof Error && e.message.includes(D), `${D}=${bad}`);
    assert.throws(() => loadConfig({ [M]: bad }), (e: Error) => e instanceof Error && e.message.includes(M), `${M}=${bad}`);
  }
});

test("rejects a default larger than the max", () => {
  assert.throws(() => loadConfig({ [D]: "50", [M]: "10" }), (e: Error) => /TASKBOARD_(DEFAULT|MAX)_PAGE_SIZE/.test(e.message));
  assert.throws(() => loadConfig({ [D]: "150" }), (e: Error) => /TASKBOARD_(DEFAULT|MAX)_PAGE_SIZE/.test(e.message));
  assert.deepEqual({ ...loadConfig({ [D]: "10", [M]: "10" }) }, { defaultPageSize: 10, maxPageSize: 10 });
});

function seeded(n: number) {
  const store = new TaskStore();
  for (let i = 0; i < n; i++) store.create({ title: `t${i}` });
  return store;
}

test("GET /tasks uses the configured default and clamps to the configured max", async () => {
  const { router } = buildApp(seeded(5), { defaultPageSize: 2, maxPageSize: 3 });
  const def = (await router.handle("GET", "/tasks", undefined)).body as P;
  assert.equal(def.items.length, 2);
  assert.equal(def.pageSize, 2);
  const big = (await router.handle("GET", "/tasks?pageSize=50", undefined)).body as P;
  assert.equal(big.items.length, 3);
  assert.equal(big.pageSize, 3);
  assert.equal(big.total, 5);
});

test("a max above the old hard-coded 100 is honoured", async () => {
  const { router } = buildApp(seeded(300), { defaultPageSize: 250, maxPageSize: 500 });
  const def = (await router.handle("GET", "/tasks", undefined)).body as P;
  assert.equal(def.items.length, 250);
  const big = (await router.handle("GET", "/tasks?pageSize=400", undefined)).body as P;
  assert.equal(big.items.length, 300);
  assert.equal(big.pageSize, 400);
});

test("buildApp() without a config reads the environment at call time", async () => {
  const before = process.env[D];
  process.env[D] = "3";
  try {
    const { router, store } = buildApp();
    for (let i = 0; i < 5; i++) store.create({ title: `t${i}` });
    const res = (await router.handle("GET", "/tasks", undefined)).body as P;
    assert.equal(res.items.length, 3);
  } finally {
    if (before === undefined) delete process.env[D];
    else process.env[D] = before;
  }
  const { router, store } = buildApp();
  for (let i = 0; i < 25; i++) store.create({ title: `t${i}` });
  assert.equal(((await router.handle("GET", "/tasks", undefined)).body as P).items.length, 20);
});

test("the server refuses to start with an invalid config", () => {
  const server = realpathSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)));
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", server], {
    env: { ...process.env, PORT: "0", [M]: "0" },
    encoding: "utf8",
    timeout: 8000,
  });
  assert.notEqual(r.status, null, "server kept running (should exit on invalid config)");
  assert.notEqual(r.status, 0);
});
