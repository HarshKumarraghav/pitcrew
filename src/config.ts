import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { JobSpec } from "./backend/jobs.ts";

export type Priority = "interactive" | "background";

/** How much of the machine's memory the governor is willing to hand to models. */
export type MemoryPolicy =
  /** Only load into memory that is free or holds reclaimable file cache right now. */
  | "strict"
  /** Also count part of inactive app memory, which macOS can compress cheaply. */
  | "balanced"
  /** Only enforce the static cap; rely on the thrash detector to back off. */
  | "aggressive";

export interface ModelAlias {
  kind?: "llm";
  /** Backend model name, e.g. "qwen3.5:9b". */
  model: string;
  /** Smallest context window to load with. Requests never get less than this. */
  minCtx?: number;
  /** Largest context window the governor may choose for this model. */
  maxCtx?: number;
  priority?: Priority;
  /** Keep loaded even when idle (still evicted if the thrash detector goes critical). */
  pin?: boolean;
  /**
   * The model you chose to work with. It may load whenever it fits the hard model budget and
   * memory is not thrashing, even if that means macOS compresses idle apps. Other models stay
   * under the normal memory policy, so nothing piles on top of it.
   */
  primary?: boolean;
  /**
   * Load at gateway start and keep resident (implies pin). Meant for small helpers (titles,
   * summaries) so their requests never wait for a load.
   */
  warm?: boolean;
  /**
   * Requests this model may serve at once. Defaults to 2 for small models (≤ 3.5 GB weights) and
   * 1 for the primary/large ones; never more than the backend allows (backend.parallel).
   */
  parallel?: number;
  /** Optional sampling defaults baked into the derived model. */
  parameters?: Record<string, number | string>;
}

export interface RouterConfig {
  /** Name clients use for routed requests, e.g. "auto". */
  name: string;
  /** A = single model · B = sequential light+strong · C = resource-aware hybrid. */
  mode: "A" | "B" | "C";
  coder: string;
  light?: string;
  /** Tool-less requests up to this many prompt characters count as helper work. */
  helperMaxPromptChars: number;
  /** Output cap applied to helper requests (stops runaway thinking on a one-line job). */
  helperMaxTokens: number;
  /** Send reasoning_effort "none" on helper requests (Ollama ≥ 0.12 honours it on /v1). */
  helperNoThinking: boolean;
}

export interface Config {
  listen: { host: string; port: number };
  backend: {
    url: string;
    /** Spawn and own a dedicated `ollama serve` instead of attaching to an existing one. */
    managed: boolean;
    /** Extra env for the managed server (e.g. OLLAMA_KV_CACHE_TYPE). */
    env: Record<string, string>;
    /**
     * Request slots the backend gives each loaded model (OLLAMA_NUM_PARALLEL). A managed server is
     * started with this value ("auto" → 1). For an external server, "auto" probes it at start-up.
     */
    parallel: number | "auto";
    /** KV cache element type used for footprint estimates. */
    kvCacheType: "f16" | "q8_0" | "q4_0";
  };
  memory: {
    policy: MemoryPolicy;
    /** Memory always left for macOS and your apps, in GiB. */
    osReserveGiB: number;
    /** Never let estimated free memory drop below this after a load, in GiB. */
    minFreeGiB: number;
    /** Hard cap on total model memory. Defaults to 90% of the GPU working set. */
    maxModelMemoryGiB?: number;
    /** Swap-out rate (MiB/s, smoothed) that counts as thrashing. */
    thrashSwapoutMiBps: number;
    pollMs: number;
  };
  scheduler: {
    /** Max generations running at once across all models. */
    maxConcurrent: number;
    /** How long a request may wait in the queue before a 503. */
    queueTimeoutMs: number;
    /** Unload models idle for this long (unless pinned). 0 disables. */
    idleUnloadMs: number;
    /** Background requests are only dispatched when no interactive request is waiting. */
    strictPriority: boolean;
    /** Requests for an already-loaded model skip the global concurrency cap (per-model slots still apply). */
    fastLane: boolean;
    /** A background request may evict a model only after it has been idle this long. */
    backgroundEvictIdleMs: number;
  };
  context: {
    buckets: number[];
    /** Output budget assumed when a request does not set max_tokens. */
    defaultMaxOutput: number;
    /** Initial characters-per-token guess before calibration. */
    charsPerToken: number;
  };
  models: Record<string, ModelAlias | JobSpec>;
  /** Virtual model that routes each request to an alias (modes A/B/C). */
  router: RouterConfig;
  /** Allow model names that are not declared as aliases (still local-only). */
  allowUndeclared: boolean;
  stateDir: string;
}

