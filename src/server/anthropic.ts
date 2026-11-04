/**
 * Anthropic Messages API front-end (Claude Code → Pit Crew → Ollama's own /v1/messages). The body
 * is forwarded as sent, apart from the model name and router patches; this module only derives an
 * OpenAI-shaped *view* of it, so the router, step classes and telemetry work unchanged.
 */

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type AMsg = { role?: string; content?: string | Block[] };

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b: Block) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("") : "";

/** Claude Code's built-in model names; a local-only gateway serves them with the router. */
export const isClaudeModel = (name: string) => /^claude[-_]/i.test(name);

/**
 * OpenAI chat shape of a Messages request: system → system message, tool_use → tool_calls,
 * tool_result → tool messages, tools → function schemas. For classification only.
 */
export function openAIView(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown>[] = [];
  const sys = textOf(body.system);
  if (sys) out.push({ role: "system", content: sys });
  for (const m of (body.messages as AMsg[] | undefined) ?? []) {
    const blocks: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    if (m.role === "assistant") {
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: textOf(blocks), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn carries tool results first (one tool message each), then any text. A command that
    // ran and exited non-zero ("Exit code 1", e.g. failing tests) is output, not a tool error.
    for (const b of blocks.filter((x) => x.type === "tool_result")) {
      const t = textOf(b.content);
      out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error && !/^(error|exit code \d)/i.test(t) ? `Error: ${t}` : t });
    }
    const text = textOf(blocks);
    if (text || !blocks.some((x) => x.type === "tool_result")) out.push({ role: m.role ?? "user", content: text });
  }
  const tools = ((body.tools as { name?: string; input_schema?: unknown }[] | undefined) ?? [])
    .filter((t) => t?.name)
    .map((t) => ({ type: "function", function: { name: t.name, parameters: t.input_schema ?? {} } }));
  return { model: body.model, messages: out, ...(tools.length ? { tools } : {}), max_tokens: body.max_tokens, stream: body.stream };
}

/** The router's OpenAI-style patch for a Messages body (thinking off = `thinking: disabled`). */
export function messagesPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof patch.max_tokens === "number") out.max_tokens = patch.max_tokens;
  if (patch.reasoning_effort === "none") out.thinking = { type: "disabled" };
  return out;
}

/** Anthropic error envelope; Claude Code reads `error.type` and `error.message`. */
export function messagesError(status: number, message: string): Record<string, unknown> {
  const type =
    status === 400 || status === 413 ? "invalid_request_error"
    : status === 401 ? "authentication_error"
    : status === 403 ? "permission_error"
    : status === 404 ? "not_found_error"
    : status === 429 ? "rate_limit_error"
    : status === 503 || status === 507 ? "overloaded_error"
    : "api_error";
  return { type: "error", error: { type, message } };
}
