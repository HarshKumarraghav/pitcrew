// Captures one pass of the site/ replay in headless Chrome and builds docs/img/demo.gif with ffmpeg.
//   node scripts/demo/build-site.mjs && node scripts/demo/gif.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serveDir } from "./chrome.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "docs/img/demo.gif");
const FPS = 12;
const WIDTH = 900;
const trace = JSON.parse(readFileSync(join(root, "site/trace.json"), "utf8"));

const site = await serveDir(join(root, "site"));
const chrome = await launch({ width: 1360, height: 800 });
const frames = mkdtempSync(join(tmpdir(), "pitcrew-gif-"));
try {
  await chrome.goto(site.url);
  // The demo has no image/voice jobs; drop that empty panel so the frame fits the GIF.
  await chrome.eval(`document.getElementById("jobs").closest("section").style.display = "none"`);
  // Grab frames as fast as Chrome delivers them for one pass of the trace; timestamps become durations.
  const shots = [];
  const start = Date.now();
  while (Date.now() - start < trace.durationMs + 1000) {
    const t = Date.now() - start;
    const file = join(frames, `f${String(shots.length).padStart(5, "0")}.png`);
    writeFileSync(file, await chrome.screenshot());
    shots.push({ file, t });
    const next = (shots.length * 1000) / FPS;
    const wait = next - (Date.now() - start);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  const list = shots.map((s, i) => `file '${s.file}'\nduration ${(((shots[i + 1]?.t ?? s.t + 1000 / FPS) - s.t) / 1000).toFixed(3)}`).join("\n");
  writeFileSync(join(frames, "list.txt"), `${list}\nfile '${shots.at(-1).file}'\n`);
  const vf = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(frames, "list.txt"), "-vf", vf, "-loop", "0", out], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg failed");
  console.log(`${shots.length} frames → ${out} (${(statSync(out).size / 1e6).toFixed(2)} MB)`);
} finally {
  await chrome.close();
  await site.close();
  rmSync(frames, { recursive: true, force: true });
}
