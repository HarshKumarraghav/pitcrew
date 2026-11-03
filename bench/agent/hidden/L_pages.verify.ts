import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";
import { paginate } from "../src/utils/paginate.ts";
import { TaskClient } from "../src/api/client.ts";

type P = { items: { title: string }[]; page: number; totalPages: number; nextPage: number | null; total: number };
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

test("totalPages rounds up", () => {
  assert.equal(paginate(range(5), 1, 2).totalPages, 3);
  assert.equal(paginate(range(4), 1, 2).totalPages, 2);
  assert.equal(paginate(range(1), 1, 2).totalPages, 1);
  assert.equal(paginate(range(100), 1, 7).totalPages, 15);
  assert.equal(paginate(range(3), 1, 1).totalPages, 3);
  assert.ok([0, 1].includes(paginate([], 1, 2).totalPages));
});

test("pages still slice correctly", () => {
  assert.deepEqual(paginate(range(5), 3, 2).items, [4]);
  assert.deepEqual(paginate(range(5), 1, 2).items, [0, 1]);
  assert.deepEqual(paginate(range(4), 3, 2).items, []);
});

async function app(n: number) {
  const { router, store } = buildApp();
  for (let i = 0; i < n; i++) store.create({ title: `t${i}` });
  const get = async (q: string) => (await router.handle("GET", `/tasks?${q}`, undefined)).body as P;
  return { router, get };
}

test("nextPage is null exactly on the last page", async () => {
  const four = await app(4);
  assert.equal((await four.get("pageSize=2&page=1")).nextPage, 2);
  assert.equal((await four.get("pageSize=2&page=2")).nextPage, null);
  const five = await app(5);
  assert.equal((await five.get("pageSize=2&page=2")).nextPage, 3);
  assert.equal((await five.get("pageSize=2&page=3")).nextPage, null);
  assert.equal((await five.get("pageSize=2&page=3")).totalPages, 3);
  const none = await app(0);
  assert.equal((await none.get("pageSize=2")).nextPage, null);
  const one = await app(3);
  assert.equal((await one.get("pageSize=1&page=3")).nextPage, null);
});

test("TaskClient.listAll returns every task without extra requests", async () => {
  for (const n of [0, 1, 2, 3, 4, 5, 7]) {
    const { router } = await app(n);
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls++;
      const u = new URL(String(url));
      const res = await router.handle("GET", u.pathname + u.search, undefined);
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as typeof fetch;
    let titles: string[];
    try {
      titles = (await new TaskClient("http://x").listAll({ pageSize: 2 })).map((t) => t.title);
    } finally {
      globalThis.fetch = orig;
    }
    assert.deepEqual(titles, range(n).map((i) => `t${i}`), `n=${n}`);
    assert.equal(calls, Math.max(1, Math.ceil(n / 2)), `requests for n=${n}`);
  }
});
