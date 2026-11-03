import type { ShowResponse } from "../backend/ollama.ts";

const ELEM_BYTES = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 } as const;
export type KvType = keyof typeof ELEM_BYTES;

export interface ArchInfo {
  arch: string;
  layers: number;
  /** Sum of KV heads over layers that keep a full-length cache. */
  fullKvHeads: number;
  /** Sum of KV heads over sliding-window layers. */
  swaKvHeads: number;
  window: number;
  keyLen: number;
  valueLen: number;
  /** True when the per-layer numbers came from model metadata rather than defaults. */
  known: boolean;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Read the attention layout from GGUF metadata exposed by /api/show. */
export function parseArch(show: ShowResponse): ArchInfo {
  const mi = show.model_info ?? {};
  const arch = String(mi["general.architecture"] ?? "unknown");
  const g = (k: string) => mi[`${arch}.${k}`];
  const layers = num(g("block_count")) ?? 32;
  const heads = num(g("attention.head_count")) ?? (Array.isArray(g("attention.head_count")) ? 0 : 32);
  const embd = num(g("embedding_length")) ?? 4096;
  const keyLen = num(g("attention.key_length")) ?? (heads ? Math.round(embd / heads) : 128);
  const valueLen = num(g("attention.value_length")) ?? keyLen;
  const window = num(g("attention.sliding_window")) ?? 0;
  const kvRaw = g("attention.head_count_kv");
  const interval = num(g("full_attention_interval"));
  const swaPattern = g("attention.sliding_window_pattern");

  // Per-layer KV head counts; zeros mean the layer has no KV cache (SSM / linear attention).
  let perLayer: number[];
  if (Array.isArray(kvRaw)) perLayer = kvRaw.map((v) => num(v) ?? 0);
  else perLayer = Array.from({ length: layers }, () => num(kvRaw) ?? heads ?? 8);
  if (interval && interval > 1) {
    // Hybrid linear-attention models (e.g. Qwen3.5+): only every Nth layer is full attention.
    perLayer = perLayer.map((h, i) => ((i + 1) % interval === 0 ? h : 0));
  }

  let fullKvHeads = 0;
  let swaKvHeads = 0;
  perLayer.forEach((h, i) => {
    const isSwa =
      window > 0 && (Array.isArray(swaPattern) ? Boolean(swaPattern[i]) : typeof swaPattern === "number" ? (i + 1) % swaPattern !== 0 : false);
    if (isSwa) swaKvHeads += h;
    else fullKvHeads += h;
  });

  return {
    arch,
    layers,
    fullKvHeads,
    swaKvHeads,
    window,
    keyLen,
    valueLen,
    known: kvRaw !== undefined,
  };
}

/** Per-token KV guess when metadata lacks the attention layout (e.g. MLX safetensors builds).
 * Deliberately high (typical 8B GQA ≈ 144 KB/token); measured sizes replace it after load. */
export const UNKNOWN_KV_BYTES_PER_TOKEN = 128 * 1024;

/** Scale the unknown-layout guess with model size: KV width grows roughly with weights. */
export function unknownKvPerToken(weightsBytes: number): number {
  return Math.min(256 * 1024, Math.max(16 * 1024, (weightsBytes / (7 * 1024 ** 3)) * UNKNOWN_KV_BYTES_PER_TOKEN));
}

export function kvBytes(a: ArchInfo, ctx: number, kv: KvType, weightsBytes = 7 * 1024 ** 3): number {
  if (!a.known) return ctx * unknownKvPerToken(weightsBytes) * (ELEM_BYTES[kv] / 2);
  const perHeadToken = (a.keyLen + a.valueLen) * ELEM_BYTES[kv];
  return (a.fullKvHeads * ctx + a.swaKvHeads * Math.min(ctx, a.window || ctx)) * perHeadToken;
}

export interface Observation {
  ctx: number;
  parallel: number;
  bytes: number;
}

/**
 * Memory model for one base model. Starts from metadata, then corrects itself from
 * measured sizes: one observation fixes the constant overhead, two or more at different
 * context sizes fit the per-token slope directly.
 */
export class Footprint {
  readonly weightsBytes: number;
  readonly arch: ArchInfo;
  readonly kvType: KvType;
  overheadBytes: number;
  observations: Observation[] = [];
  private fitted?: { base: number; perToken: number };

  constructor(weightsBytes: number, arch: ArchInfo, kvType: KvType) {
    this.weightsBytes = weightsBytes;
    this.arch = arch;
    this.kvType = kvType;
    // Compute graph + recurrent state + runtime buffers; conservative until measured.
    this.overheadBytes = Math.max(512 * 2 ** 20, weightsBytes * 0.06);
  }

  estimate(ctx: number, parallel = 1): number {
    const tokens = ctx * parallel;
    if (this.fitted) return Math.max(this.weightsBytes, this.fitted.base + this.fitted.perToken * tokens);
    return this.weightsBytes + kvBytes(this.arch, tokens, this.kvType, this.weightsBytes) + this.overheadBytes;
  }

  observe(o: Observation): void {
    if (!(o.bytes > 0)) return;
    this.observations = [...this.observations.filter((x) => x.ctx * x.parallel !== o.ctx * o.parallel), o].slice(-8);
    const xs = this.observations.map((x) => x.ctx * x.parallel);
    const distinct = new Set(xs).size;
    if (distinct >= 2) {
      const n = xs.length;
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const ys = this.observations.map((x) => x.bytes);
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0;
      let den = 0;
      xs.forEach((x, i) => {
        num += (x - mx) * ((ys[i] ?? 0) - my);
        den += (x - mx) ** 2;
      });
      const perToken = Math.max(0, num / den);
      this.fitted = { base: my - perToken * mx, perToken };
    } else {
      const kv = kvBytes(this.arch, o.ctx * o.parallel, this.kvType, this.weightsBytes);
      this.overheadBytes = Math.max(0, o.bytes - this.weightsBytes - kv);
    }
  }

  toJSON() {
    return { weightsBytes: this.weightsBytes, overheadBytes: this.overheadBytes, observations: this.observations };
  }
}
