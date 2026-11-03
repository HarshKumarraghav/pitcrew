/** Convert a title into a URL-safe slug, e.g. "Fix  the Bug!" -> "fix-the-bug". */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s/g, "-");
}
