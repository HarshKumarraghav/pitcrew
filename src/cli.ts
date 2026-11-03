#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadConfig, isJob } from "./config.ts";
import { OllamaClient, ManagedOllama } from "./backend/ollama.ts";
import { defaultProbe, MemoryMonitor } from "./system/memory.ts";
import { createGateway } from "./server/http.ts";
import { Registry, DERIVED_NS } from "./models/registry.ts";
import { scout, retrieve, formatContext, scanProject } from "./intel/index.ts";
import { collectExample, exportDataset, planTune, learnDir, loadExamples } from "./learn/examples.ts";
import { join } from "node:path";

const G = 1024 ** 3;
const gb = (b?: number) => (b === undefined ? "?" : `${(b / 1e9).toFixed(1)} GB`);

const HELP = `pitcrew — OpenCode drives. Your local models are the crew.

usage: pitcrew <command> [options]

  serve [--config f] [--port n]   start the gateway + dashboard (default http://127.0.0.1:11500)
  audit                           inspect this machine: memory, swap, pressure, runtimes, models
  garage                          local models with estimated vs measured memory, and what fits now
  scout <repo>                    analyse a repository → ~/.pitcrew/projects/<id>/ (repo untouched)
  context "<task>" [--repo dir] [-k n]   files most relevant to a task (BM25 + symbols + import graph)
  status                          live scheduler state from a running gateway
  learn collect --task "<what was done>" [--repo dir] [--base ref] [--approve]
                                  save a reviewed, test-passing change as a training example (opt-in)
  learn export [--repo dir]       validate examples → MLX-LM train/valid JSONL (+ provenance)
  tune plan --hf-model <id> --params <B> [--repo dir]
                                  print a LoRA command + memory check; never starts training
  clean [--yes]                   remove Pit Crew's derived context models (pitcrew/*) from Ollama

common: --config <file>   (default ./pitcrew.config.json or ~/.pitcrew/config.json)
`;

function flag(args: string[], name: string, short?: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || (short && a === `-${short}`));
  return i >= 0 ? args[i + 1] : undefined;
}

