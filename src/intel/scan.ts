import { execFileSync } from "node:child_process";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { extname, join, relative } from "node:path";

export const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift",
  ".rb": "ruby", ".php": "php", ".cs": "csharp", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp",
  ".vue": "vue", ".svelte": "svelte", ".sql": "sql", ".prisma": "prisma", ".graphql": "graphql",
  ".md": "markdown", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".sh": "shell",
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "target", "vendor", "__pycache__", ".venv", "venv", "coverage", ".turbo", ".cache"]);
const MAX_FILE_BYTES = 512 * 1024;

export interface SourceFile {
  path: string;
  lang: string;
  bytes: number;
  lines: number;
  text: string;
}

/** List tracked files (respects .gitignore) or walk the tree when not a git repo. */
export function listFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter(Boolean).filter((p) => !p.split("/").some((seg) => SKIP_DIRS.has(seg)));
  } catch {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".") && e.name !== ".github") continue;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
        } else if (e.isFile()) files.push(relative(root, join(dir, e.name)));
      }
    };
    walk(root);
    return files;
  }
}

export function readSources(root: string, paths = listFiles(root)): SourceFile[] {
  const out: SourceFile[] = [];
  for (const p of paths) {
    const lang = LANG_BY_EXT[extname(p).toLowerCase()];
    if (!lang) continue;
    const full = join(root, p);
    if (!existsSync(full)) continue;
    const bytes = statSync(full).size;
    if (bytes > MAX_FILE_BYTES) continue;
    const text = readFileSync(full, "utf8");
    if (text.includes("\u0000")) continue; // binary
    out.push({ path: p, lang, bytes, lines: text.split("\n").length, text });
  }
  return out;
}

export interface GitFacts {
  isRepo: boolean;
  head?: string;
  commits?: number;
  hotFiles?: { path: string; changes: number }[];
  recent?: string[];
}

export function gitFacts(root: string): GitFacts {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const head = git("rev-parse", "--short", "HEAD");
    const commits = Number(git("rev-list", "--count", "HEAD"));
    const counts = new Map<string, number>();
    for (const line of git("log", "--name-only", "--pretty=format:", "-n", "500").split("\n")) {
      if (line) counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    const hotFiles = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([path, changes]) => ({ path, changes }));
    const recent = git("log", "--pretty=format:%h %s", "-n", "10").split("\n").filter(Boolean);
    return { isRepo: true, head, commits, hotFiles, recent };
  } catch {
    return { isRepo: false };
  }
}
