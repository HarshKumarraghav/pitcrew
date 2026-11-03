// Task definitions for the agent benchmark.
//
// Each task:
//   name, prompt                  shown to the agent (prompt only)
//   fixture?                      directory under bench/agent to copy (default "fixture")
//   setup?(dir)                   mutate the copy before the baseline commit
//   setupGit?(dir, ctx)           runs after the baseline commit; may add commits (ctx: sh, overlay, fixedGitEnv)
//   verify?                       hidden node:test file in hidden/ (copied to .verify/ after the run)
//   verifyFn?(dir, text, ctx)     extra checks → object of booleans (ctx: sh, startRev)
//   rubric?                       [label, RegExp] pairs matched against the agent's text
//   protect?                      extra paths that count as "tests" for testsUntouched
//   success                       rule evaluated by lib.mjs judge() (see there)
//   reference?                    { overlay?: "reference/<K>", answer?: string | (dir, ctx) => string } for selftest.mjs
//   traps?                        [{ name, apply(dir), answer? }] known-wrong solutions; selftest checks they FAIL
//
// A–F are the original regression set; their prompts and success semantics are unchanged.
// G–P are the harder set (M7.1).

import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, overlay } from "./lib.mjs";

const P_COMMITS = [
  ["01-readme", "docs: document the HTTP endpoints in the README"],
  ["02-count", "store: add TaskStore.count()"],
  ["03-accents", "utils: strip accents in slugify"],
  ["04-trim", "routes: trim titles on create"],
  ["05-simplify", "utils: simplify slugify"], // ← the regression
  ["06-client", "client: encode ids in request paths"],
  ["07-tests", "tests: cover pagination clamping"],
  ["08-version", "chore: bump version to 0.4.0"],
];
const P_BAD_SUBJECT = "utils: simplify slugify";

/** Exact string replacement in a task file (for selftest traps); throws if `from` is missing. */
function edit(dir, file, from, to) {
  const p = join(dir, file);
  const src = readFileSync(p, "utf8");
  if (!src.includes(from)) throw new Error(`edit: pattern not found in ${file}`);
  writeFileSync(p, src.replace(from, to));
}

/** Full hash of the commit with this exact subject reachable from `rev`. */
function commitBySubject(sh, dir, rev, subject) {
  const line = sh(`git log --format=%H%x09%s ${rev}`, dir).trim().split("\n").find((l) => l.split("\t")[1] === subject);
  return line?.split("\t")[0] ?? "";
}

