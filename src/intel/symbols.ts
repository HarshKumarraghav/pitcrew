import { dirname, join, normalize, extname } from "node:path";
import type { SourceFile } from "./scan.ts";

export interface SymbolDef {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "method" | "route" | "struct" | "enum";
  line: number;
  exported: boolean;
}

export interface ModuleInfo {
  path: string;
  lang: string;
  lines: number;
  symbols: SymbolDef[];
  /** Raw import specifiers. */
  imports: string[];
  /** Imports resolved to files inside the repo. */
  internalDeps: string[];
  externalDeps: string[];
  /** HTTP routes declared in this file, e.g. "GET /tasks/:id". */
  routes: string[];
  isTest: boolean;
}

const RULES: Record<string, { re: RegExp; kind: SymbolDef["kind"] }[]> = {
  typescript: [
    { re: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
    { re: /^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { re: /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
    { re: /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
    { re: /^\s*(export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
    { re: /^\s*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "const" },
    { re: /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$/, kind: "method" },
  ],
  python: [
    { re: /^()def\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^()class\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^\s+()def\s+([A-Za-z_]\w*)/, kind: "method" },
  ],
  go: [
    { re: /^()func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
    { re: /^()type\s+([A-Za-z_]\w*)\s+struct/, kind: "struct" },
    { re: /^()type\s+([A-Za-z_]\w*)\s+interface/, kind: "interface" },
  ],
  rust: [
    { re: /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^\s*(pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
    { re: /^\s*(pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
    { re: /^\s*(pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: "interface" },
  ],
  java: [
    { re: /^\s*(public\s+)?(?:abstract\s+|final\s+)*class\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^\s*(public\s+)?interface\s+([A-Za-z_]\w*)/, kind: "interface" },
    { re: /^\s+(public\s+|private\s+|protected\s+)(?:static\s+)?[\w<>\[\],\s]+\s+([a-z]\w*)\s*\(/, kind: "method" },
  ],
};
RULES.javascript = RULES.typescript!;
RULES.kotlin = RULES.java!;

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor", "super", "else"]);

const IMPORT_RES: Record<string, RegExp[]> = {
  typescript: [/\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g],
  python: [/^\s*from\s+([\w.]+)\s+import/gm, /^\s*import\s+([\w.]+)/gm],
  go: [/^\s*"([^"]+)"\s*$/gm, /^\s*import\s+"([^"]+)"/gm],
  rust: [/^\s*use\s+([\w:]+)/gm, /^\s*mod\s+(\w+)\s*;/gm],
  java: [/^\s*import\s+([\w.]+);/gm],
};
IMPORT_RES.javascript = IMPORT_RES.typescript!;
IMPORT_RES.kotlin = IMPORT_RES.java!;

// Express/Koa/Fastify/Hono-style and this-repo-style route registration, Flask/FastAPI decorators.
const ROUTE_RES = [
  /\b(?:router|app|server|api|r)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi,
  /\.add\(\s*['"](GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*['"]([^'"]+)['"]/g,
  /@(?:app|router|bp|api)\.(get|post|put|patch|delete|route)\(\s*['"]([^'"]+)['"]/gi,
];

export function isTestPath(p: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /_test\.go$/.test(p);
}

export function extractModule(f: SourceFile): Omit<ModuleInfo, "internalDeps" | "externalDeps"> {
  const symbols: SymbolDef[] = [];
  const rules = RULES[f.lang] ?? [];
  const lines = f.text.split("\n");
  lines.forEach((line, i) => {
    for (const { re, kind } of rules) {
      const m = re.exec(line);
      if (!m) continue;
      const name = m[2] ?? m[1];
      if (!name || KEYWORDS.has(name)) continue;
      const exported = Boolean(m[1]) || (f.lang === "python" && !name.startsWith("_")) || (f.lang === "go" && /^[A-Z]/.test(name));
      symbols.push({ name, kind, line: i + 1, exported });
      break;
    }
  });
  const imports: string[] = [];
  for (const re of IMPORT_RES[f.lang] ?? []) {
    for (const m of f.text.matchAll(re)) if (m[1]) imports.push(m[1]);
  }
  const routes: string[] = [];
  for (const re of ROUTE_RES) {
    for (const m of f.text.matchAll(re)) if (m[1] && m[2]) routes.push(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return { path: f.path, lang: f.lang, lines: f.lines, symbols, imports: [...new Set(imports)], routes: [...new Set(routes)], isTest: isTestPath(f.path) };
}

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", "/index.ts", "/index.tsx", "/index.js"];

/** Resolve import specifiers to repo files (relative JS/TS imports and dotted Python modules). */
export function resolveImports(mod: Omit<ModuleInfo, "internalDeps" | "externalDeps">, files: Set<string>): { internal: string[]; external: string[] } {
  const internal = new Set<string>();
  const external = new Set<string>();
  for (const spec of mod.imports) {
    if (mod.lang === "typescript" || mod.lang === "javascript") {
      if (spec.startsWith(".")) {
        const base = normalize(join(dirname(mod.path), spec));
        const stripped = base.replace(/\.(js|mjs|cjs)$/, "");
        const hit = [...RESOLVE_EXTS.map((e) => base + e), ...RESOLVE_EXTS.map((e) => stripped + e)].find((c) => files.has(c));
        if (hit) internal.add(hit);
      } else if (!spec.startsWith("node:")) {
        external.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
      }
    } else if (mod.lang === "python") {
      const rel = spec.replace(/\./g, "/");
      const hit = [`${rel}.py`, `${rel}/__init__.py`, `src/${rel}.py`].find((c) => files.has(c));
      if (hit) internal.add(hit);
      else external.add(spec.split(".")[0]!);
    } else {
      external.add(spec);
    }
  }
  internal.delete(mod.path);
  return { internal: [...internal], external: [...external] };
}

export function buildModules(sources: SourceFile[]): ModuleInfo[] {
  const code = sources.filter((s) => !["markdown", "json", "yaml", "toml"].includes(s.lang) || extname(s.path) === "");
  const files = new Set(sources.map((s) => s.path));
  return code.map((s) => {
    const m = extractModule(s);
    const { internal, external } = resolveImports(m, files);
    return { ...m, internalDeps: internal, externalDeps: external };
  });
}
