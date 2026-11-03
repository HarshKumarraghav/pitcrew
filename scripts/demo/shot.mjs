// Screenshot a URL or local HTML file with headless Chrome.
//   node scripts/demo/shot.mjs <url | file.html> <out.png> [width height] [--wait ms]
//   node scripts/demo/shot.mjs scripts/demo/social-card.html docs/img/social-preview.png 1280 640
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launch, serveDir } from "./chrome.mjs";

const args = process.argv.slice(2);
const waitAt = args.indexOf("--wait");
const wait = waitAt >= 0 ? Number(args.splice(waitAt, 2)[1]) : 500;
const [target, out, w = "1280", h = "800"] = args;
if (!target || !out) throw new Error("usage: shot.mjs <url | file.html> <out.png> [width height] [--wait ms]");

const local = !/^https?:/.test(target);
const site = local ? await serveDir(dirname(resolve(target))) : undefined;
const url = local ? new URL(pathToFileURL(resolve(target)).pathname.split("/").pop(), site.url).href : target;
const chrome = await launch({ width: Number(w), height: Number(h) });
try {
  await chrome.goto(url);
  await new Promise((r) => setTimeout(r, wait));
  writeFileSync(out, await chrome.screenshot());
  console.log(`${url} → ${out}`);
} finally {
  await chrome.close();
  await site?.close();
}
