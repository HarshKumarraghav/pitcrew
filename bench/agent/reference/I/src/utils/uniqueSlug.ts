/** Tracks the slugs in use by one store, so two of its tasks never share a slug. */
export class SlugRegistry {
  private taken = new Set<string>();

  /** Return `base`, or `base-2`, `base-3`, ... — the first variant that is not in use — and reserve it. */
  reserve(base: string): string {
    let slug = base;
    for (let n = 2; this.taken.has(slug); n++) slug = `${base}-${n}`;
    this.taken.add(slug);
    return slug;
  }

  /** Give a slug back once its task is deleted. */
  release(slug: string): void {
    this.taken.delete(slug);
  }
}
