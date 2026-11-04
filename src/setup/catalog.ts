import type { PressureLevel } from "../system/memory.ts";

const G = 1e9;

export interface CatalogModel {
  name: string;
  /** Download / on-disk size in bytes. */
  bytes: number;
  /** Resident size after load at 32k context, when measured. */
  residentBytes?: number;
  /** "measured" on the reference machine (M5, Ollama 0.40 MLX tags) or an "estimate". */
  basis: "measured" | "estimate";
  note: string;
}

/**
 * Models `pitcrew init` may recommend, smallest first. Only tags this project has run; sizes are
 * the Apple Silicon (Ollama MLX) tags measured on the reference machine unless marked estimate.
 * Bigger models from docs/MODELS.md are mentioned as a note, never picked automatically.
 */
export const CATALOG: CatalogModel[] = [
  { name: "qwen3.5:0.8b", bytes: 1.2 * G, residentBytes: 1.1 * G, basis: "measured", note: "titles and short helpers; 0.2 s per title with thinking off" },
  { name: "qwen3.5:2b", bytes: 3.1 * G, basis: "measured", note: "light model on big machines, or a small coder" },
  { name: "qwen3.5:4b", bytes: 4.5 * G, basis: "estimate", note: "coder for 16 GB machines (not benchmarked here)" },
  { name: "qwen3.5:9b", bytes: 7.6 * G, residentBytes: 7.6 * G, basis: "measured", note: "default coder; 5/6 routine tasks direct, 6/6 through Pit Crew (mode B)" },
];

/**
 * Big models for hard tasks only, run in exclusive mode (`models.<alias>.exclusive`), largest first.
 * Never picked by `init`; sizes are the vendor file sizes (estimate). Low-bit 27B builds can lose
 * tool-calling reliability: smoke-test before relying on one.
 */
export const BIG_MODELS: CatalogModel[] = [
  { name: "hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL", bytes: 17.56 * G, basis: "estimate", note: "27B at ~4-bit; 32 GB+ machines" },
  { name: "hf.co/unsloth/Qwen3.8-27B-GGUF:UD-IQ3_XXS", bytes: 10.93 * G, basis: "estimate", note: "27B at ~3-bit; fits a 24 GB Mac only with everything else unloaded" },
];

/** The largest big model whose 32k resident estimate fits the hard model budget on its own, if any. */
export function bigModelFor(m: { totalBytes: number; gpuLimitBytes?: number }): CatalogModel | undefined {
  const budget = m.gpuLimitBytes ? m.gpuLimitBytes * 0.9 : m.totalBytes * 0.75;
  return BIG_MODELS.find((b) => residentEstimate({ name: b.name, bytes: b.bytes, basis: "estimate", pulled: false }, 32768) <= budget);
}

export const BIGGER_MODELS_NOTE =
  "32 GB+: docs/MODELS.md lists stronger coders (e.g. Qwen3.8-27B, ~18 GB, vendor size, not benchmarked here). Pull one and pass --coder <tag> to use it.";

export interface MachineView {
  totalBytes: number;
  availableBytes: number;
  inactiveBytes: number;
  gpuLimitBytes?: number;
  pressure: PressureLevel;
}

export interface Pick {
  name: string;
  /** Size used for the fit check. */
  bytes: number;
  basis: "measured" | "estimate" | "pulled" | "unknown";
  pulled: boolean;
}

export interface Recommendation {
  tier: string;
  coder: Pick;
  light: Pick;
  minCtx: number;
  maxCtx: number;
  lightMaxCtx: number;
  /** Resident-size cap for the coder (idle recycle above it). */
  coderMaxResidentGiB: number;
  /** Most memory Pit Crew will give models (90% of the GPU limit, or 75% of RAM). */
  hardBudgetBytes: number;
  /** What a new model can take right now without pushing apps into compression/swap. */
  headroomNowBytes: number;
  /** Coder at maxCtx + light model, estimated. */
  needBytes: number;
  fitsNow: boolean;
  warnings: string[];
  notes: string[];
}

const GiB = 1024 ** 3;

/** Resident estimate: measured size if known, otherwise weights + runtime overhead + a little KV per 32k. */
export function residentEstimate(p: Pick, ctx: number): number {
  const m = CATALOG.find((c) => c.name === p.name);
  if (m?.residentBytes) return m.residentBytes * (ctx > 32768 ? 1.1 : 1);
  return p.bytes * 1.05 + (ctx / 32768) * 0.5 * GiB;
}

