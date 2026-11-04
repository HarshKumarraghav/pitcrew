import { randomBytes } from "node:crypto";

/**
 * Tool-call repair. Small local models sometimes write a tool call as plain text (Qwen XML,
 * Hermes JSON) instead of a structured call; Ollama then passes it on as answer text and the agent
 * ends the session (seen as Qwen XML in bench run L, and as a ```json block in the e2e check).
 * When the request declared `tools`, this rewrites such text into proper OpenAI
 * `tool_calls`. Anything that does not parse cleanly is passed through unchanged. Never logs text.
 */

export interface TextToolCall {
  name: string;
  /** JSON-encoded arguments, as OpenAI sends them. */
  arguments: string;
}

type Schema = { type?: unknown; properties?: Record<string, Schema> };
type ToolMap = Map<string, Record<string, Schema>>;

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";
const FN = "<function=";

function toolMap(tools: unknown): ToolMap {
  const m: ToolMap = new Map();
  if (!Array.isArray(tools)) return m;
  for (const t of tools) {
    const fn = (t as { function?: { name?: unknown; parameters?: Schema } } | null)?.function;
    if (typeof fn?.name === "string" && fn.name) m.set(fn.name, fn.parameters?.properties ?? {});
  }
  return m;
}

/** Index where a text tool call starts (`<tool_call>` or `<function=`), or -1. */
function markerAt(s: string): number {
  const a = s.indexOf(OPEN);
  const b = s.indexOf(FN);
  return a < 0 ? b : b < 0 ? a : Math.min(a, b);
}

/** Length of the longest suffix of `s` that could be the start of a marker. */
function partialMarker(s: string): number {
  for (let n = Math.min(s.length, OPEN.length - 1); n > 0; n--) {
    const tail = s.slice(-n);
    if (OPEN.startsWith(tail) || FN.startsWith(tail)) return n;
  }
  return 0;
}

const FAIL = Symbol("fail");

/** A parameter value as the schema wants it: strings keep their text, other types are JSON. */
function coerce(raw: string, schema: Schema | undefined): unknown {
  const t = schema?.type;
  const types = Array.isArray(t) ? t : t ? [t] : [];
  if (!types.length || types.includes("string")) return raw.replace(/^\n/, "").replace(/\n$/, "");
  try {
    return JSON.parse(raw.trim());
  } catch {
    return FAIL;
  }
}

const NAME_KEYS = ["name", "tool_call", "tool", "function"];

/**
 * One JSON object naming a declared tool: `{"name": …, "arguments": {…}}` (Hermes), or the name
 * under another key with the arguments flat beside it, if every one is a parameter of that tool.
 */