function tryRun(cmd: string, args: string[]): string {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000 });
    if (r.error) return "not found";
    return `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").find((l) => /\d/.test(l))?.replace(/^.*?version[: ]*(is )?/i, "") ?? "unknown";
  } catch {
    return "not found";
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const cfgPath = flag(args, "config");

  switch (cmd) {
    case "serve": {
      const port = flag(args, "port");
      const { config, path } = loadConfig(cfgPath, port ? { listen: { port: Number(port) } } : undefined);
      let managed: ManagedOllama | undefined;
      if (config.backend.managed) {
        managed = new ManagedOllama(config.backend.url, {
          OLLAMA_NUM_PARALLEL: String(config.backend.parallel === "auto" ? 1 : config.backend.parallel),
          OLLAMA_MAX_LOADED_MODELS: "8",
          OLLAMA_KEEP_ALIVE: "-1",
          ...config.backend.env,
        });
        await managed.start();
      }
      const monitor = new MemoryMonitor(defaultProbe(), config.memory);
      await monitor.sample();
      monitor.start();
      const gw = createGateway(config, { monitor });
      gw.scheduler.start();
      await gw.registry.refresh().catch((e) => console.error(`[pitcrew] backend not reachable yet: ${(e as Error).message}`));
      void gw.warmUp().catch((e) => console.error(`[pitcrew] warm-up failed: ${(e as Error).message}`));
      gw.server.listen(config.listen.port, config.listen.host, () => {
        const s = monitor.latest!;
        console.log(`pitcrew gateway  http://${config.listen.host}:${config.listen.port}  (dashboard at /, OpenAI API at /v1)`);
        console.log(`  backend  ${config.backend.url}${managed ? " (managed)" : ""}   config ${path ?? "defaults"}`);
        console.log(`  memory   ${gb(s.availableBytes)} available of ${gb(s.totalBytes)} · swap ${gb(s.swapUsedBytes)} · pressure ${s.pressure} · model budget ${gb(gw.scheduler.budget())}`);
        console.log(`  aliases  ${Object.entries(config.models).map(([k, v]) => `${k}→${isJob(v) ? v.endpoint : v.model}`).join("  ") || "(none; any local model name works)"}`);
      });
      const stop = async () => {
        await gw.close();
        managed?.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }

    case "audit": {
      const { config } = loadConfig(cfgPath);
      const s = await defaultProbe().read();
      const chip = tryRun("sysctl", ["-n", "machdep.cpu.brand_string"]);
      const model = tryRun("sysctl", ["-n", "hw.model"]);
      const os = `${tryRun("sw_vers", ["-productVersion"])} (${tryRun("sw_vers", ["-buildVersion"])})`;
      console.log(`machine   ${model} · ${chip} · ${gb(s.totalBytes)} unified memory · macOS ${os}`);
      console.log(`memory    available ${gb(s.availableBytes)} · inactive(compressible) ${gb(s.inactiveBytes)} · kernel pressure ${s.pressure}`);
      console.log(`swap      ${gb(s.swapUsedBytes)} used of ${gb(s.swapTotalBytes)}`);
      console.log(`gpu       working-set limit ≈ ${gb(s.gpuLimitBytes)}`);
      console.log(`disk      ${tryRun("df", ["-h", "/System/Volumes/Data"]).split("\n").pop()?.split(/\s+/).slice(3, 4)[0] ?? "?"} free`);
      console.log(`runtimes  ollama ${tryRun("ollama", ["--version"])} · opencode ${tryRun("opencode", ["--version"])} · llama.cpp ${tryRun("llama-server", ["--version"])} · node ${process.version}`);
      const client = new OllamaClient(config.backend.url);
      try {
        const tags = await client.tags();
        const local = tags.filter((t) => !t.remote_host && !t.name.startsWith(DERIVED_NS));
        console.log(`models    ${local.map((t) => `${t.name} (${gb(t.size)})`).join(", ") || "none"}`);
        const cloud = tags.filter((t) => t.remote_host);
        if (cloud.length) console.log(`cloud     ⚠ ${cloud.map((t) => t.name).join(", ")} — Pit Crew refuses these`);
      } catch {
        console.log(`models    Ollama not reachable at ${config.backend.url}`);
      }
      if (s.pressure !== "normal") console.log(`\n⚠ memory pressure is already "${s.pressure}" before loading anything. Expect swapping; prefer models ≤ ${gb(Math.max(1, s.availableBytes + s.inactiveBytes * 0.5 - G))}.`);
      return;
    }

    case "garage": {
      const { config } = loadConfig(cfgPath);
      const client = new OllamaClient(config.backend.url);
      const reg = new Registry(config, client);
      await reg.refresh();
      const s = await defaultProbe().read();
      const ps = await client.ps().catch(() => []);
      const headroom = s.availableBytes - config.memory.minFreeGiB * G + s.inactiveBytes * 0.5;
      console.log(`headroom now ≈ ${gb(headroom)} (available ${gb(s.availableBytes)} − floor ${config.memory.minFreeGiB} GB + ½ compressible ${gb(s.inactiveBytes)})\n`);
      console.log("model".padEnd(28) + "weights".padEnd(10) + "@8k".padEnd(9) + "@32k".padEnd(9) + "basis".padEnd(12) + "resident".padEnd(11) + "fits@32k");
      for (const m of reg.localModels()) {
        const fp = await reg.footprint(m.name);
        const res = ps.find((p) => p.name === m.name || p.name.startsWith(`${DERIVED_NS}${m.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}`));
        const basis = fp.observations.length >= 2 ? "measured" : fp.observations.length ? "calibrated" : fp.arch.known ? "metadata" : "guess";
        const e32 = fp.estimate(32768);
        console.log(m.name.padEnd(28) + gb(m.size).padEnd(10) + gb(fp.estimate(8192)).padEnd(9) + gb(e32).padEnd(9) + basis.padEnd(12) + (res ? gb(res.size) : "—").padEnd(11) + (res ? "loaded" : e32 <= headroom ? "yes" : "evict/swap"));
      }
      console.log("\nestimates: weights + KV(ctx) + overhead; 'measured' = fitted from /api/ps sizes at ≥2 context sizes.");
      return;
    }

    case "scout": {
      const repo = resolve(args.find((a) => !a.startsWith("-")) ?? ".");
      const t0 = Date.now();
      const r = scout(repo);
      const p = r.index.profile;
      console.log(`scouted ${p.name} in ${Date.now() - t0} ms → ${r.dir}`);
      console.log(`  ${p.languages.map((l) => `${l.lang}:${l.files}`).join(" ")} · frameworks: ${p.frameworks.join(", ") || "none"} · tests: ${p.testRunner ?? "?"} (\`${p.testCommand ?? "?"}\`)`);
      console.log(`  ${r.index.modules.length} modules · ${r.index.modules.reduce((a, m) => a + m.symbols.length, 0)} symbols · ${p.routes.length} routes`);
      console.log(`  artifacts: ${r.files.join(", ")}`);
      return;
    }

    case "context": {
      const task = args.find((a, i) => !a.startsWith("-") && !["--repo", "-k"].includes(args[i - 1] ?? ""));
      if (!task) throw new Error('usage: pitcrew context "<task>" [--repo dir] [-k n]');
      const repo = resolve(flag(args, "repo") ?? ".");
      const { index, sources } = scanProject(repo);
      const hits = retrieve(repo, task, { k: Number(flag(args, "k", "k") ?? 8), index, sources });
      process.stdout.write(formatContext(task, hits, index));
      return;
    }

    case "learn": {
      const sub = args[0];
      const repo = resolve(flag(args, "repo") ?? ".");
      if (sub === "collect") {
        const task = flag(args, "task");
        if (!task) throw new Error('usage: pitcrew learn collect --task "<what was done>" [--base ref] [--approve]');
        const r = collectExample({ repo, task, base: flag(args, "base"), approved: args.includes("--approve") });
        console.log(`example ${r.example.id}: ${r.example.patch.split("\n").length} diff lines · tests ${r.example.tests.passed ? "passed" : "FAILED"} (${r.example.tests.summary}) · license ${r.example.provenance.license}`);
        if (r.problems.length) console.log(`not saved:\n  - ${r.problems.join("\n  - ")}`);
        else if (!r.written) console.log("not saved: review the diff, then re-run with --approve");
        else console.log(`saved → ${r.written}`);
        return;
      }
      if (sub === "export") {
        const dir = learnDir(repo);
        const rep = exportDataset(join(dir, "examples.jsonl"), join(dir, "dataset"));
        console.log(`examples ${rep.total} · kept ${rep.kept} · train ${rep.train} · valid ${rep.valid}`);
        for (const x of rep.rejected) console.log(`  rejected ${x.id}: ${x.reason}`);
        console.log(`files: ${rep.files.join(", ")}`);
        return;
      }
      throw new Error("usage: pitcrew learn collect|export");
    }

    case "tune": {
      if (args[0] !== "plan") throw new Error("usage: pitcrew tune plan --hf-model <id> --params <billions>");
      const repo = resolve(flag(args, "repo") ?? ".");
      const dir = learnDir(repo);
      const rows = loadExamples(join(dir, "examples.jsonl")).filter((e) => e.approved && e.tests.passed).length;
      const s = await defaultProbe().read();
      const plan = planTune({
        dataDir: join(dir, "dataset"),
        hfModel: flag(args, "hf-model") ?? "Qwen/Qwen3.5-0.8B",
        paramsB: Number(flag(args, "params") ?? 0.8),
        availableGiB: (s.availableBytes + s.inactiveBytes * 0.5) / G,
        trainRows: rows,
        adapterDir: join(dir, "adapters"),
      });
      console.log(`estimated training memory ≈ ${plan.estimateGiB} GiB · approved examples ${rows}`);
      for (const r of plan.reasons) console.log(`  ✕ ${r}`);
      console.log(`\n${plan.ok ? "ready — run this yourself while no inference model is loaded:" : "command (not ready yet):"}\n  ${plan.command.join(" ")}`);
      console.log("\nThen evaluate base vs adapter, each with and without retrieval (docs/BENCHMARKS.md); keep the base model unchanged.");
      return;
    }

    case "status": {
      const { config } = loadConfig(cfgPath);
      const r = await fetch(`http://${config.listen.host}:${config.listen.port}/governor/state`).catch(() => undefined);
      if (!r) throw new Error(`no gateway on ${config.listen.host}:${config.listen.port} (start it with: pitcrew serve)`);
      const st = (await r.json()) as { memory: { availableBytes: number; swapUsedBytes: number; state: string }; scheduler: { units: { key: string; state: string; ctx: number; bytes: number; inFlight: number }[]; queue: { id: number; key: string; reason?: string }[]; running: number } };
      console.log(`memory ${gb(st.memory.availableBytes)} available · swap ${gb(st.memory.swapUsedBytes)} · ${st.memory.state} · running ${st.scheduler.running} · queued ${st.scheduler.queue.length}`);
      for (const u of st.scheduler.units) console.log(`  ${u.state.padEnd(9)} ${u.key.padEnd(28)} ctx ${String(u.ctx || "-").padEnd(6)} ${gb(u.bytes).padEnd(8)} busy ${u.inFlight}`);
      for (const q of st.scheduler.queue) console.log(`  queued #${q.id} ${q.key}: ${q.reason ?? ""}`);
      return;
    }

    case "clean": {
      const { config } = loadConfig(cfgPath);
      const client = new OllamaClient(config.backend.url);
      const derived = (await client.tags()).filter((t) => t.name.startsWith(DERIVED_NS)).map((t) => t.name);
      if (!derived.length) return console.log("nothing to clean");
      console.log(`derived models (metadata only, weights are shared with the base model):\n  ${derived.join("\n  ")}`);
      if (!args.includes("--yes")) return console.log("\nre-run with --yes to remove them");
      for (const d of derived) await client.remove(d);
      return console.log(`removed ${derived.length}`);
    }

    default:
      process.stdout.write(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`pitcrew: ${(e as Error).message}`);
  process.exit(1);
});
