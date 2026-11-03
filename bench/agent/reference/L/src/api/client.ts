import type { NewTaskInput, Task, TaskPage, TaskStatus } from "../types/task.ts";

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

  list(opts: { status?: TaskStatus; page?: number; pageSize?: number } = {}): Promise<TaskPage<Task>> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set("status", opts.status);
    if (opts.page) qs.set("page", String(opts.page));
    if (opts.pageSize) qs.set("pageSize", String(opts.pageSize));
    const q = qs.toString();
    return this.request("GET", "/tasks" + (q ? `?${q}` : ""));
  }

  /** Fetch every page and return all matching tasks. */
  async listAll(opts: { status?: TaskStatus; pageSize?: number } = {}): Promise<Task[]> {
    const first = await this.list({ ...opts, page: 1 });
    const items = [...first.items];
    for (let page = 2; page <= first.totalPages; page++) {
      items.push(...(await this.list({ ...opts, page })).items);
    }
    return items;
  }

  get(id: number): Promise<Task> {
    return this.request("GET", `/tasks/${id}`);
  }

  create(input: NewTaskInput): Promise<Task> {
    return this.request("POST", "/tasks", input);
  }

  setStatus(id: number, status: TaskStatus): Promise<Task> {
    return this.request("PATCH", `/tasks/${id}`, { status });
  }

  remove(id: number): Promise<void> {
    return this.request("DELETE", `/tasks/${id}`);
  }
}
