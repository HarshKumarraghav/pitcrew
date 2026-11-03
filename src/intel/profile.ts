import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceFile } from "./scan.ts";
import type { ModuleInfo } from "./symbols.ts";

export interface ProjectProfile {
  name: string;
  description?: string;
  languages: { lang: string; files: number; lines: number }[];
  packageManager?: string;
  frameworks: string[];
  scripts: Record<string, string>;
  testRunner?: string;
  testCommand?: string;
  buildCommand?: string;
  entryPoints: string[];
  routes: { route: string; file: string }[];
  databases: string[];
  auth: string[];
  integrations: string[];
  dirs: { dir: string; files: number; role: string }[];
  conventions: string[];
  readme?: string;
}

// dependency name → label, grouped by what we report it as.
const FRAMEWORKS: Record<string, string> = {
  next: "Next.js", react: "React", vue: "Vue", svelte: "Svelte", "@angular/core": "Angular", express: "Express", fastify: "Fastify", koa: "Koa", hono: "Hono", "@nestjs/core": "NestJS", "react-native": "React Native", expo: "Expo", electron: "Electron", vite: "Vite", astro: "Astro", remix: "Remix", "@remix-run/react": "Remix", nuxt: "Nuxt",
  django: "Django", flask: "Flask", fastapi: "FastAPI", starlette: "Starlette", "gin-gonic/gin": "Gin", axum: "Axum", actix: "Actix", rails: "Rails", "spring-boot": "Spring Boot",
};
const DATABASES: Record<string, string> = { prisma: "Prisma", "@prisma/client": "Prisma", "drizzle-orm": "Drizzle", typeorm: "TypeORM", sequelize: "Sequelize", mongoose: "MongoDB (Mongoose)", mongodb: "MongoDB", pg: "PostgreSQL", postgres: "PostgreSQL", mysql2: "MySQL", "better-sqlite3": "SQLite", redis: "Redis", ioredis: "Redis", "@supabase/supabase-js": "Supabase", sqlalchemy: "SQLAlchemy", psycopg2: "PostgreSQL", "psycopg2-binary": "PostgreSQL" };
const AUTH: Record<string, string> = { "next-auth": "NextAuth", "@auth/core": "Auth.js", passport: "Passport", jsonwebtoken: "JWT", jose: "JWT (jose)", "@clerk/nextjs": "Clerk", "@supabase/auth-helpers-nextjs": "Supabase Auth", "firebase-admin": "Firebase Auth", bcrypt: "bcrypt", "django-allauth": "allauth" };
const INTEGRATIONS: Record<string, string> = { stripe: "Stripe", openai: "OpenAI", "@anthropic-ai/sdk": "Anthropic", "@aws-sdk/client-s3": "AWS S3", "aws-sdk": "AWS", twilio: "Twilio", "@sendgrid/mail": "SendGrid", resend: "Resend", "@sentry/node": "Sentry", "@sentry/nextjs": "Sentry", posthog: "PostHog", "posthog-js": "PostHog", axios: "axios (HTTP client)", graphql: "GraphQL", "@trpc/server": "tRPC", "socket.io": "Socket.IO", bullmq: "BullMQ", kafkajs: "Kafka", celery: "Celery", boto3: "AWS (boto3)", requests: "requests (HTTP)" };
const TEST_RUNNERS: Record<string, string> = { vitest: "Vitest", jest: "Jest", mocha: "Mocha", ava: "AVA", "@playwright/test": "Playwright", cypress: "Cypress", pytest: "pytest" };

