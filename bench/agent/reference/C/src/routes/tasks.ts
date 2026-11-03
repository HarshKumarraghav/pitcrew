import type { TaskPriority, TaskStatus } from "../types/task.ts";
import type { TaskStore } from "../store/taskStore.ts";
import type { Router } from "./router.ts";
import { paginate } from "../utils/paginate.ts";

const STATUSES: TaskStatus[] = ["todo", "doing", "done"];
const PRIORITIES: TaskPriority[] = ["low", "medium", "high"];

function isStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (STATUSES as string[]).includes(v);
}

function isPriority(v: unknown): v is TaskPriority {
  return typeof v === "string" && (PRIORITIES as string[]).includes(v);
}

export function registerTaskRoutes(router: Router, store: TaskStore): void {
  router.add("GET", "/tasks", ({ query }) => {
    const status = query.get("status");
    if (status !== null && !isStatus(status)) {
      return { status: 400, body: { error: "invalid status" } };
    }
    const priority = query.get("priority");
    if (priority !== null && !isPriority(priority)) {
      return { status: 400, body: { error: "invalid priority" } };
    }
    const tasks = store.getAllTasks(status ?? undefined, priority ?? undefined);
    const page = Number(query.get("page") ?? 1);
    const pageSize = Number(query.get("pageSize") ?? 20);
    return { status: 200, body: paginate(tasks, page, pageSize) };
  });

  router.add("GET", "/tasks/:id", ({ params }) => {
    const task = store.get(Number(params.id));
    return task ? { status: 200, body: task } : { status: 404, body: { error: "not found" } };
  });

  router.add("POST", "/tasks", ({ body }) => {
    const input = body as { title?: unknown; status?: unknown; priority?: unknown } | undefined;
    if (!input || typeof input.title !== "string" || input.title.trim() === "") {
      return { status: 400, body: { error: "title is required" } };
    }
    if (input.status !== undefined && !isStatus(input.status)) {
      return { status: 400, body: { error: "invalid status" } };
    }
    if (input.priority !== undefined && !isPriority(input.priority)) {
      return { status: 400, body: { error: "invalid priority" } };
    }
    return {
      status: 201,
      body: store.create({ title: input.title, status: input.status, priority: input.priority }),
    };
  });

  router.add("PATCH", "/tasks/:id", ({ params, body }) => {
    const input = body as { status?: unknown } | undefined;
    if (!input || !isStatus(input.status)) {
      return { status: 400, body: { error: "invalid status" } };
    }
    const task = store.updateStatus(Number(params.id), input.status);
    return task ? { status: 200, body: task } : { status: 404, body: { error: "not found" } };
  });

  router.add("DELETE", "/tasks/:id", ({ params }) => {
    return store.remove(Number(params.id))
      ? { status: 204 }
      : { status: 404, body: { error: "not found" } };
  });
}