function jsonCall(src: string, tools: ToolMap): TextToolCall | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(src);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const nameKey = NAME_KEYS.find((k) => typeof o[k] === "string" && tools.has(o[k] as string));
  if (!nameKey) return null;
  const name = o[nameKey] as string;
  const rest = Object.keys(o).filter((k) => k !== nameKey);
  const argKey = rest.length === 1 && (rest[0] === "arguments" || rest[0] === "parameters") ? rest[0] : undefined;
  if (!argKey) {
    const props = tools.get(name)!;
    if (!rest.length || rest.some((k) => !(k in props))) return null;
    return { name, arguments: JSON.stringify(Object.fromEntries(rest.map((k) => [k, o[k]]))) };
  }
  const args = o[argKey];
  if (typeof args === "string") {
    try {
      const a = JSON.parse(args);
      return a && typeof a === "object" && !Array.isArray(a) ? { name, arguments: args } : null;
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return { name, arguments: JSON.stringify(args) };
}

/** Qwen XML and Hermes JSON blocks, back to back, nothing else but whitespace. */
function taggedCalls(s: string, tools: ToolMap): TextToolCall[] | null {
  const calls: TextToolCall[] = [];
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  const eat = (tok: string) => (s.startsWith(tok, i) ? ((i += tok.length), true) : false);
  ws();
  while (i < s.length) {
    const opened = eat(OPEN);
    ws();
    if (opened && s[i] === "{") {
      const end = s.indexOf(CLOSE, i);
      const call = jsonCall(s.slice(i, end < 0 ? s.length : end).trim(), tools);
      if (!call) return null;
      calls.push(call);
      i = end < 0 ? s.length : end + CLOSE.length;
      ws();
      continue;
    }
    if (!eat(FN)) return null;
    const gt = s.indexOf(">", i);
    if (gt < 0) return null;
    const name = s.slice(i, gt).trim();
    const props = tools.get(name);
    if (!props) return null;
    i = gt + 1;
    ws();
    const args: Record<string, unknown> = {};
    while (eat("<parameter=")) {
      const pg = s.indexOf(">", i);
      if (pg < 0) return null;
      const key = s.slice(i, pg).trim();
      const end = s.indexOf("</parameter>", pg + 1);
      if (!key || end < 0) return null;
      const v = coerce(s.slice(pg + 1, end), props[key]);
      if (v === FAIL) return null;
      args[key] = v;
      i = end + "</parameter>".length;
      ws();
    }
    if (!eat("</function>")) return null;
    ws();
    eat(CLOSE);
    ws();
    calls.push({ name, arguments: JSON.stringify(args) });
  }
  return calls.length ? calls : null;
}

/**
 * Parses tool calls written as text. Returns the prose before the first call and the calls, or
 * null when the text is not cleanly a set of calls to declared tools.
 */
export function parseTextToolCalls(text: string, tools: unknown): { content: string; calls: TextToolCall[] } | null {
  const map = toolMap(tools);
  if (!map.size) return null;
  const trimmed = text.trim();
  // Bare JSON (optionally in one ```json fence) only counts when it is the whole message.
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/.exec(trimmed)?.[1]?.trim();
  const whole = fenced?.startsWith("{") ? fenced : trimmed.startsWith("{") ? trimmed : undefined;
  if (whole !== undefined) {
    const call = jsonCall(whole, map);
    return call ? { content: "", calls: [call] } : null;
  }
  const k = markerAt(text);
  if (k < 0) return null;
  const calls = taggedCalls(text.slice(k), map);
  return calls ? { content: text.slice(0, k), calls } : null;
}

type Obj = Record<string, unknown>;

/**
 * Rewrites one upstream response (OpenAI chat/completions, SSE or JSON). Before a tool-call start,
 * content streams live (only a possible partial marker is held back); from the start on, content is
 * buffered and parsed when the finish event arrives. A message that opens with `{` or a code fence
 * is held whole, since only a whole-message JSON call is accepted. Other events pass through byte-for-byte.
 */
export class ToolCallRepair {
  /** Tool calls produced from text so far. */
  repaired = 0;
  private tools: unknown;
  private enabled: boolean;
  private stream: boolean;
  private lineBuf: Buffer = Buffer.alloc(0);
  private chunks: Buffer[] = [];
  private held = false;
  private hold = "";
  private buf = "";
  private wroteText = false;
  private native = false;
  private skipBlank = false;
  private template?: Obj;
  private idBase = randomBytes(3).toString("hex");

  constructor(tools: unknown, stream: boolean) {
    this.tools = tools;
    this.enabled = toolMap(tools).size > 0;
    this.stream = stream;
  }

  push(chunk: Uint8Array): Buffer {
    if (!this.enabled) return Buffer.from(chunk);
    if (!this.stream) {
      this.chunks.push(Buffer.from(chunk));
      return Buffer.alloc(0);
    }
    this.lineBuf = this.lineBuf.length ? Buffer.concat([this.lineBuf, chunk]) : Buffer.from(chunk);
    const out: Buffer[] = [];
    let i: number;
    while ((i = this.lineBuf.indexOf(0x0a)) >= 0) {
      out.push(...this.line(this.lineBuf.subarray(0, i + 1)));
      this.lineBuf = this.lineBuf.subarray(i + 1);
    }
    return Buffer.concat(out);
  }

  finish(): Buffer {
    if (!this.enabled) return Buffer.alloc(0);
    if (!this.stream) return this.rewriteBody(Buffer.concat(this.chunks));
    const out: Buffer[] = [];
    if (this.lineBuf.length) out.push(...this.line(this.lineBuf));
    this.lineBuf = Buffer.alloc(0);
    out.push(...this.flush());
    return Buffer.concat(out);
  }

  private toolCalls(calls: TextToolCall[]): Obj[] {
    return calls.map((c, index) => ({ index, id: `call_pc_${this.idBase}_${this.repaired + index}`, type: "function", function: { name: c.name, arguments: c.arguments } }));
  }

  private rewriteBody(raw: Buffer): Buffer {
    try {
      const j = JSON.parse(raw.toString("utf8")) as Obj;
      const c = (j.choices as Obj[] | undefined)?.[0];
      const m = c?.message as Obj | undefined;
      if (!c || !m || typeof m.content !== "string" || (m.tool_calls as unknown[] | undefined)?.length) return raw;
      const p = parseTextToolCalls(m.content, this.tools);
      if (!p) return raw;
      m.content = p.content;
      m.tool_calls = this.toolCalls(p.calls);
      c.finish_reason = "tool_calls";
      this.repaired += p.calls.length;
      return Buffer.from(JSON.stringify(j));
    } catch {
      return raw;
    }
  }

  private sse(e: Obj, eol: string, blank = false): Buffer {
    const nl = eol || "\n";
    return Buffer.from(`data: ${JSON.stringify(e)}${nl}${blank ? nl : ""}`);
  }

  /** A synthetic content-only event modelled on the last upstream event. */
  private contentEvent(text: string, eol: string): Buffer {
    const c0 = ((this.template?.choices as Obj[] | undefined)?.[0] ?? {}) as Obj;
    const e: Obj = { ...this.template, choices: [{ index: c0.index ?? 0, delta: { content: text }, finish_reason: null }] };
    delete e.usage;
    return this.sse(e, eol, true);
  }

  /** Emits anything still held back as plain content. */
  private flush(eol = "\n"): Buffer[] {
    const text = this.hold + this.buf;
    this.hold = "";
    this.buf = "";
    this.held = false;
    return text && this.template ? [this.contentEvent(text, eol)] : [];
  }

  private line(raw: Buffer): Buffer[] {
    const text = raw.toString("utf8");
    const eol = text.endsWith("\r\n") ? "\r\n" : text.endsWith("\n") ? "\n" : "";
    const body = text.slice(0, text.length - eol.length);
    if (!body.trim()) {
      if (this.skipBlank) {
        this.skipBlank = false;
        return [];
      }
      return [raw];
    }
    this.skipBlank = false;
    if (!body.startsWith("data:")) return [raw];
    const data = body.slice(5).trim();
    if (data === "[DONE]") return [...this.flush(eol), raw];
    let e: Obj;
    try {
      e = JSON.parse(data) as Obj;
    } catch {
      return [raw];
    }
    const c = (e.choices as Obj[] | undefined)?.[0];
    if (!c || typeof c !== "object") return [raw];
    const d = (c.delta ?? {}) as Obj;
    if ((d.tool_calls as unknown[] | undefined)?.length) this.native = true;
    const content = typeof d.content === "string" ? d.content : "";
    const finish = typeof c.finish_reason === "string" ? c.finish_reason : undefined;
    if (!content && !finish) return [raw];
    this.template = e;

    let emit = "";
    if (!this.held) {
      const s = this.hold + content;
      this.hold = "";
      // At the start of the message, a JSON object or a code fence may be a whole-message call.
      const k = this.wroteText ? markerAt(s) : /^\s*(\{|```)/.test(s) ? s.search(/\S/) : markerAt(s);
      if (k >= 0) {
        emit = s.slice(0, k);
        this.buf = s.slice(k);
        this.held = true;
      } else {
        const h = finish ? 0 : !this.wroteText && /^\s*`{1,2}$/.test(s) ? s.length : partialMarker(s);
        emit = s.slice(0, s.length - h);
        this.hold = s.slice(s.length - h);
      }
      if (emit.trim()) this.wroteText = true;
    } else this.buf += content;

    if (finish && this.held) return this.finalize(e, c, d, emit, raw, eol);
    if (emit === content) return [raw];
    if (!emit && Object.keys(d).every((k) => k === "content") && !finish) {
      // Nothing left to say in this event: drop it and the blank line that ends it.
      this.skipBlank = true;
      return [];
    }
    c.delta = { ...d, content: emit };
    return [this.sse(e, eol)];
  }

  private finalize(e: Obj, c: Obj, d: Obj, emit: string, raw: Buffer, eol: string): Buffer[] {
    const text = this.buf;
    this.buf = "";
    this.held = false;
    const p = this.native ? null : parseTextToolCalls(text, this.tools);
    const out: Buffer[] = [];
    if (p) {
      if (emit + p.content) out.push(this.contentEvent(emit + p.content, eol));
      const delta: Obj = { ...d, tool_calls: this.toolCalls(p.calls) };
      delete delta.content;
      c.delta = delta;
      c.finish_reason = "tool_calls";
      this.repaired += p.calls.length;
      out.push(this.sse(e, eol));
      return out;
    }
    out.push(this.contentEvent(emit + text, eol));
    if (typeof d.content === "string" && d.content) {
      const delta = { ...d };
      delete delta.content;
      c.delta = delta;
      out.push(this.sse(e, eol));
    } else out.push(raw);
    return out;
  }
}