const DIR_ROLES: [RegExp, string][] = [
  [/^(src\/)?(routes?|api|controllers?|handlers?|endpoints?|pages\/api|app\/api)$/, "HTTP routes / API handlers"],
  [/^(src\/)?(store|stores|state|redux|slices|context)$/, "state management"],
  [/^(src\/)?(models?|entities|schema|db|database|prisma|migrations?)$/, "data model / persistence"],
  [/^(src\/)?(services?|domain|core|lib|usecases?)$/, "business logic"],
  [/^(src\/)?(components?|ui|views?|screens?|widgets?)$/, "UI components"],
  [/^(src\/)?(utils?|helpers?|common|shared)$/, "utilities"],
  [/^(src\/)?(types?|interfaces?|typings)$/, "type definitions"],
  [/^(src\/)?(client|sdk|api-client)$/, "API client"],
  [/^(src\/)?(config|settings)$/, "configuration"],
  [/^(src\/)?(middleware|middlewares)$/, "middleware"],
  [/^(tests?|__tests__|spec|e2e)$/, "tests"],
  [/^(docs?)$/, "documentation"],
  [/^(scripts?|bin|tools)$/, "scripts / tooling"],
];

function readJson(p: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

function pick(deps: string[], table: Record<string, string>): string[] {
  return [...new Set(deps.filter((d) => table[d]).map((d) => table[d]!))];
}

export function profileProject(root: string, sources: SourceFile[], modules: ModuleInfo[]): ProjectProfile {
  const pkg = readJson(join(root, "package.json"));
  const deps = [
    ...Object.keys((pkg?.dependencies ?? {}) as object),
    ...Object.keys((pkg?.devDependencies ?? {}) as object),
    ...Object.keys((pkg?.peerDependencies ?? {}) as object),
  ];
  for (const f of ["requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile"]) {
    const p = join(root, f);
    if (existsSync(p)) {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = /^\s*([A-Za-z0-9_.\-/@]+)/.exec(line.replace(/^\s*(require|gem)\s+['"]?/, ""));
        if (m?.[1]) deps.push(m[1].toLowerCase());
      }
    }
  }
  // Imports also count: zero-dependency projects use node:http etc.
  const allExternal = new Set(modules.flatMap((m) => m.externalDeps));
  const allImports = new Set(modules.flatMap((m) => m.imports));
  const depSet = [...new Set([...deps, ...allExternal])];

  const langMap = new Map<string, { files: number; lines: number }>();
  for (const s of sources) {
    if (["markdown", "json", "yaml", "toml"].includes(s.lang)) continue;
    const e = langMap.get(s.lang) ?? { files: 0, lines: 0 };
    e.files++;
    e.lines += s.lines;
    langMap.set(s.lang, e);
  }

  const frameworks = pick(depSet, FRAMEWORKS);
  if (!frameworks.length && allImports.has("node:http")) frameworks.push("none (Node.js built-in node:http)");
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  let testRunner = pick(depSet, TEST_RUNNERS)[0];
  const testScript = scripts.test;
  if (!testRunner && testScript?.includes("--test")) testRunner = "node:test (built-in)";
  if (!testRunner && modules.some((m) => m.imports.includes("node:test"))) testRunner = "node:test (built-in)";
  if (!testRunner && existsSync(join(root, "pytest.ini"))) testRunner = "pytest";
  if (!testRunner && modules.some((m) => m.lang === "go" && m.isTest)) testRunner = "go test";

  const pm = existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) ? "yarn" : existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock")) ? "bun" : pkg ? "npm" : existsSync(join(root, "pyproject.toml")) ? "python (pyproject)" : existsSync(join(root, "go.mod")) ? "go modules" : existsSync(join(root, "Cargo.toml")) ? "cargo" : undefined;
  const run = pm === "npm" ? "npm run" : pm === "yarn" ? "yarn" : pm === "pnpm" ? "pnpm" : pm === "bun" ? "bun run" : "";

  const entryPoints = [
    ...(typeof pkg?.main === "string" ? [pkg.main] : []),
    ...Object.values((typeof pkg?.bin === "object" ? pkg.bin : {}) as Record<string, string>),
    ...Object.values(scripts).flatMap((s) => (s.match(/[\w./-]+\.(?:ts|js|mjs|py)\b/g) ?? []).filter((f) => !/test/.test(f))),
    ...modules.filter((m) => /(^|\/)(main|index|server|app|cli)\.(ts|js|py|go|rs)$/.test(m.path) && !m.isTest).map((m) => m.path),
  ];

  const dirCounts = new Map<string, number>();
  for (const s of sources) {
    const parts = s.path.split("/");
    if (parts.length < 2) continue;
    const d = parts[0] === "src" && parts.length > 2 ? `src/${parts[1]}` : parts[0]!;
    dirCounts.set(d, (dirCounts.get(d) ?? 0) + 1);
  }
  const dirs = [...dirCounts].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([dir, files]) => ({ dir, files, role: DIR_ROLES.find(([re]) => re.test(dir))?.[1] ?? "" }));

  const conventions: string[] = [];
  const ts = sources.filter((s) => s.lang === "typescript");
  if (ts.length) {
    const tsconfig = readJson(join(root, "tsconfig.json")) as { compilerOptions?: Record<string, unknown> } | undefined;
    if (tsconfig?.compilerOptions?.strict) conventions.push("TypeScript strict mode is on.");
    if (ts.some((s) => /from\s+['"]\.[^'"]+\.ts['"]/.test(s.text))) conventions.push("Relative imports include the `.ts` extension (e.g. `../types/task.ts`).");
    if (ts.some((s) => /import\s+type\s/.test(s.text))) conventions.push("Type-only imports use `import type`.");
    const dq = ts.reduce((a, s) => a + (s.text.match(/"/g)?.length ?? 0), 0);
    const sq = ts.reduce((a, s) => a + (s.text.match(/'/g)?.length ?? 0), 0);
    conventions.push(dq >= sq ? "Strings use double quotes." : "Strings use single quotes.");
    conventions.push(ts.some((s) => /;\s*$/m.test(s.text)) ? "Statements end with semicolons." : "No semicolons.");
  }
  if (pkg?.type === "module") conventions.push('ES modules (`"type": "module"`).');
  if (existsSync(join(root, ".eslintrc.json")) || existsSync(join(root, "eslint.config.js")) || existsSync(join(root, "eslint.config.mjs"))) conventions.push("ESLint is configured — run it before finishing.");
  if (existsSync(join(root, ".prettierrc")) || existsSync(join(root, "prettier.config.js"))) conventions.push("Prettier is configured.");
  const tests = modules.filter((m) => m.isTest);
  if (tests.length) {
    const dirsOfTests = [...new Set(tests.map((t) => t.path.split("/").slice(0, -1).join("/") || "."))];
    conventions.push(`Tests live in ${dirsOfTests.slice(0, 3).map((d) => `\`${d}/\``).join(", ")} and are named like \`${tests[0]!.path.split("/").pop()}\`.`);
  }

  let readme: string | undefined;
  for (const f of ["README.md", "readme.md", "README"]) {
    if (existsSync(join(root, f))) {
      readme = readFileSync(join(root, f), "utf8").slice(0, 3000);
      break;
    }
  }

  return {
    name: String(pkg?.name ?? root.split("/").pop()),
    description: typeof pkg?.description === "string" ? pkg.description : undefined,
    languages: [...langMap].map(([lang, v]) => ({ lang, ...v })).sort((a, b) => b.lines - a.lines),
    packageManager: pm,
    frameworks,
    scripts,
    testRunner,
    testCommand: testScript ? `${run || "npm run"} test`.replace("npm run test", "npm test") : testRunner === "pytest" ? "pytest" : testRunner === "go test" ? "go test ./..." : undefined,
    buildCommand: scripts.build ? `${run} build` : undefined,
    entryPoints: [...new Set(entryPoints)].slice(0, 10),
    routes: modules.flatMap((m) => m.routes.map((route) => ({ route, file: m.path }))),
    databases: pick(depSet, DATABASES),
    auth: pick(depSet, AUTH),
    integrations: pick(depSet, INTEGRATIONS),
    dirs,
    conventions,
    readme,
  };
}
