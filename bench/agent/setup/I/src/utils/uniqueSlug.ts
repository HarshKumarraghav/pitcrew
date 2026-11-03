/** Slugs that are currently in use, so two tasks never share a slug. */
const taken = new Set<string>();

/** Return `base`, or `base-2`, `base-3`, ... — the first variant that is not in use — and reserve it. */
export function uniqueSlug(base: string): string {
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

/** Give a slug back once its task is deleted. */
export function releaseSlug(slug: string): void {
  taken.delete(slug);
}
