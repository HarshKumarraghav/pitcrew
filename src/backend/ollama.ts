import { spawn, type ChildProcess } from "node:child_process";

export interface TagModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  remote_host?: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string; parent_model?: string };
}

export interface ShowResponse {
  model_info?: Record<string, unknown>;
  details?: TagModel["details"];
  parameters?: string;
  capabilities?: string[];
  remote_host?: string;
  remote_model?: string;
}

export interface PsModel {
  name: string;
  model: string;
  size: number;
  size_vram: number;
  context_length?: number;
  expires_at?: string;
}

export class BackendError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Thin client for the Ollama control-plane endpoints the governor needs. */
export class OllamaClient {
  readonly url: string;

  constructor(url: string) {
    this.url = url.replace(/\/$/, "");
  }

  private async json<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const res = await fetch(this.url + path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      signal: init?.signal ?? AbortSignal.timeout(init?.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new BackendError(`${path}: ${res.status} ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  version(): Promise<{ version: string }> {
    return this.json("/api/version", { timeoutMs: 3000 });
  }

  async tags(): Promise<TagModel[]> {
    return (await this.json<{ models?: TagModel[] }>("/api/tags")).models ?? [];
  }

  show(model: string): Promise<ShowResponse> {
    return this.json("/api/show", { method: "POST", body: JSON.stringify({ model }) });
  }

  async ps(): Promise<PsModel[]> {
    return (await this.json<{ models?: PsModel[] }>("/api/ps", { timeoutMs: 5000 })).models ?? [];
  }

  /** Load a model into memory without generating. Returns backend-reported load time (ms). */
  async load(model: string, keepAlive: string | number): Promise<number> {
    const r = await this.json<{ load_duration?: number }>("/api/generate", {
      method: "POST",
      body: JSON.stringify({ model, prompt: "", keep_alive: keepAlive, stream: false }),
      timeoutMs: 15 * 60_000,
    });
    return (r.load_duration ?? 0) / 1e6;
  }

  async unload(model: string): Promise<void> {
    await this.json("/api/generate", {
      method: "POST",
      body: JSON.stringify({ model, prompt: "", keep_alive: 0, stream: false }),
      timeoutMs: 60_000,
    });
  }

  /** Create a derived model that shares the parent's weight blobs. */
  async create(model: string, from: string, parameters: Record<string, unknown>): Promise<void> {
    await this.json("/api/create", {
      method: "POST",
      body: JSON.stringify({ model, from, parameters, stream: false }),
      timeoutMs: 120_000,
    });
  }

  async remove(model: string): Promise<void> {
    await this.json("/api/delete", { method: "DELETE", body: JSON.stringify({ model }) });
  }
}

/** Runs a private `ollama serve` with governor-chosen settings, sharing the normal model store. */
export class ManagedOllama {
  private child?: ChildProcess;
  readonly url: string;
  private env: Record<string, string>;

  constructor(url: string, env: Record<string, string>) {
    this.url = url;
    this.env = env;
  }

  async start(): Promise<void> {
    const host = new URL(this.url).host;
    this.child = spawn("ollama", ["serve"], {
      env: { ...process.env, ...this.env, OLLAMA_HOST: host },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    this.child.stderr?.on("data", (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    const client = new OllamaClient(this.url);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) throw new Error(`managed ollama exited: ${stderr.slice(-500)}`);
      try {
        await client.version();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error("managed ollama did not become ready within 30s");
  }

  stop(): void {
    this.child?.kill("SIGTERM");
  }
}
