import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const G = 1024 ** 3;

export interface MockModel {
  name: string;
  size: number;
  remote?: boolean;
}

/** A fake Ollama that tracks loaded models and streams OpenAI-style responses. */
export async function startMockOllama(models: MockModel[], opts: { tokenDelayMs?: number; parallel?: number } = {}) {
  // Requests the mock serves at once per model (OLLAMA_NUM_PARALLEL); the rest wait in line.
  let active = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    while (active >= (opts.parallel ?? 1)) await new Promise<void>((r) => waiting.push(r));
    active++;
    return () => {
      active--;
      waiting.shift()?.();
    };
  };
  const created = new Map<string, { from: string; num_ctx: number }>();
  const loaded = new Map<string, number>();
  const calls: string[] = [];
  const baseOf = (name: string) => created.get(name)?.from ?? name;
  const sizeOf = (name: string) => {
    const m = models.find((x) => x.name === baseOf(name));
    const ctx = created.get(name)?.num_ctx ?? 4096;
    return (m?.size ?? G) + ctx * 32 * 1024;
  };

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const json = (s: number, b: unknown) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    const url = req.url ?? "";
    calls.push(`${req.method} ${url}${body.model ? ` ${body.model}` : ""}${body.keep_alive !== undefined ? ` ka=${body.keep_alive}` : ""}`);
    if (url === "/api/version") return json(200, { version: "mock" });
    if (url === "/api/tags") {
      return json(200, {
        models: [
          ...models.map((m) => ({ name: m.name, model: m.name, size: m.size, digest: `d-${m.name}`, ...(m.remote ? { remote_host: "https://ollama.com" } : {}) })),
          ...[...created.keys()].map((n) => ({ name: n, model: n, size: 0, digest: `d-${n}` })),
        ],
      });
    }
    if (url === "/api/show") {
      return json(200, {
        model_info: {
          "general.architecture": "qwen35",
          "qwen35.block_count": 32,
          "qwen35.attention.head_count": 16,
          "qwen35.attention.head_count_kv": 4,
          "qwen35.attention.key_length": 256,
          "qwen35.attention.value_length": 256,
          "qwen35.full_attention_interval": 4,
          "qwen35.embedding_length": 4096,
        },
      });
    }
    if (url === "/api/create") {
      created.set(body.model, { from: body.from, num_ctx: body.parameters?.num_ctx ?? 4096 });
      return json(200, { status: "success" });
    }
    if (url === "/api/ps") {
      return json(200, {
        models: [...loaded.entries()].map(([name, size]) => ({ name, model: name, size, size_vram: size, expires_at: "2318-01-01T00:00:00Z" })),
      });
    }
    if (url === "/api/generate" && !body.prompt) {
      if (body.keep_alive === 0) loaded.delete(body.model);
      else loaded.set(body.model, sizeOf(body.model));
      return json(200, { done: true, load_duration: 5_000_000 });
    }
    if (url === "/api/generate" && body.prompt) {
      const done = await slot();
      if (!loaded.has(body.model)) loaded.set(body.model, sizeOf(body.model));
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (let i = 0; i < 5; i++) {
        res.write(JSON.stringify({ model: body.model, response: `${i} `, done: false }) + "\n");
        await new Promise((r) => setTimeout(r, opts.tokenDelayMs ?? 0));
      }
      res.end(JSON.stringify({ model: body.model, response: "", done: true, eval_count: 5 }) + "\n");
      return done();
    }
    if (url === "/v1/chat/completions") {
      if (!loaded.has(body.model)) loaded.set(body.model, sizeOf(body.model));
      const promptTokens = Math.round(JSON.stringify(body.messages).length / 4);
      if (!body.stream) {
        return json(200, {
          id: "x",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
        });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const delay = () => new Promise((r) => setTimeout(r, opts.tokenDelayMs ?? 0));
      for (let i = 0; i < (body.max_tokens ?? 3); i++) {
        if (res.destroyed) return;
        send({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `t${i} ` } }] });
        await delay();
      }
      send({
        id: "x",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] }, finish_reason: "tool_calls" }],
      });
      send({ id: "x", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 4 } });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    json(404, { error: `mock: no route ${url}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, loaded, created, close: () => new Promise<void>((r) => server.close(() => r())) };
}
