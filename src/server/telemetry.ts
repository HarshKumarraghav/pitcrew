import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

/**
 * Per-request timing, read from the response stream as it passes through. The bytes sent to the
 * client are never changed. Records hold sizes and timings only — never prompt or answer text.
 */

export type RequestKind = "agent" | "helper" | "compaction";

/** What the tap learned from one response. */
export interface TapResult {
  firstByteMs?: number;
  firstReasoningMs?: number;
  /** First answer text or tool call. */
  firstContentMs?: number;
  endMs?: number;
  reasoningChars: number;
  contentChars: number;
  toolArgChars: number;
  toolCalls: string[];
  finish?: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  /** Ollama-native streams report these directly (ns → ms). */
  nativePrefillMs?: number;
  nativeDecodeMs?: number;
}

/**
 * Line-buffered parser for OpenAI SSE (`data: {...}`), Ollama NDJSON and plain JSON bodies.
 * Times are relative to `t0` (ms, from `now()`).
 */
export class StreamTap {
  private buf = "";
  private whole = "";
  private sse = false;
  private wholeCap = 4 * 1024 * 1024;
  readonly r: TapResult = { reasoningChars: 0, contentChars: 0, toolArgChars: 0, toolCalls: [] };
  private t0: number;
  private now: () => number;
  private toolSeen = new Set<string>();
  private parsedAny = false;

  constructor(t0: number, now: () => number = Date.now) {
    this.t0 = t0;
    this.now = now;
  }

  private at(): number {
    return this.now() - this.t0;
  }

  push(chunk: Uint8Array | string): void {
    this.r.firstByteMs ??= this.at();
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (this.whole.length < this.wholeCap) this.whole += s;
    this.buf += s;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      this.line(line);
    }
  }

  finish(): TapResult {
    if (this.buf.trim()) this.line(this.buf.trim());
    this.buf = "";
    // A non-streaming JSON body arrives as one object, possibly split over chunks.
    if (!this.sse && !this.parsedAny && this.whole.trim().startsWith("{")) {
      try {
        this.event(JSON.parse(this.whole));
      } catch {
        // not JSON (or several NDJSON lines already handled)
      }
    }
    this.r.endMs = this.at();
    return this.r;
  }

  private line(line: string): void {
    if (!line) return;
    let json = line;
    if (line.startsWith("data:")) {
      this.sse = true;
      json = line.slice(5).trim();
      if (json === "[DONE]") return;
    } else if (!line.startsWith("{")) return;
    try {
      this.event(JSON.parse(json));
      this.parsedAny = true;
    } catch {
      // partial or non-JSON line (e.g. a pretty-printed body); handled by finish()
    }
  }

  private event(e: Record<string, unknown>): void {
    const at = this.at();
    const usage = e.usage as Record<string, unknown> | undefined;
    if (usage) {
      if (typeof usage.prompt_tokens === "number") this.r.promptTokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number") this.r.completionTokens = usage.completion_tokens;
      const det = usage.completion_tokens_details as Record<string, unknown> | undefined;
      if (typeof det?.reasoning_tokens === "number") this.r.reasoningTokens = det.reasoning_tokens;
    }
    // Ollama native: {message:{content,thinking,tool_calls}, done, prompt_eval_count, ...}
    if (typeof e.prompt_eval_count === "number") this.r.promptTokens = e.prompt_eval_count;
    if (typeof e.eval_count === "number") this.r.completionTokens = e.eval_count;
    if (typeof e.prompt_eval_duration === "number") this.r.nativePrefillMs = e.prompt_eval_duration / 1e6;
    if (typeof e.eval_duration === "number") this.r.nativeDecodeMs = e.eval_duration / 1e6;
    if (typeof e.done_reason === "string") this.r.finish = e.done_reason;
    const msg = e.message as Record<string, unknown> | undefined;
    if (msg) this.delta(msg, at);
    if (typeof e.response === "string" && e.response) this.text("content", e.response, at);
    if (typeof e.thinking === "string" && e.thinking) this.text("reasoning", e.thinking, at);
    for (const c of (e.choices as Record<string, unknown>[] | undefined) ?? []) {
      // Streams carry `delta`; a non-streaming body carries `message` instead.
      const d = (c.delta ?? c.message) as Record<string, unknown> | undefined;
      if (d) this.delta(d, at);
      if (typeof c.finish_reason === "string") this.r.finish = c.finish_reason;
    }
  }

  private delta(d: Record<string, unknown>, at: number): void {
    // Ollama /v1 streams thinking as `reasoning`; other servers use `reasoning_content`; native uses `thinking`.
    for (const k of ["reasoning", "reasoning_content", "thinking"]) {
      const v = d[k];
      if (typeof v === "string" && v) this.text("reasoning", v, at);
    }
    if (typeof d.content === "string" && d.content) this.text("content", d.content, at);
    for (const tc of (d.tool_calls as Record<string, unknown>[] | undefined) ?? []) {
      this.r.firstContentMs ??= at;
      const fn = tc.function as Record<string, unknown> | undefined;
      const id = String(tc.id ?? tc.index ?? this.r.toolCalls.length);
      if (typeof fn?.name === "string" && fn.name && !this.toolSeen.has(id)) {
        this.toolSeen.add(id);
        this.r.toolCalls.push(fn.name);
      }
      const a = fn?.arguments;
      if (typeof a === "string") this.r.toolArgChars += a.length;
      else if (a && typeof a === "object") this.r.toolArgChars += JSON.stringify(a).length;
    }
  }

  private text(kind: "reasoning" | "content", s: string, at: number): void {
    if (kind === "reasoning") {
      this.r.firstReasoningMs ??= at;
      this.r.reasoningChars += s.length;
    } else {
      this.r.firstContentMs ??= at;
      this.r.contentChars += s.length;
    }
  }
}

