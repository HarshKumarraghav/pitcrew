import type { NewTaskInput, Page, Task, TaskStatus } from "../types/task.ts";

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Error thrown for any non-2xx response. */
export class ApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly code: string | undefined;

  constructor(method: string, path: string, status: number, code?: string) {
    super(`${method} ${path} failed: ${status} ${code ?? ""}`.trim());
    this.name = "ApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.code = code;
  }

  /** True for 404 responses. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export type ListOptions = { status?: TaskStatus; page?: number; pageSize?: number };

/** Build "?a=1&b=2" from the defined options (empty string when there are none). */
export function buildQuery(opts: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const q = qs.toString();
  return q ? `?${q}` : "";
}

export interface ClientOptions {
  timeoutMs?: number;
  /** Extra headers sent with every request (e.g. authorization). */
  headers?: Record<string, string>;
}

/** Typed fetch-based client for the taskboard HTTP API. */
export class TaskClient {
  private baseUrl: string;
  private timeoutMs: number;
  private headers: Record<string, string>;

  constructor(baseUrl: string, opts: ClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.headers = opts.headers ?? {};
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { ...this.headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(method, path, res.status, err.error);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  list(opts: ListOptions = {}): Promise<Page<Task>> {
    return this.request("GET", "/tasks" + buildQuery(opts));
  }

  get(id: number): Promise<Task> {
    return this.request("GET", `/tasks/${id}`);
  }

  /** Like get(), but resolves to undefined instead of throwing on 404. */
  async find(id: number): Promise<Task | undefined> {
    try {
      return await this.get(id);
    } catch (e) {
      if (e instanceof ApiError && e.isNotFound) return undefined;
      throw e;
    }
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
