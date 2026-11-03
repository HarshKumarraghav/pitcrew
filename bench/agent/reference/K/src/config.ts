export interface Config {
  defaultPageSize: number;
  maxPageSize: number;
}

function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

/** Read and validate configuration from environment variables. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const defaultPageSize = positiveInt(env, "TASKBOARD_DEFAULT_PAGE_SIZE", 20);
  const maxPageSize = positiveInt(env, "TASKBOARD_MAX_PAGE_SIZE", 100);
  if (defaultPageSize > maxPageSize) {
    throw new Error(
      `TASKBOARD_DEFAULT_PAGE_SIZE (${defaultPageSize}) must not exceed TASKBOARD_MAX_PAGE_SIZE (${maxPageSize})`,
    );
  }
  return { defaultPageSize, maxPageSize };
}
