// Builds site/index.html for GitHub Pages: the real dashboard (src/server/gui.html, unmodified)
// with a "recorded replay" banner and site/replay.js loaded before the dashboard's own script.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const gui = readFileSync(join(root, "src/server/gui.html"), "utf8");
const repo = "https://github.com/HarshKumarraghav/pitcrew";

const head = `<meta name="description" content="Pit Crew: run several local LLMs on one Mac without swapping. Recorded replay of the dashboard.">
<meta property="og:title" content="Pit Crew · dashboard replay">
<meta property="og:description" content="A memory-aware gateway between OpenCode and Ollama.">
<style>
  #replay-note { margin: 0 0 14px; padding: 6px 10px; border: 1px dashed var(--amber); color: var(--amber); font-size: 12px; }
  #replay-note b { font-weight: 400; color: var(--fg); }
</style>
`;
const banner = `<div id="replay-note">Recorded replay, not live: <b>loading…</b> · install it to see your own machine → <a href="${repo}#quick-start">${repo.replace("https://", "")}</a></div>
<script src="replay.js"></script>
`;

const marks = ["</head>", "<header>", "<script>"];
for (const m of marks) if (!gui.includes(m)) throw new Error(`gui.html no longer contains ${m}; update build-site.mjs`);
const html = gui
  .replace("<title>pitcrew · telemetry</title>", "<title>Pit Crew · dashboard replay</title>")
  .replace("</head>", `${head}</head>`)
  .replace("<header>", `${banner}<header>`);
writeFileSync(join(root, "site/index.html"), html);
console.log("site/index.html built from src/server/gui.html");