export const TASKS = {
  A: {
    name: "Basic code generation",
    prompt:
      "Create src/utils/chunk.ts exporting `chunk<T>(items: T[], size: number): T[][]` that splits `items` into consecutive groups of `size` (the last group may be shorter; empty input returns []; the input array must not be mutated). It must throw a RangeError if `size` is not a positive integer. Add tests in tests/chunk.test.ts following the existing test conventions, then run the test suite and make sure everything passes.",
    verify: "A_chunk.verify.ts",
    success: { verify: true, suite: true },
    reference: { overlay: "reference/A" },
  },
  B: {
    name: "Repository understanding",
    prompt:
      "Do not modify any files. Explore this repository and explain: (1) language, runtime and web framework (if any), (2) overall architecture and layers, (3) how HTTP routing works, (4) where application state lives, (5) the API client layer, (6) testing conventions and how tests are run. Be concise and cite file paths.",
    rubric: [
      ["no framework / node:http", /node:http|no (web )?framework|zero[- ]dependenc|without (a|any) (web )?framework/i],
      ["Router class + :param regex", /Router/],
      ["TaskStore in-memory Map", /TaskStore/],
      ["in-memory state", /in-memory|Map/i],
      ["TaskClient uses fetch", /TaskClient/],
      ["fetch", /fetch/],
      ["node:test runner", /node:test|node --test|built-in test/i],
      ["strip-types", /strip-types/i],
      ["tests call router.handle directly", /router\.handle|handle\(/],
    ],
    success: { filesUnchanged: true, rubricMin: 7 },
    reference: {
      answer:
        "TypeScript on Node with no framework: src/server.ts uses node:http. src/routes/router.ts has a Router class that turns :param paths into regexes; src/routes/tasks.ts registers handlers. State lives in-memory in TaskStore (a Map) in src/store/taskStore.ts. src/api/client.ts has TaskClient built on fetch. Tests use node:test, run via node --experimental-strip-types --test, and call router.handle() directly.",
    },
  },
  C: {
    name: "Multi-file feature",
    prompt:
      'Add a task priority feature. Requirements: (1) in src/types/task.ts add `export type TaskPriority = "low" | "medium" | "high"`, add `priority: TaskPriority` to Task and an optional `priority` to NewTaskInput; (2) the store defaults priority to "medium"; (3) POST /tasks accepts an optional priority and returns 400 with {"error":"invalid priority"} for invalid values; (4) GET /tasks supports a `priority` query filter that can be combined with `status`, returning 400 for an invalid priority; (5) TaskClient.list accepts a `priority` option and sends it as a query parameter. Add tests for the new behaviour, run the test suite and make sure everything passes.',
    verify: "C_priority.verify.ts",
    success: { verify: true, suite: true },
    reference: { overlay: "reference/C" },
  },
  D: {
    name: "Debugging",
    setup: (dir) => cpSync(join(HERE, "hidden/slugify.buggy.ts"), join(dir, "src/utils/slugify.ts")),
    prompt:
      "`npm test` is failing. Run it, diagnose the root cause, and fix the bug in the source code. Do not modify any test files. Re-run the tests to confirm the fix.",
    // "existing": pre-existing test files must not change; adding a new test file is allowed (as before).
    success: { suite: true, testsUntouched: "existing" },
    reference: { overlay: "reference/D" },
  },
  E: {
    name: "Tool execution",
    prompt:
      "Read package.json to find the test command, run the test suite, and tell me exactly how many tests passed and how many failed. Then run `git log --oneline | wc -l` and report the number. Do not modify any files.",
    verifyFn: (dir, text, { sh }) => ({
      reportsPass9: /\b9\b[^.\n]*pass|pass[^.\n]*\b9\b/i.test(text),
      reportsFail0: /\b0\b[^.\n]*fail|fail[^.\n]*\b0\b|no (tests )?fail/i.test(text),
      reportsCommits1: /\b1\b/.test(text),
      filesUnchanged: sh("git status --porcelain", dir).trim() === "",
    }),
    success: { extraAll: true },
    reference: { answer: "The suite ran 9 tests: 9 passed, 0 failed. `git log --oneline | wc -l` prints 1." },
  },
  F: {
    name: "Reliability (multi-step)",
    prompt:
      "Do the following in order: (1) rename the TaskStore method `getAllTasks` to `listTasks` everywhere in the codebase; (2) add a TaskStore method `countByStatus(): Record<TaskStatus, number>` that returns counts for every status (including zeros); (3) expose it as `GET /tasks/stats`, returning that object as JSON; (4) add a test for the new endpoint; (5) run the test suite and fix any failures; (6) run `git diff --stat` and summarize what changed.",
    verify: "F_stats.verify.ts",
    success: { verify: true, suite: true },
    reference: { overlay: "reference/F" },
  },

  // ------------------------------------------------------------------------------------------
  // Harder set (M7.1)

  G: {
    name: "Route order (DELETE collision)",
    prompt:
      'Add a way to clear out finished work: (1) a TaskStore method `removeByStatus(status: TaskStatus): number` that deletes every task with that status and returns how many were removed; (2) an endpoint `DELETE /tasks/completed` that removes all tasks whose status is "done" and responds 200 with `{"removed": <count>}`; (3) `TaskClient.clearCompleted(): Promise<number>` that calls it and resolves to the count; (4) `DELETE /tasks/:id` must respond 400 with `{"error":"invalid id"}` when the id is not a positive integer (unknown numeric ids stay 404). Add tests and make sure the whole suite passes.',
    verify: "G_clear.verify.ts",
    success: { verify: true, suite: true },
    reference: { overlay: "reference/G" },
    traps: [
      {
        name: "route registered after /tasks/:id",
        apply: (dir) => {
          overlay(dir, "reference/G");
          const block = `  // Must be registered before DELETE /tasks/:id, which would otherwise match "completed".
  router.add("DELETE", "/tasks/completed", () => ({
    status: 200,
    body: { removed: store.removeByStatus("done") },
  }));

`;
          edit(dir, "src/routes/tasks.ts", block, "");
          const p = join(dir, "src/routes/tasks.ts");
          const src = readFileSync(p, "utf8");
          const end = src.lastIndexOf("}\n"); // closing brace of registerTaskRoutes
          writeFileSync(p, `${src.slice(0, end)}\n${block.replace(/\n\n$/, "\n")}}\n`);
          cpSync(join(HERE, "reference/G/tests/clear.test.ts"), join(dir, "tests/clear.test.ts"));
          edit(dir, "tests/clear.test.ts", "assert.equal(res.status, 200);\n  assert.deepEqual(res.body, { removed: 1 });", "assert.ok(res.status);");
        },
      },
    ],
  },
  H: {
    name: "Rename + type change across layers",
    setup: (dir) => overlay(dir, "setup/H"),
    prompt:
      'We are switching due dates to epoch milliseconds. Rename the task field `dueDate` (an ISO string) to `dueAt` (a number: milliseconds since the Unix epoch) everywhere: types, store, routes, API client and tests. POST /tasks takes `dueAt` as a non-negative integer and answers 400 `{"error":"invalid dueAt"}` for anything else; the `dueBefore` query parameter of GET /tasks also becomes epoch milliseconds (400 `{"error":"invalid dueBefore"}` if it is not a non-negative integer); `TaskClient.list` takes `dueBefore` as a number. The overdue endpoint must keep working. When you are done, `dueDate` should not appear anywhere in src/ or tests/. Update the tests and make sure the suite passes.',
    verify: "H_dueAt.verify.ts",
    success: { verify: true, suite: true },
    reference: { overlay: "reference/H" },
  },
  I: {
    name: "Order-dependent test (shared state)",
    setup: (dir) => overlay(dir, "setup/I"),
    prompt:
      'The test "a fresh app starts from a clean slate" in tests/ids.test.ts is flaky: it passes when I run it on its own (`node --experimental-strip-types --no-warnings --test --test-name-pattern="clean slate" tests/ids.test.ts`) but fails as part of `npm test`. Every `buildApp()` / `new TaskStore()` is supposed to be completely independent of any other. Please fix the actual cause. The tests are correct, so do not change, skip or reorder them. Run the full suite when you are done.',
    verify: "I_isolation.verify.ts",
    success: { verify: true, suite: true, testsUntouched: true },
    reference: { overlay: "reference/I" },
    traps: [
      {
        name: "reset module state in the constructor",
        apply: (dir) => {
          edit(dir, "src/utils/uniqueSlug.ts", "/** Give a slug back", "export function resetSlugs(): void {\n  taken.clear();\n}\n\n/** Give a slug back");
          edit(dir, "src/store/taskStore.ts", "import { releaseSlug, uniqueSlug }", "import { releaseSlug, resetSlugs, uniqueSlug }");
          edit(dir, "src/store/taskStore.ts", "    this.now = now;\n", "    this.now = now;\n    nextId = 1;\n    resetSlugs();\n");
        },
      },
      { name: "edit the flaky test", apply: (dir) => edit(dir, "tests/ids.test.ts", "assert.equal((res.body as T).id, 1);\n  assert.equal((res.body as T).slug, \"write-docs\");", "assert.equal(res.status, 201);") },
    ],
  },
  J: {
    name: "Misleading stack trace",
    setup: (dir) => overlay(dir, "setup/J"),
    prompt:
      "`npm test` fails with `TypeError: Cannot read properties of undefined (reading 'slug')`, thrown from src/routes/present.ts. Please fix the bug properly and confirm the whole suite passes. Don't change the existing tests.",
    verify: "J_slugindex.verify.ts",
    success: { verify: true, suite: true, testsUntouched: "existing" },
    reference: { overlay: "reference/J" },
    traps: [
      {
        name: "null check where it crashes",
        apply: (dir) =>
          edit(dir, "src/routes/tasks.ts", "return { status: 200, body: present(store.findBySlug(params.slug)!) };", 'const t = store.findBySlug(params.slug);\n    return t ? { status: 200, body: present(t) } : { status: 404, body: { error: "not found" } };'),
      },
    ],
  },
  K: {
    name: "Config + code (env settings)",
    prompt:
      "Make the page sizes configurable through environment variables. Add src/config.ts exporting `interface Config { defaultPageSize: number; maxPageSize: number }` and `loadConfig(env: Record<string, string | undefined> = process.env): Config`, which reads `TASKBOARD_DEFAULT_PAGE_SIZE` (default 20) and `TASKBOARD_MAX_PAGE_SIZE` (default 100). Both must be positive integers and the default must not exceed the max; otherwise `loadConfig` throws an Error whose message names the offending variable. `buildApp` should take the config as an optional second argument (falling back to `loadConfig()` when it is omitted), and GET /tasks must use it instead of the current hard-coded numbers: no `pageSize` means the configured default, and larger requests are clamped to the configured max. Starting the server with an invalid configuration must fail immediately with a non-zero exit code. Add tests and make sure the suite passes.",
    verify: "K_config.verify.ts",
    success: { verify: true, suite: true },
    reference: { overlay: "reference/K" },
  },
  L: {
    name: "Pagination off-by-one across layers",
    setup: (dir) => overlay(dir, "setup/L"),
    prompt:
      "Users report that `TaskClient.listAll()` silently drops tasks, and that the `totalPages` and `nextPage` fields of GET /tasks responses look wrong around the last page. Fix pagination end to end and add regression tests. Make sure the suite passes.",
    verify: "L_pages.verify.ts",
    success: { verify: true, suite: true },
    reference: { overlay: "reference/L" },
    traps: [
      { name: "fix only the client loop", apply: (dir) => edit(dir, "src/api/client.ts", "page < first.totalPages;", "page <= first.totalPages;") },
      {
        name: "fix util + client, not the route",
        apply: (dir) => {
          edit(dir, "src/api/client.ts", "page < first.totalPages;", "page <= first.totalPages;");
          edit(dir, "src/utils/paginate.ts", "Math.floor(items.length / safeSize)", "Math.ceil(items.length / safeSize)");
        },
      },
    ],
  },
  M: {
    name: "Validation without weakening tests",
    setup: (dir) => overlay(dir, "setup/M"),
    prompt:
      'Tighten request validation in the task routes. (1) POST /tasks: `title` must be a string that is 1–120 characters long after trimming, and the trimmed title is what gets stored; otherwise answer 400 `{"error":"title is required"}`, or `{"error":"title too long"}` when it is longer than 120 characters. Only `title` and `status` are accepted; any other body field gets 400 `{"error":"unknown field: <name>"}`. (2) GET, PATCH and DELETE /tasks/:id: if the id is not a positive integer, answer 400 `{"error":"invalid id"}` (unknown ids stay 404). (3) PATCH /tasks/:id: the body must be a JSON object, and fields that are not part of a Task get 400 `{"error":"unknown field: <name>"}`; `status` is still the only field PATCH changes. All existing tests must keep passing and must not be modified; put your new tests in a new file under tests/.',
    verify: "M_validation.verify.ts",
    success: { verify: true, suite: true, testsUntouched: "existing" },
    reference: { overlay: "reference/M" },
    traps: [
      {
        name: "PATCH allows only status + edits the contract test",
        apply: (dir) => {
          overlay(dir, "reference/M");
          edit(dir, "src/routes/tasks.ts", "const extra = unknownField(body, TASK_FIELDS);", 'const extra = unknownField(body, new Set(["status"]));');
          edit(dir, "tests/compat.test.ts", "{ ...got, status: \"done\" }", "{ status: \"done\" }");
        },
      },
    ],
  },
  N: {
    name: "Performance fix (hidden timing check)",
    setup: (dir) => overlay(dir, "setup/N"),
    prompt:
      'Bulk imports are unusably slow: `POST /tasks/import` with about 20,000 tasks (many of them share titles, like "Follow up 12") takes minutes. Make importing that many tasks take well under a few seconds without changing any behaviour: slugs, ids, ordering and error handling must stay exactly as they are (the existing tests describe them, so leave those tests alone). Run the test suite when you are done.',
    verify: "N_perf.verify.ts",
    success: { verify: true, suite: true, testsUntouched: "existing" },
    reference: { overlay: "reference/N" },
    traps: [
      {
        name: "fast per-title counter (changes slug reuse behaviour)",
        apply: (dir) =>
          edit(
            dir,
            "src/store/taskStore.ts",
            "    let slug = base;\n    for (let n = 2; this.getAllTasks().some((t) => t.slug === slug); n++) slug = `${base}-${n}`;\n    return slug;\n  }\n",
            "    const n = (this.seen.get(base) ?? 0) + 1;\n    this.seen.set(base, n);\n    return n === 1 ? base : `${base}-${n}`;\n  }\n\n  private seen = new Map<string, number>();\n",
          ),
      },
    ],
  },
  O: {
    name: "Refactor keeping the public API",
    setup: (dir) => overlay(dir, "setup/O"),
    prompt:
      "src/api/client.ts is doing too much. Split it up: move `ApiError` into src/api/errors.ts and `buildQuery` into src/api/query.ts, keep `TaskClient` (with its option types and `DEFAULT_TIMEOUT_MS`) in src/api/client.ts, and add src/api/index.ts that re-exports the whole public API. Other packages import from src/api/client.ts today, so everything that is exported from there now must keep working from that path, with identical behaviour. Do not change the tests; run them when you are done.",
    verify: "O_split.verify.ts",
    success: { verify: true, suite: true, testsUntouched: true },
    reference: { overlay: "reference/O" },
    traps: [
      {
        name: "copy ApiError/buildQuery instead of moving them",
        apply: (dir) => {
          overlay(dir, "reference/O");
          cpSync(join(HERE, "setup/O/src/api/client.ts"), join(dir, "src/api/client.ts"));
        },
      },
    ],
  },
  P: {
    name: "Git history investigation (long tool chain)",
    setupGit: (dir, { sh, overlay, fixedGitEnv }) => {
      P_COMMITS.forEach(([sub, msg], i) => {
        overlay(dir, `setup/P/${sub}`);
        const env = fixedGitEnv(`2026-01-${String(6 + i).padStart(2, "0")}T10:00:00Z`);
        sh(`git add -A && git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -qm '${msg}'`, dir, env);
      });
    },
    prompt:
      "Slugs changed recently for titles that have punctuation inside words: \"Don't panic\" used to get the slug `dont-panic` but now gets `don-t-panic`, and the same happens to titles like \"Q&A session\". Use the git history to find the commit that introduced this regression and tell me its short hash and subject line. Then fix it so these titles get their old slugs again, without losing anything else that was added since. Add a regression test and run the suite.",
    verify: "P_slugs.verify.ts",
    verifyFn: (dir, text, { sh, startRev }) => {
      const full = commitBySubject(sh, dir, startRev, P_BAD_SUBJECT);
      const hexes = (text.match(/\b[0-9a-f]{7,40}\b/gi) ?? []).map((h) => h.toLowerCase());
      return {
        namesRegressionCommit: text.toLowerCase().includes(P_BAD_SUBJECT.split(": ")[1]) || (!!full && hexes.some((h) => full.startsWith(h))),
      };
    },
    success: { verify: true, suite: true, extraAll: true },
    reference: {
      overlay: "reference/P",
      // Answer by short hash only, so the selftest exercises the hash path of the check.
      answer: (dir, { sh, startRev }) => `The regression came in with commit ${commitBySubject(sh, dir, startRev, P_BAD_SUBJECT).slice(0, 7)}.`,
    },
    traps: [
      { name: "right fix, wrong commit named", apply: (dir) => overlay(dir, "reference/P"), answer: "It was introduced by `utils: strip accents in slugify`." },
      {
        name: "restore slugify from before the accent commit",
        apply: (dir) => cpSync(join(HERE, "fixture/src/utils/slugify.ts"), join(dir, "src/utils/slugify.ts")),
        answer: "The culprit is `utils: simplify slugify`.",
      },
    ],
  },
};

export const HARD = ["G", "H", "I", "J", "K", "L", "M", "N", "O", "P"];
export const REGRESSION = ["A", "B", "C", "D", "E", "F"];
