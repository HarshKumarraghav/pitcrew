import type { NewTaskInput, Page, Task, TaskStatus } from "../types/task.ts";

/** Typed fetch-based client for the taskboard HTTP API. */
export class TaskClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`${method} ${path} failed: ${res.status} ${err.error ?? ""}`.trim());
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  list(
    opts: { status?: TaskStatus; dueBefore?: string; page?: number; pageSize?: number } = {},
  ): Promise<Page<Task>> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set("status", opts.status);
    if (opts.dueBefore) qs.set("dueBefore", opts.dueBefore);
    if (opts.page) qs.set("page", String(opts.page));
    if (opts.pageSize) qs.set("pageSize", String(opts.pageSize));
    const q = qs.toString();
    return this.request("GET", "/tasks" + (q ? `?${q}` : ""));
  }

  get(id: number): Promise<Task> {
    return this.request("GET", `/tasks/${id}`);
  }

  create(input: NewTaskInput): Promise<Task> {
    return this.request("POST", "/tasks", input);
  }

  overdue(): Promise<Task[]> {
    return this.request("GET", "/tasks/overdue");
  }

  setStatus(id: number, status: TaskStatus): Promise<Task> {
    return this.request("PATCH", `/tasks/${id}`, { status });
  }

  remove(id: number): Promise<void> {
    return this.request("DELETE", `/tasks/${id}`);
  }
}
