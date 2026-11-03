import type { RouterConfig } from "../config.ts";

export type Role = "agent" | "helper";

/**
 * Deterministic request classification — no model call.
 * Agent turns carry tool schemas; helper requests (session titles, short summaries) don't and are small.
 * Long tool-less requests (e.g. conversation compaction) stay on the coder: they need its context window.
 */
export function classify(body: Record<string, unknown>, promptChars: number, cfg: RouterConfig): Role {
  const tools = body.tools;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (!hasTools && promptChars <= cfg.helperMaxPromptChars) return "helper";
  return "agent";
}

export interface RouteDecision {
  alias: string;
  role: Role;
  why: string;
  /** Body overrides applied for helper requests (output cap). */
  patch: Record<string, unknown>;
}

/**
 * Pick the alias for a request sent to the router model (e.g. "auto").
 * `canHost(alias)` answers "is it resident, or would it load without evicting anything?".
 */
export function route(body: Record<string, unknown>, promptChars: number, cfg: RouterConfig, canHost: (alias: string) => boolean): RouteDecision {
  const role = classify(body, promptChars, cfg);
  // Helpers: cap output and switch thinking off. Measured on qwen3.5:0.8b: a title request with
  // default thinking used all 512 tokens on reasoning and returned an empty title (14.4 s);
  // with reasoning_effort "none" it answered in 0.2 s.
  const patch: Record<string, unknown> =
    role === "helper"
      ? { max_tokens: Math.min(Number(body.max_tokens ?? cfg.helperMaxTokens), cfg.helperMaxTokens), ...(cfg.helperNoThinking ? { reasoning_effort: "none" } : {}) }
      : {};
  if (role === "agent" || cfg.mode === "A" || !cfg.light) {
    return { alias: cfg.coder, role, why: role === "agent" ? "tool-using agent turn" : `mode ${cfg.mode}: single model`, patch };
  }
  if (cfg.mode === "B") return { alias: cfg.light, role, why: "mode B: helper → light model", patch };
  // Mode C: use the light model only when it costs no eviction; otherwise reuse the resident coder.
  if (canHost(cfg.light)) return { alias: cfg.light, role, why: "mode C: light model fits alongside", patch };
  return { alias: cfg.coder, role, why: "mode C: light model would force an eviction → reuse coder", patch };
}
