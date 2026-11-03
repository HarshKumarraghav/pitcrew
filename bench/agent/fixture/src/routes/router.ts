import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export interface RouteResult {
  status: number;
  body?: unknown;
}

export type Handler = (ctx: RouteContext) => RouteResult | Promise<RouteResult>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/** Minimal method + path router. Path params use the `:name` syntax. */
export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), "([^/]+)")) + "$",
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  async handle(method: string, url: string, body: unknown): Promise<RouteResult> {
    const { pathname, searchParams } = new URL(url, "http://localhost");
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      return r.handler({ params, query: searchParams, body });
    }
    return { status: 404, body: { error: "not found" } };
  }

  /** Adapter for node:http. */
  listener() {
    return async (req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body: unknown = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid json" }));
          return;
        }
      }
      const result = await this.handle(req.method ?? "GET", req.url ?? "/", body);
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(result.body === undefined ? "" : JSON.stringify(result.body));
    };
  }
}
