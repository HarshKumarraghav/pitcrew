import type { TaskStatus } from "../types/task.ts";
import type { TaskStore } from "../store/taskStore.ts";
import type { RouteResult, Router } from "./router.ts";
import { paginate } from "../utils/paginate.ts";

const STATUSES: TaskStatus[] = ["todo", "doing", "done"];
const MAX_TITLE = 120;
const CREATE_FIELDS = new Set(["title", "status"]);
const TASK_FIELDS = new Set(["id", "title", "slug", "status", "createdAt"]);

function isStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (STATUSES as string[]).includes(v);
}

function bad(error: string): RouteResult {
  return { status: 400, body: { error } };
}

/** Parse a positive-integer path id; undefined if invalid. */
function parseId(raw: string): number | undefined {
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownField(body: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(body).find((k) => !allowed.has(k));
}

export function registerTaskRoutes(router: Router, store: TaskStore): void {
  router.add("GET", "/tasks", ({ query }) => {
    const status = query.get("status");
    if (status !== null && !isStatus(status)) {
      return { status: 400, body: { error: "invalid status" } };
    }
    const tasks = store.getAllTasks(status ?? undefined);
    const page = Number(query.get("page") ?? 1);
    const pageSize = Number(query.get("pageSize") ?? 20);
    return { status: 200, body: paginate(tasks, page, pageSize) };
  });

  router.add("GET", "/tasks/:id", ({ params }) => {
    const id = parseId(params.id);
    if (id === undefined) return bad("invalid id");
    const task = store.get(id);
    return task ? { status: 200, body: task } : { status: 404, body: { error: "not found" } };
  });

  router.add("POST", "/tasks", ({ body }) => {
    if (!isObject(body)) return bad("title is required");
    const extra = unknownField(body, CREATE_FIELDS);
    if (extra !== undefined) return bad(`unknown field: ${extra}`);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title === "") return bad("title is required");
    if (title.length > MAX_TITLE) return bad("title too long");
    if (body.status !== undefined && !isStatus(body.status)) return bad("invalid status");
    return { status: 201, body: store.create({ title, status: body.status }) };
  });

  router.add("PATCH", "/tasks/:id", ({ params, body }) => {
    const id = parseId(params.id);
    if (id === undefined) return bad("invalid id");
    if (!isObject(body)) return bad("invalid body");
    const extra = unknownField(body, TASK_FIELDS);
    if (extra !== undefined) return bad(`unknown field: ${extra}`);
    if (!isStatus(body.status)) return bad("invalid status");
    const task = store.updateStatus(id, body.status);
    return task ? { status: 200, body: task } : { status: 404, body: { error: "not found" } };
  });

  router.add("DELETE", "/tasks/:id", ({ params }) => {
    const id = parseId(params.id);
    if (id === undefined) return bad("invalid id");
    return store.remove(id) ? { status: 204 } : { status: 404, body: { error: "not found" } };
  });
}
