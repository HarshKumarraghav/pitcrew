import { existsSync, readFileSync } from "node:fs";
import type { OllamaClient } from "../backend/ollama.ts";
import { isJob, type Config } from "../config.ts";
import type { MemoryProbe } from "../system/memory.ts";

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  config: Config;
  /** Config file in use; undefined means defaults (no file). */
  configPath?: string;
  client: OllamaClient;
  probe: MemoryProbe;
  /** OpenCode profile written by `pitcrew init`. */
  profilePath: string;
  toolVersion: (cmd: string) => string | undefined;
  /** Send one tiny request through the running gateway (default true). */
  request?: boolean;
}

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

/** Checks every link from OpenCode to the model; each failure says how to fix it. */
export async function doctor(d: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const cfg = d.config;

  add(
    d.configPath
      ? { name: "config", status: "ok", detail: d.configPath }
      : { name: "config", status: "fail", detail: "no pitcrew.config.json here and no ~/.pitcrew/config.json", fix: "npx pitcrew-ai init" },
  );

  const llm = Object.entries(cfg.models).filter(([, v]) => !isJob(v)) as [string, { model: string }][];
  for (const role of ["coder", "light"] as const) {
    const alias = cfg.router[role];
    if (!alias) continue;
    if (!cfg.models[alias]) add({ name: `router.${role}`, status: "fail", detail: `"${alias}" is not a configured model alias`, fix: "npx pitcrew-ai init (or add the alias to your config)" });
  }

  let tags: { name: string; size: number }[] | undefined;
  try {
    const v = await d.client.version();
    tags = await d.client.tags();
    add({ name: "ollama", status: "ok", detail: `${v.version} at ${d.client.url}` });
  } catch {
    add({
      name: "ollama",
      status: "fail",
      detail: `not reachable at ${d.client.url}`,
      fix: d.toolVersion("ollama") ? "open the Ollama app or run `ollama serve`" : "install Ollama: https://ollama.com/download",
    });
  }

  if (tags) {
    for (const [alias, spec] of llm) {
      const t = tags.find((x) => x.name === spec.model);
      add(t ? { name: `model ${alias}`, status: "ok", detail: `${spec.model} (${gb(t.size)})` } : { name: `model ${alias}`, status: "fail", detail: `${spec.model} is not pulled`, fix: `ollama pull ${spec.model}` });
    }
  }

  // Coder + light against the model budget (same rule the scheduler uses for its hard cap).
  const mem = await d.probe.read();
  const budget = cfg.memory.maxModelMemoryGiB ? cfg.memory.maxModelMemoryGiB * 1024 ** 3 : mem.gpuLimitBytes ? mem.gpuLimitBytes * 0.9 : mem.totalBytes * 0.75;
  const sizeOf = (alias?: string) => {
    const spec = alias ? cfg.models[alias] : undefined;
    if (!spec || isJob(spec)) return 0;
    return tags?.find((t) => t.name === spec.model)?.size ?? 0;
  };
  const need = (sizeOf(cfg.router.coder) + sizeOf(cfg.router.light)) * 1.05;
  if (need) {
    const headroom = mem.availableBytes + mem.inactiveBytes * 0.5 - cfg.memory.minFreeGiB * 1024 ** 3;
    add(
      need > budget
        ? { name: "memory", status: "fail", detail: `coder + light ≈ ${gb(need)} > model budget ${gb(budget)}`, fix: "npx pitcrew-ai init --force (picks models that fit)" }
        : need > headroom
          ? { name: "memory", status: "warn", detail: `coder + light ≈ ${gb(need)} fit the budget (${gb(budget)}) but only ${gb(Math.max(0, headroom))} is free now; open apps will be compressed/swapped`, fix: "close a browser, Docker or other large apps" }
          : { name: "memory", status: "ok", detail: `coder + light ≈ ${gb(need)}, ${gb(headroom)} free now, budget ${gb(budget)}` },
    );
  }

  const gw = `http://${cfg.listen.host}:${cfg.listen.port}`;
  const up = await fetch(`${gw}/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
  if (!up) {
    add({ name: "gateway", status: "warn", detail: `not running on ${gw}`, fix: "npx pitcrew-ai serve" });
  } else {
    add({ name: "gateway", status: "ok", detail: `${gw} (dashboard at /)` });
    if (d.request !== false) {
      const t0 = performance.now();
      try {
        const r = await fetch(`${gw}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: cfg.router.name, messages: [{ role: "user", content: "Reply with: ok" }], max_tokens: 1 }),
          signal: AbortSignal.timeout(120_000),
        });
        const body = (await r.json()) as { model?: string; error?: { message?: string } };
        const ms = Math.round(performance.now() - t0);
        add(r.ok ? { name: "request", status: "ok", detail: `${cfg.router.name} → ${body.model ?? "?"} answered in ${ms} ms` } : { name: "request", status: "fail", detail: `HTTP ${r.status}: ${body.error?.message ?? ""}`, fix: "see the gateway terminal and docs/TROUBLESHOOTING.md" });
      } catch (e) {
        add({ name: "request", status: "fail", detail: (e as Error).message, fix: "see the gateway terminal and docs/TROUBLESHOOTING.md" });
      }
    }
  }

  const oc = d.toolVersion("opencode");
  add(oc ? { name: "opencode", status: "ok", detail: oc } : { name: "opencode", status: "warn", detail: "not installed", fix: "https://opencode.ai (or: npm i -g opencode-ai)" });

  if (!existsSync(d.profilePath)) {
    add({ name: "opencode profile", status: "warn", detail: `${d.profilePath} missing`, fix: "npx pitcrew-ai init" });
  } else {
    let url: string | undefined;
    try {
      url = (JSON.parse(readFileSync(d.profilePath, "utf8")) as { provider?: { pitcrew?: { options?: { baseURL?: string } } } }).provider?.pitcrew?.options?.baseURL;
    } catch {
      // reported below
    }
    const want = `http://127.0.0.1:${cfg.listen.port}/v1`;
    add(
      url === want
        ? { name: "opencode profile", status: "ok", detail: `${d.profilePath} → ${want}; run: OPENCODE_CONFIG=${d.profilePath} opencode` }
        : { name: "opencode profile", status: "warn", detail: `${d.profilePath} points at ${url ?? "nothing"}, gateway is ${want}`, fix: "npx pitcrew-ai init --force" },
    );
  }
  return checks;
}

export function renderChecks(checks: Check[]): string {
  const icon = { ok: "✓", warn: "!", fail: "✗" };
  const lines = checks.map((c) => `${icon[c.status]} ${c.name.padEnd(17)} ${c.detail}${c.fix ? `\n  ${"".padEnd(17)} fix: ${c.fix}` : ""}`);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  lines.push("", fails ? `${fails} problem(s) to fix` : warns ? `ready, with ${warns} warning(s)` : "all good");
  return lines.join("\n");
}
