/**
 * Full-text search over the docs, section by section (BM25).
 *
 * A page is cut at its `##` and `###` headings so a hit can link to the exact
 * anchor. Page titles and headings weigh more than body text.
 */

export interface SearchablePage {
  id: string;
  title: string;
  url: string;
  markdown: string;
}

export interface Chunk {
  pageId: string;
  heading: string | null;
  anchor: string | null;
  /** The section's Markdown, heading line included. */
  text: string;
}

export interface SearchHit {
  pageId: string;
  title: string;
  heading: string | null;
  /** The page URL, with the section's anchor when the hit is below a heading. */
  url: string;
  snippet: string;
  score: number;
}

const FENCE = /^\s*(```|~~~)/;
const STOPWORDS = new Set(
  "a an and are as at be by can could do does for from has have how i if in into is it its me my not of on or our should so that the their them then there these this those to use using was we what when where which who why will with would you your".split(
    " ",
  ),
);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

/** Words, lower-cased and stemmed. `getOfflineSignerFor` also yields `offline`, `signer`, … */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const add = (word: string) => {
    const lower = word.toLowerCase();
    if (lower.length < 2 && !/\d/.test(lower)) return;
    if (STOPWORDS.has(lower)) return;
    out.push(stem(lower));
  };
  for (const raw of text.match(/[A-Za-z0-9]+/g) ?? []) {
    add(raw);
    const parts = raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    if (parts.length > 1) for (const part of parts) add(part);
  }
  return out;
}

function plainHeading(text: string): string {
  return text
    .replace(/\s*\{#[^}]+\}\s*$/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
}

/** The anchor Docusaurus gives a heading (github-slugger rules). */
export function headingAnchor(heading: string, seen: Map<string, number>): string {
  const explicit = /\{#([^}]+)\}\s*$/.exec(heading);
  if (explicit?.[1]) return explicit[1];
  const base = plainHeading(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

export function chunkPage(page: SearchablePage): Chunk[] {
  const chunks: Chunk[] = [];
  const seen = new Map<string, number>();
  let current: Chunk = { pageId: page.id, heading: null, anchor: null, text: "" };
  let fenced = false;
  const lines: string[] = [];
  const flush = () => {
    current.text = lines.join("\n").trim();
    if (current.text) chunks.push(current);
    lines.length = 0;
  };
  for (const line of page.markdown.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      // Every heading takes an anchor slot, so a repeated title numbers the same way the site does.
      const anchor = headingAnchor(heading[2], seen);
      const level = heading[1].length;
      if (level === 2 || level === 3) {
        flush();
        current = { pageId: page.id, heading: plainHeading(heading[2]), anchor, text: "" };
      }
    }
    lines.push(line);
  }
  flush();
  return chunks;
}

interface IndexedChunk extends Chunk {
  title: string;
  url: string;
  length: number;
  tf: Map<string, number>;
  lower: string;
}

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 3;
const HEADING_WEIGHT = 2;

export class DocsSearch {
  private readonly chunks: IndexedChunk[] = [];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(pages: readonly SearchablePage[]) {
    for (const page of pages) {
      const titleTokens = tokenize(page.title);
      for (const chunk of chunkPage(page)) {
        const tokens = [
          ...tokenize(chunk.text),
          ...Array.from({ length: TITLE_WEIGHT }, () => titleTokens).flat(),
          ...Array.from({ length: HEADING_WEIGHT }, () => tokenize(chunk.heading ?? "")).flat(),
        ];
        const tf = new Map<string, number>();
        for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
        for (const token of tf.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1);
        this.chunks.push({
          ...chunk,
          title: page.title,
          url: chunk.anchor ? `${page.url}#${chunk.anchor}` : page.url,
          length: tokens.length,
          tf,
          lower: chunk.text.toLowerCase(),
        });
      }
    }
    this.avgLength = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0) / Math.max(1, this.chunks.length);
  }

  get size(): number {
    return this.chunks.length;
  }

  search(query: string, limit = 5, perPage = 2): SearchHit[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const phrase = query.trim().toLowerCase();
    const n = this.chunks.length;

    const scored: { chunk: IndexedChunk; score: number }[] = [];
    for (const chunk of this.chunks) {
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        const tf = chunk.tf.get(term);
        if (!tf) continue;
        matched++;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * chunk.length) / this.avgLength));
      }
      if (score === 0) continue;
      // Sections that hold every term, or the query as typed, come first.
      score *= 1 + matched / terms.length;
      if (phrase.length > 3 && chunk.lower.includes(phrase)) score *= 1.5;
      scored.push({ chunk, score });
    }
    scored.sort((a, b) => b.score - a.score);

    const hits: SearchHit[] = [];
    const perPageCount = new Map<string, number>();
    for (const { chunk, score } of scored) {
      const count = perPageCount.get(chunk.pageId) ?? 0;
      if (count >= perPage) continue;
      perPageCount.set(chunk.pageId, count + 1);
      hits.push({
        pageId: chunk.pageId,
        title: chunk.title,
        heading: chunk.heading,
        url: chunk.url,
        snippet: snippet(chunk.text, terms, phrase),
        score: Math.round(score * 100) / 100,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}

/** About 300 characters of the section around the first matching word. */
export function snippet(text: string, terms: readonly string[], phrase = "", radius = 150): string {
  const body = text.replace(/^#{1,6}\s+.*\n?/, "");
  const lower = body.toLowerCase();
  let at = phrase.length > 3 ? lower.indexOf(phrase) : -1;
  if (at < 0) {
    for (const term of terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let index = lower.search(new RegExp(`\\b${escaped}`));
      if (index < 0) index = lower.indexOf(term);
      if (index >= 0 && (at < 0 || index < at)) at = index;
    }
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - radius);
  const end = Math.min(body.length, start + radius * 2);
  const flat = body.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${flat}${end < body.length ? "…" : ""}`;
}