const COMPACTION = /summar(y|ize|ise|izing|ising)|continu(e|ing) (the|our) conversation|work state/i;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}

/** agent (tools), compaction (no tools + long, or a summary instruction), helper (short, no tools). */
export function requestKind(body: Record<string, unknown>, promptChars: number, helperMaxChars: number): RequestKind {
  const tools = body.tools;
  if (Array.isArray(tools) && tools.length > 0) return "agent";
  const msgs = (body.messages as { role?: string; content?: unknown }[] | undefined) ?? [];
  const sys = msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  if (promptChars > helperMaxChars) return "compaction";
  if (msgs.length > 2 && (COMPACTION.test(sys.slice(0, 2000)) || COMPACTION.test(textOf(lastUser?.content).slice(0, 2000)))) return "compaction";
  return "helper";
}

/** Stable per-conversation key: hash of the system prompt + first user message (never stored in clear). */
export function sessionKey(body: Record<string, unknown>): string | undefined {
  const msgs = (body.messages as { role?: string; content?: unknown }[] | undefined) ?? [];
  if (!msgs.length) return undefined;
  const sys = msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const firstUser = msgs.find((m) => m.role === "user");
  return createHash("sha1").update(sys).update("\u0000").update(textOf(firstUser?.content)).digest("hex").slice(0, 12);
}

/** Shape of the conversation tail, used for step classes (no text). */
export function tailShape(body: Record<string, unknown>): { messages: number; lastRole?: string; lastTool?: string; lastToolError?: boolean } {
  const msgs = (body.messages as { role?: string; content?: unknown; name?: string; tool_call_id?: string }[] | undefined) ?? [];
  const last = msgs[msgs.length - 1];
  let lastTool: string | undefined;
  if (last?.role === "tool") {
    // The tool's name lives on the preceding assistant message's tool_calls.
    for (let i = msgs.length - 2; i >= 0; i--) {
      const m = msgs[i] as { role?: string; tool_calls?: { id?: string; function?: { name?: string } }[] };
      if (m.role !== "assistant") continue;
      lastTool = m.tool_calls?.find((t) => t.id === last.tool_call_id)?.function?.name ?? m.tool_calls?.[0]?.function?.name;
      break;
    }
  }
  const lastToolError = last?.role === "tool" ? /^(error|Error:)|\b(failed|not found|ENOENT|Could not find)\b/.test(textOf(last.content).slice(0, 400)) : undefined;
  return { messages: msgs.length, lastRole: last?.role, lastTool, lastToolError };
}

