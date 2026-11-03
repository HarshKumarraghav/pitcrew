#!/usr/bin/env node
// Stand-in for a big image/video model: allocates N GB, touches every page so it is really
// resident, holds it for M seconds, then writes a small output file. No downloads needed.
// usage: node ballast.mjs --gb 6 --seconds 20 --out /tmp/out.mp4 [--ramp 2]
import { writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((x) => x.length));
const gb = Number(args.gb ?? 1);
const seconds = Number(args.seconds ?? 10);
const ramp = Number(args.ramp ?? 2);
const out = args.out;
const CHUNK = 256 * 1024 * 1024;
const chunks = [];
const n = Math.ceil((gb * 1024 ** 3) / CHUNK);
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const b = Buffer.allocUnsafe(CHUNK);
  // Touch every 16 KiB page with a non-zero value so macOS cannot hand back shared zero pages.
  for (let off = 0; off < CHUNK; off += 16384) b[off] = (i + off) & 255 || 1;
  chunks.push(b);
  if (ramp > 0) await new Promise((r) => setTimeout(r, (ramp * 1000) / n));
}
process.stderr.write(`ballast: ${gb} GB resident after ${((Date.now() - t0) / 1000).toFixed(1)} s; holding ${seconds} s\n`);
await new Promise((r) => setTimeout(r, seconds * 1000));
let sum = 0;
for (const c of chunks) sum += c[0];
if (out) writeFileSync(out, Buffer.from(`BALLAST ${gb}GB ${seconds}s ${sum}\n`));
