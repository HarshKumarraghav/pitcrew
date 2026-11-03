import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isJob, type Config, type ModelAlias, type Priority } from "../config.ts";
import type { OllamaClient, TagModel } from "../backend/ollama.ts";
import { Footprint, parseArch, type Observation } from "./footprint.ts";

export const DERIVED_NS = "pitcrew/";

export interface Resolved {
  /** Name the client asked for. */
  requested: string;
  /** Concrete backend base model, e.g. "qwen3.5:9b". */
  base: string;
  alias?: string;
  spec: ModelAlias;
  priority: Priority;
}

export class ModelError extends Error {
  status: number;
  constructor(message: string, status = 404) {
    super(message);
    this.status = status;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
}

export function derivedName(base: string, ctx: number, params: Record<string, unknown> = {}): string {
  const extra = Object.keys(params).length
    ? "-" + createHash("sha1").update(JSON.stringify(params)).digest("hex").slice(0, 6)
    : "";
  return `${DERIVED_NS}${sanitize(base)}:${Math.round(ctx / 1024)}k${extra}`;
}

export class Registry {
  private cfg: Config;
  private client: OllamaClient;
  private tags = new Map<string, TagModel>();
  private footprints = new Map<string, Footprint>();
  private created = new Set<string>();
  private creating = new Map<string, Promise<void>>();
  private calibrationPath: string;
  private calibration: Record<string, Observation[]> = {};

  constructor(cfg: Config, client: OllamaClient) {
    this.cfg = cfg;
    this.client = client;
    this.calibrationPath = join(cfg.stateDir, "calibration.json");
    if (existsSync(this.calibrationPath)) {
      try {
        this.calibration = JSON.parse(readFileSync(this.calibrationPath, "utf8"));
      } catch {
        this.calibration = {};
      }
    }
  }

  async refresh(): Promise<void> {
    const list = await this.client.tags();
    this.tags = new Map(list.map((m) => [m.name, m]));
    for (const m of list) if (m.name.startsWith(DERIVED_NS)) this.created.add(m.name);
  }

  localModels(): TagModel[] {
    return [...this.tags.values()].filter((m) => !m.remote_host && !m.name.startsWith(DERIVED_NS));
  }

  private findTag(name: string): TagModel | undefined {
    return this.tags.get(name) ?? this.tags.get(`${name}:latest`);
  }

  async resolve(requested: string): Promise<Resolved> {
    const aliasSpec = this.cfg.models[requested];
    let spec: ModelAlias;
    let alias: string | undefined;
    if (isJob(aliasSpec)) throw new ModelError(`${requested} is a ${aliasSpec.endpoint} model; use /v1/${aliasSpec.endpoint === "images" ? "images/generations" : `audio/${aliasSpec.endpoint}`}`, 400);
    if (aliasSpec) {
      alias = requested;
      spec = aliasSpec;
    } else {
      if (requested.startsWith(DERIVED_NS)) throw new ModelError(`use the base model name, not ${requested}`, 400);
      if (!this.cfg.allowUndeclared) throw new ModelError(`unknown model alias: ${requested}`);
      spec = { model: requested };
    }
    if (!this.findTag(spec.model)) await this.refresh();
    const tag = this.findTag(spec.model);
    if (!tag) throw new ModelError(`model not found locally: ${spec.model} (run: ollama pull ${spec.model})`);
    if (tag.remote_host || tag.name.endsWith(":cloud") || tag.name.endsWith("-cloud")) {
      throw new ModelError(`refusing cloud model ${tag.name}: pitcrew only serves local inference`, 403);
    }
    return { requested, base: tag.name, alias, spec, priority: spec.priority ?? "interactive" };
  }

  cachedFootprint(base: string): Footprint | undefined {
    return this.footprints.get(base);
  }

  async footprint(base: string): Promise<Footprint> {
    const have = this.footprints.get(base);
    if (have) return have;
    const tag = this.findTag(base);
    if (!tag) throw new ModelError(`model not found locally: ${base}`);
    const show = await this.client.show(base);
    if (show.remote_host) throw new ModelError(`refusing cloud model ${base}`, 403);
    const fp = new Footprint(tag.size, parseArch(show), this.cfg.backend.kvCacheType);
    for (const o of this.calibration[tag.digest] ?? []) fp.observe(o);
    this.footprints.set(base, fp);
    return fp;
  }

  /** Record a measured resident size so future estimates for this model are exact. */
  calibrate(base: string, o: Observation): void {
    const fp = this.footprints.get(base);
    const tag = this.findTag(base);
    if (!fp || !tag) return;
    fp.observe(o);
    this.calibration[tag.digest] = fp.observations;
    try {
      mkdirSync(this.cfg.stateDir, { recursive: true });
      writeFileSync(this.calibrationPath, JSON.stringify(this.calibration, null, 2));
    } catch {
      // Calibration is an optimisation; never fail a request over it.
    }
  }

  /** Make sure a derived model with the given context exists; returns its name. */
  async ensureVariant(r: Resolved, ctx: number): Promise<string> {
    const params = r.spec.parameters ?? {};
    const name = derivedName(r.base, ctx, params);
    if (this.created.has(name)) return name;
    let p = this.creating.get(name);
    if (!p) {
      p = this.client.create(name, r.base, { ...params, num_ctx: ctx }).then(() => {
        this.created.add(name);
      });
      this.creating.set(name, p);
      p.finally(() => this.creating.delete(name)).catch(() => undefined);
    }
    await p;
    return name;
  }

  derivedModels(): string[] {
    return [...this.created];
  }
}