export interface RequestRecord {
  t: string;
  tMs: number;
  path: string;
  requested: string;
  alias?: string;
  base: string;
  variant: string;
  kind: RequestKind;
  step?: string;
  session?: string;
  priority: string;
  ctx: number;
  promptChars: number;
  tail: ReturnType<typeof tailShape>;
  stream: boolean;
  status: number | "aborted" | "error";
  /** ms from request received. */
  leaseMs: number;
  queuedMs: number;
  firstByteMs?: number;
  firstReasoningMs?: number;
  firstContentMs?: number;
  endMs?: number;
  /** Since this session's previous request ended: tool execution + client overhead. */
  gapMs?: number;
  prefillMs?: number;
  decodeMs?: number;
  reasoningDecodeMs?: number;
  contentDecodeMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  /** Estimate: Ollama's /v1 API has no cache counters, so prefill time × measured cold rate. */
  estUncachedPromptTokens?: number;
  reasoningChars: number;
  contentChars: number;
  toolCalls: string[];
  finish?: string;
}

/** Turn tap timings into the derived numbers (all ms relative to request receipt). */
export function derive(tap: TapResult, leaseMs: number, coldTokPerS: number): Partial<RequestRecord> {
  const out: Partial<RequestRecord> = {};
  if (tap.firstByteMs !== undefined) {
    out.prefillMs = tap.nativePrefillMs ?? Math.max(0, tap.firstByteMs - leaseMs);
    if (tap.endMs !== undefined) out.decodeMs = tap.nativeDecodeMs ?? Math.max(0, tap.endMs - tap.firstByteMs);
  }
  if (tap.endMs !== undefined) {
    const startR = tap.firstReasoningMs;
    const startC = tap.firstContentMs;
    if (startR !== undefined) out.reasoningDecodeMs = Math.max(0, (startC !== undefined && startC > startR ? startC : tap.endMs) - startR);
    if (startC !== undefined) out.contentDecodeMs = Math.max(0, tap.endMs - Math.max(startC, startR ?? 0));
  }
  if (out.prefillMs !== undefined) {
    const est = Math.round((out.prefillMs / 1000) * coldTokPerS);
    out.estUncachedPromptTokens = tap.promptTokens !== undefined ? Math.min(tap.promptTokens, est) : est;
  }
  if (tap.reasoningTokens === undefined && tap.completionTokens !== undefined) {
    const all = tap.reasoningChars + tap.contentChars + tap.toolArgChars;
    if (all > 0) out.reasoningTokens = Math.round((tap.completionTokens * tap.reasoningChars) / all);
  }
  return out;
}

/** Appends records as JSONL; rotates at `maxBytes`. Failures never affect requests. */
export class RequestLog {
  private path: string;
  private maxBytes: number;
  private chain: Promise<void> = Promise.resolve();
  private lastEnd = new Map<string, number>();

  constructor(path: string, maxBytes = 50 * 1024 * 1024) {
    this.path = path;
    this.maxBytes = maxBytes;
  }

  /** Time since the same session's previous request finished (ms), then remembers this one. */
  gap(session: string | undefined, receivedAt: number, endAt: number): number | undefined {
    if (!session) return undefined;
    const prev = this.lastEnd.get(session);
    this.lastEnd.set(session, endAt);
    if (this.lastEnd.size > 500) this.lastEnd.delete(this.lastEnd.keys().next().value!);
    return prev === undefined ? undefined : Math.max(0, receivedAt - prev);
  }

  write(rec: RequestRecord): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const st = await stat(this.path).catch(() => undefined);
        if (st && st.size > this.maxBytes) await rename(this.path, `${this.path}.1`);
        await appendFile(this.path, JSON.stringify(rec) + "\n");
      })
      .catch(() => undefined);
    return this.chain;
  }
}
