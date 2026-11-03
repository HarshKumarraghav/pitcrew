import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject, retrieve, scout, renderArtifacts } from "../src/intel/index.ts";
import { tokenize } from "../src/intel/bm25.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "agent", "fixture");
const { index, sources } = scanProject(FIXTURE);
const top = (task: string, k = 5) => retrieve(FIXTURE, task, { k, index, sources }).filter((h) => !h.path.startsWith("tests/")).map((h) => h.path);

test("tokenizer splits identifiers and stems plurals", () => {
  assert.deepEqual(tokenize("getAllTasks"), ["get", "all", "task", "getalltasks"].filter((t) => !["get", "all"].includes(t)));
  assert.ok(tokenize("task_store filtering").includes("filter"));
});

test("profiles a zero-dependency Node project from facts", () => {
  const p = index.profile;
  assert.equal(p.name, "taskboard");
  assert.deepEqual(p.frameworks, ["none (Node.js built-in node:http)"]);
  assert.equal(p.testRunner, "node:test (built-in)");
  assert.equal(p.testCommand, "npm test");
  assert.ok(p.routes.some((r) => r.route === "GET /tasks/:id" && r.file === "src/routes/tasks.ts"));
  assert.ok(p.conventions.some((c) => c.includes("`.ts` extension")));
  assert.ok(p.dirs.some((d) => d.dir === "src/routes" && d.role.includes("HTTP")));
});

test("resolves internal imports into a dependency graph", () => {
  const routes = index.modules.find((m) => m.path === "src/routes/tasks.ts")!;
  assert.deepEqual(routes.internalDeps.sort(), ["src/routes/router.ts", "src/store/taskStore.ts", "src/types/task.ts", "src/utils/paginate.ts"]);
  const store = index.modules.find((m) => m.path === "src/store/taskStore.ts")!;
  assert.ok(store.symbols.some((s) => s.name === "getAllTasks" && s.kind === "method"));
});

test("retrieval: multi-file feature task finds all four files to change", () => {
  const got = top("Add a task priority field: type in Task, store default, POST /tasks validation, GET /tasks priority filter, TaskClient.list option");
  for (const f of ["src/types/task.ts", "src/store/taskStore.ts", "src/routes/tasks.ts", "src/api/client.ts"]) {
    assert.ok(got.includes(f), `${f} missing from top-5: ${got.join(", ")}`);
  }
});

test("retrieval: exact symbol in the task ranks its definition first", () => {
  const got = top("rename the TaskStore method getAllTasks to listTasks and add GET /tasks/stats", 3);
  assert.equal(got[0], "src/store/taskStore.ts");
  assert.ok(got.includes("src/routes/tasks.ts"));
});

test("retrieval: bug report points at the culprit and its test", () => {
  const hits = retrieve(FIXTURE, "slugify does not collapse repeated whitespace into a single hyphen", { k: 3, index, sources });
  assert.equal(hits[0]?.path, "src/utils/slugify.ts");
  assert.ok(hits.some((h) => h.path === "tests/slugify.test.ts"), "related test is attached");
});

test("scout writes all artifacts outside the repository", () => {
  const state = mkdtempSync(join(tmpdir(), "pitcrew-scout-"));
  const r = scout(FIXTURE, state);
  assert.ok(r.dir.startsWith(state));
  for (const f of ["PRODUCT_OVERVIEW.md", "ARCHITECTURE.md", "MODULE_MAP.json", "DEPENDENCY_GRAPH.json", "ENGINEERING_CONVENTIONS.md", "TESTING_GUIDE.md", "index.json"]) {
    assert.ok(existsSync(join(r.dir, f)), f);
  }
  assert.ok(!existsSync(join(FIXTURE, "PRODUCT_OVERVIEW.md")), "repo untouched");
  const graph = JSON.parse(readFileSync(join(r.dir, "DEPENDENCY_GRAPH.json"), "utf8"));
  assert.ok(graph.edges.some((e: { from: string; to: string }) => e.from === "src/server.ts" && e.to === "src/routes/router.ts"));
  assert.match(renderArtifacts(index)["TESTING_GUIDE.md"]!, /npm test/);
});
