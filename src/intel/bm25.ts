/** Split code-ish text into lowercase terms; camelCase / snake_case / kebab-case are split too. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) ?? []) {
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_]+/)
      .filter(Boolean);
    for (const p of parts) {
      const t = p.toLowerCase();
      if (t.length > 1 && !STOP.has(t)) out.push(stem(t));
    }
    if (parts.length > 1) out.push(raw.toLowerCase());
  }
  return out;
}

const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "are", "was", "will", "should", "can", "add", "new", "use", "make", "get", "set", "all", "any", "not", "but", "you", "its", "our", "let", "var", "const", "return", "import", "export", "type", "string", "number", "true", "false", "null", "undefined", "void", "async", "await", "function", "if", "else", "of", "to", "in", "on", "is", "it", "be", "as", "an", "or", "by", "at"]);

/** Tiny suffix stripper: enough to match "tasks"/"task", "filtering"/"filter". */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("es") && !t.endsWith("ses")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export interface Doc {
  id: string;
  /** Weighted fields: name/path terms count more than body terms. */
  fields: { text: string; weight: number }[];
}

export class BM25 {
  private df = new Map<string, number>();
  private docs: { id: string; tf: Map<string, number>; len: number }[] = [];
  private avgLen = 0;
  private k1 = 1.2;
  private b = 0.75;

  constructor(docs: Doc[]) {
    for (const d of docs) {
      const tf = new Map<string, number>();
      let len = 0;
      for (const f of d.fields) {
        for (const t of tokenize(f.text)) {
          tf.set(t, (tf.get(t) ?? 0) + f.weight);
          len += f.weight;
        }
      }
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id: d.id, tf, len });
    }
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / Math.max(1, this.docs.length);
  }

  search(query: string, k = 10): { id: string; score: number; matched: string[] }[] {
    const terms = [...new Set(tokenize(query))];
    const N = this.docs.length;
    const res = this.docs.map((d) => {
      let score = 0;
      const matched: string[] = [];
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen));
        matched.push(t);
      }
      return { id: d.id, score, matched };
    });
    return res.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }
}
