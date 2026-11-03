/** Convert a title into a URL-safe slug, e.g. "Fix  the Bug!" -> "fix-the-bug", "Crème brûlée" -> "creme-brulee". */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // one pass: every run of non-alphanumerics becomes a hyphen
    .replace(/^-+|-+$/g, "");
}
