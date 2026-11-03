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