export const DEFAULTS: Config = {
  listen: { host: "127.0.0.1", port: 11500 },
  backend: {
    url: "http://127.0.0.1:11434",
    managed: false,
    env: {},
    parallel: "auto",
    kvCacheType: "f16",
  },
  memory: {
    policy: "balanced",
    osReserveGiB: 4,
    minFreeGiB: 1,
    thrashSwapoutMiBps: 40,
    pollMs: 1000,
  },
  scheduler: {
    maxConcurrent: 2,
    queueTimeoutMs: 10 * 60_000,
    idleUnloadMs: 15 * 60_000,
    strictPriority: true,
    fastLane: true,
    backgroundEvictIdleMs: 3000,
  },
  context: {
    buckets: [8192, 16384, 32768, 65536, 131072],
    defaultMaxOutput: 4096,
    charsPerToken: 3.2,
  },
  models: {},
  router: { name: "auto", mode: "C", coder: "coder", light: "small", helperMaxPromptChars: 8000, helperMaxTokens: 512, helperNoThinking: true },
  allowUndeclared: true,
  stateDir: join(homedir(), ".pitcrew"),
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)
        ? merge(b, v as DeepPartial<typeof b>)
        : v;
  }
  return out as T;
}

export function configPaths(explicit?: string): string[] {
  if (explicit) return [resolve(explicit)];
  return [resolve("pitcrew.config.json"), join(homedir(), ".pitcrew", "config.json")];
}

export function loadConfig(explicit?: string, overrides?: DeepPartial<Config>): { config: Config; path?: string } {
  let fileCfg: DeepPartial<Config> | undefined;
  let path: string | undefined;
  for (const p of configPaths(explicit)) {
    if (existsSync(p)) {
      fileCfg = JSON.parse(readFileSync(p, "utf8")) as DeepPartial<Config>;
      path = p;
      break;
    }
  }
  if (explicit && !path) throw new Error(`config not found: ${explicit}`);
  let config = merge(merge(DEFAULTS, fileCfg), overrides);
  const env = process.env;
  if (env.PITCREW_PORT) config = merge(config, { listen: { port: Number(env.PITCREW_PORT) } });
  if (env.PITCREW_BACKEND) config = merge(config, { backend: { url: env.PITCREW_BACKEND } });
  if (env.PITCREW_MODE) config = merge(config, { router: { mode: env.PITCREW_MODE as Config["router"]["mode"] } });
  validate(config);
  return { config, path };
}

export function validate(c: Config): void {
  if (c.listen.host !== "127.0.0.1" && c.listen.host !== "localhost" && c.listen.host !== "::1") {
    console.warn(`[pitcrew] warning: listening on ${c.listen.host} exposes your models to the network`);
  }
  if (!c.context.buckets.length) throw new Error("context.buckets must not be empty");
  c.context.buckets.sort((a, b) => a - b);
  if (c.scheduler.maxConcurrent < 1) throw new Error("scheduler.maxConcurrent must be >= 1");
  if (c.backend.parallel !== "auto" && !(c.backend.parallel >= 1)) throw new Error('backend.parallel must be >= 1 or "auto"');
  if (!["A", "B", "C"].includes(c.router.mode)) throw new Error("router.mode must be A, B or C");
  if (c.router.mode === "B" && c.scheduler.maxConcurrent > 1) {
    // Mode B is defined as predominantly sequential heavy inference.
    c.scheduler.maxConcurrent = 1;
  }
  for (const [name, a] of Object.entries(c.models)) {
    if (a.kind === "job") {
      if (!Array.isArray(a.command) || !a.command.length) throw new Error(`models.${name}.command is required`);
      if (!["images", "speech", "transcriptions"].includes(a.endpoint)) throw new Error(`models.${name}.endpoint is invalid`);
      continue;
    }
    if (!a.model) throw new Error(`models.${name}.model is required`);
    if (a.parallel !== undefined && !(a.parallel >= 1)) throw new Error(`models.${name}.parallel must be >= 1`);
    if (a.model.endsWith(":cloud") || a.model.endsWith("-cloud")) {
      throw new Error(`models.${name}: cloud models are not allowed (${a.model})`);
    }
  }
}

export function isJob(a: ModelAlias | JobSpec | undefined): a is JobSpec {
  return a?.kind === "job";
}