function tierFor(total: number): { tier: string; coder: string; light: string; maxCtx: number; lightMaxCtx: number } {
  const gib = total / GiB;
  if (gib < 12) return { tier: "8 GB", coder: "qwen3.5:2b", light: "qwen3.5:0.8b", maxCtx: 16384, lightMaxCtx: 8192 };
  if (gib < 20) return { tier: "16 GB", coder: "qwen3.5:4b", light: "qwen3.5:0.8b", maxCtx: 16384, lightMaxCtx: 8192 };
  if (gib < 30) return { tier: "24 GB", coder: "qwen3.5:9b", light: "qwen3.5:0.8b", maxCtx: 32768, lightMaxCtx: 16384 };
  if (gib < 44) return { tier: "32 GB", coder: "qwen3.5:9b", light: "qwen3.5:0.8b", maxCtx: 65536, lightMaxCtx: 16384 };
  return { tier: "48 GB+", coder: "qwen3.5:9b", light: "qwen3.5:2b", maxCtx: 65536, lightMaxCtx: 16384 };
}

function pick(name: string, pulled: Map<string, number>): Pick {
  const size = pulled.get(name);
  const c = CATALOG.find((m) => m.name === name);
  if (size !== undefined) return { name, bytes: size, basis: "pulled", pulled: true };
  if (c) return { name, bytes: c.bytes, basis: c.basis, pulled: false };
  return { name, bytes: 0, basis: "unknown", pulled: false };
}

/**
 * Pick a coder + light model for this machine. Deterministic: total RAM sets the tier, the hard
 * budget can step the coder down, and current free memory only produces a warning (Pit Crew lets
 * the primary model load into compressible memory as long as the hard budget holds).
 */
export function recommend(
  m: MachineView,
  pulledModels: { name: string; size: number }[],
  opts: { coder?: string; light?: string; minFreeGiB?: number } = {},
): Recommendation {
  const pulled = new Map(pulledModels.map((p) => [p.name, p.size]));
  const t = tierFor(m.totalBytes);
  const hardBudgetBytes = m.gpuLimitBytes ? m.gpuLimitBytes * 0.9 : m.totalBytes * 0.75;
  const headroomNowBytes = m.availableBytes + m.inactiveBytes * 0.5 - (opts.minFreeGiB ?? 1) * GiB;
  const warnings: string[] = [];
  const notes: string[] = [];

  const light = pick(opts.light ?? t.light, pulled);
  let coder = pick(opts.coder ?? t.coder, pulled);
  const need = (c: Pick) => residentEstimate(c, t.maxCtx) + residentEstimate(light, t.lightMaxCtx);

  if (!opts.coder) {
    // Step down until coder + light fit the hard budget.
    const ladder = CATALOG.filter((c) => c.name !== light.name && c.bytes <= coder.bytes).reverse();
    for (const c of ladder) {
      coder = pick(c.name, pulled);
      if (need(coder) <= hardBudgetBytes) break;
    }
    if (coder.name !== t.coder) warnings.push(`${t.coder} would not fit Pit Crew's memory budget here; using ${coder.name}`);
    // Mention bigger catalog models the user already has and that also fit.
    for (const c of CATALOG) {
      const p = pulled.get(c.name);
      if (p !== undefined && c.bytes > coder.bytes && c.name !== light.name && need(pick(c.name, pulled)) <= hardBudgetBytes) {
        notes.push(`${c.name} is already pulled and fits the budget; use --coder ${c.name} to prefer it`);
      }
    }
  }
  if (coder.basis === "unknown") warnings.push(`${coder.name}: size unknown until it is pulled; the fit check below assumes 0`);
  if (light.basis === "unknown") warnings.push(`${light.name}: size unknown until it is pulled`);

  const needBytes = need(coder);
  if (needBytes > hardBudgetBytes) warnings.push(`${coder.name} + ${light.name} need ≈ ${(needBytes / G).toFixed(1)} GB, more than Pit Crew's model budget (${(hardBudgetBytes / G).toFixed(1)} GB); requests will be refused`);
  const fitsNow = needBytes <= headroomNowBytes;
  if (!fitsNow && needBytes <= hardBudgetBytes) {
    warnings.push(
      `only ≈ ${(Math.max(0, headroomNowBytes) / G).toFixed(1)} GB is free right now; loading the coder will push open apps into compression/swap. Closing a browser or Docker helps.`,
    );
  }
  if (m.pressure !== "normal") warnings.push(`kernel memory pressure is "${m.pressure}" before any model is loaded`);
  if (t.tier === "8 GB") warnings.push("8 GB machines can run a 2B coder; expect simple tasks only");
  if (m.totalBytes / GiB >= 30) notes.push(BIGGER_MODELS_NOTE);

  const coderGiB = residentEstimate(coder, 32768) / GiB;
  const coderMaxResidentGiB = Math.round(Math.min(coderGiB + 2.5, hardBudgetBytes / GiB - residentEstimate(light, t.lightMaxCtx) / GiB) * 2) / 2;

  return {
    tier: t.tier,
    coder,
    light,
    minCtx: 16384,
    maxCtx: t.maxCtx,
    lightMaxCtx: t.lightMaxCtx,
    coderMaxResidentGiB,
    hardBudgetBytes,
    headroomNowBytes,
    needBytes,
    fitsNow,
    warnings,
    notes,
  };
}
