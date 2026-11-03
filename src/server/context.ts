/** Estimate prompt size from an OpenAI/Ollama request body without a tokenizer. */
export function promptChars(body: Record<string, unknown>): number {
  let n = 0;
  const add = (v: unknown) => {
    if (v === undefined || v === null) return;
    n += typeof v === "string" ? v.length : JSON.stringify(v).length;
  };
  add(body.messages);
  add(body.prompt);
  add(body.input);
  add(body.system);
  add(body.instructions);
  add(body.tools);
  return n;
}

export function requestedOutput(body: Record<string, unknown>, fallback: number): number {
  const opts = (body.options ?? {}) as Record<string, unknown>;
  const v = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? opts.num_predict;
  return typeof v === "number" && v > 0 ? v : fallback;
}

export type CtxChoice = { ok: true; ctx: number; needTokens: number } | { ok: false; needTokens: number; maxCtx: number };

/**
 * Smallest bucket that holds prompt + output with 10% headroom, clamped to the model's range.
 * Returns an error instead of silently truncating when nothing is large enough.
 */
export function chooseContext(opts: {
  promptTokens: number;
  outputTokens: number;
  buckets: number[];
  minCtx?: number;
  maxCtx?: number;
}): CtxChoice {
  const need = Math.ceil((opts.promptTokens + opts.outputTokens) * 1.1);
  const maxCtx = opts.maxCtx ?? opts.buckets[opts.buckets.length - 1] ?? 32768;
  const minCtx = opts.minCtx ?? 0;
  const bucket = opts.buckets.find((b) => b >= need && b >= minCtx && b <= maxCtx);
  if (bucket !== undefined) return { ok: true, ctx: bucket, needTokens: need };
  if (need <= maxCtx) return { ok: true, ctx: maxCtx, needTokens: need };
  return { ok: false, needTokens: need, maxCtx };
}

/** Learns characters-per-token per model from reported usage. */
export class TokenCalibrator {
  private cpt = new Map<string, number>();
  private initial: number;

  constructor(initial: number) {
    this.initial = initial;
  }

  get(model: string): number {
    return this.cpt.get(model) ?? this.initial;
  }

  tokens(model: string, chars: number): number {
    return Math.ceil(chars / this.get(model));
  }

  observe(model: string, chars: number, promptTokens: number): void {
    if (!(promptTokens > 50) || !(chars > 0)) return;
    const sample = chars / promptTokens;
    const prev = this.cpt.get(model);
    // Bias low (more tokens) so estimates err towards a bigger window.
    this.cpt.set(model, prev === undefined ? sample * 0.95 : prev * 0.7 + sample * 0.95 * 0.3);
  }
}
