import type { Page } from "../types/task.ts";

/** Return one 1-indexed page of `items`. */
export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  const safePage = Math.max(1, Math.floor(page));
  const safeSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const start = (safePage - 1) * safeSize;
  return {
    items: items.slice(start, start + safeSize),
    page: safePage,
    pageSize: safeSize,
    total: items.length,
    totalPages: Math.ceil(items.length / safeSize),
  };
}
