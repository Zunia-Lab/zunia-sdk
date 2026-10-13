import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { TtlCache } from "./cache.js";
import { type FetchLike, getJson, UpstreamError } from "./fetch.js";
import { DocsSearch, headingAnchor } from "./search.js";

/**
 * The docs this server answers from: `docs-index.json`, which the docs site
 * writes on every build next to llms.txt. Nothing is bundled into this
 * package, so an answer is never older than the published docs.
 */

export const DEFAULT_DOCS_URL = "https://docs.zunialab.com";

export interface DocsPage {
  id: string;
  title: string;
  description: string;
  url: string;
  markdownUrl: string;
  section: string;
  optional: boolean;
  headings: string[];
  markdown: string;
}

export interface DocsSection {
  title: string;
  optional: boolean;
  pages: string[];
}

export interface DocsIndex {
  version: 1;
  site: string;
  title: string;
  summary: string;
  generatedAt: string;
  commit: string | null;
  sections: DocsSection[];
  pages: DocsPage[];
}

export interface LoadedDocs {
  index: DocsIndex;
  search: DocsSearch;
  byId: Map<string, DocsPage>;
  /** Where the index was read: a URL or a file path. */
  source: string;
  /** True when a refresh failed and this is the last copy that loaded. */
  stale: boolean;
}

export class DocsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsUnavailableError";
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Refuses anything that is not a version-1 index, rather than answering from half of one. */
export function parseDocsIndex(value: unknown): DocsIndex {
  const index = value as Partial<DocsIndex> | null;
  if (!index || index.version !== 1 || !Array.isArray(index.pages) || !Array.isArray(index.sections)) {
    throw new DocsUnavailableError("docs-index.json is not a version 1 docs index");
  }
  for (const page of index.pages) {
    const fields = [page?.id, page?.title, page?.url, page?.markdownUrl, page?.section, page?.markdown];
    if (!fields.every(isString)) throw new DocsUnavailableError("docs-index.json has a page without id, title, url or markdown");
  }
  return index as DocsIndex;
}

function load(index: DocsIndex, source: string, stale: boolean): LoadedDocs {
  return {
    index,
    search: new DocsSearch(index.pages),
    byId: new Map(index.pages.map((page) => [page.id, page])),
    source,
    stale,
  };
}

export interface DocsSourceOptions {
  /** A docs build directory holding docs-index.json. Wins over `url`. */
  dir?: string;
  /** The docs site. Default https://docs.zunialab.com. */
  url?: string;
  /** How long a fetched index is reused. Default 5 minutes. */
  ttlMs?: number;
  fetch?: FetchLike;
}

export class DocsSource {
  private readonly url: string;
  private readonly cache: TtlCache<LoadedDocs>;
  private local?: { mtimeMs: number; docs: LoadedDocs };

  constructor(private readonly options: DocsSourceOptions = {}) {
    this.url = (options.url ?? DEFAULT_DOCS_URL).replace(/\/+$/, "");
    this.cache = new TtlCache(options.ttlMs ?? 5 * 60_000);
  }

  get site(): string {
    return this.url;
  }

  async load(): Promise<LoadedDocs> {
    return this.options.dir ? this.loadDir(this.options.dir) : this.loadUrl();
  }

  /** `undefined` instead of an error, for callers that can go on without the docs. */
  async tryLoad(): Promise<LoadedDocs | undefined> {
    try {
      return await this.load();
    } catch {
      return undefined;
    }
  }

  private async loadDir(dir: string): Promise<LoadedDocs> {
    const file = join(dir, "docs-index.json");
    try {
      const { mtimeMs } = await stat(file);
      if (this.local?.mtimeMs === mtimeMs) return this.local.docs;
      const docs = load(parseDocsIndex(JSON.parse(await readFile(file, "utf8"))), file, false);
      this.local = { mtimeMs, docs };
      return docs;
    } catch (error) {
      // A rebuild replaces the file; keep answering from the last good copy meanwhile.
      if (this.local) return { ...this.local.docs, stale: true };
      throw new DocsUnavailableError(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async loadUrl(): Promise<LoadedDocs> {
    const url = `${this.url}/docs-index.json`;
    try {
      const { value, stale } = await this.cache.get("index", async () => {
        const body = await getJson(url, { fetch: this.options.fetch, timeoutMs: 15_000 });
        if (body === null) throw new UpstreamError(url, `${url} was not found`, 404);
        return load(parseDocsIndex(body), url, false);
      });
      return stale ? { ...value, stale } : value;
    } catch (error) {
      throw new DocsUnavailableError(
        `The Zunia docs could not be loaded from ${url} (${error instanceof Error ? error.message : String(error)}). Read ${this.url} directly.`,
      );
    }
  }
}

/** Turns an id, a path or a URL (with or without `.md` or an anchor) into a page id and an anchor. */
export function normalizePageRef(input: string, site: string): { id: string; anchor: string | null } {
  let ref = input.trim();
  const hash = ref.indexOf("#");
  const anchor = hash >= 0 ? ref.slice(hash + 1) || null : null;
  if (hash >= 0) ref = ref.slice(0, hash);
  ref = ref.replace(/\?.*$/, "");
  try {
    const url = new URL(ref);
    if (url.origin === new URL(site).origin) ref = url.pathname;
  } catch {
    // Not a URL: an id or a path.
  }
  ref = ref
    .replace(/^\/+/, "")
    .replace(/^docs\//, "")
    .replace(/\.mdx?$/, "")
    .replace(/\/+$/, "");
  return { id: ref, anchor };
}

export function findPage(docs: LoadedDocs, input: string): { page: DocsPage; anchor: string | null } | null {
  const { id, anchor } = normalizePageRef(input, docs.index.site);
  const exact = docs.byId.get(id);
  if (exact) return { page: exact, anchor };
  const lower = id.toLowerCase();
  const bySegment = docs.index.pages.filter((page) => page.id.split("/").pop()?.toLowerCase() === lower);
  if (bySegment.length === 1 && bySegment[0]) return { page: bySegment[0], anchor };
  const byTitle = docs.index.pages.find((page) => page.title.toLowerCase() === input.trim().toLowerCase());
  return byTitle ? { page: byTitle, anchor } : null;
}

/** The part of a page under one heading, down to the next heading of the same or a higher level. */
export function sectionOf(page: DocsPage, anchor: string): string | null {
  const lines = page.markdown.split("\n");
  const seen = new Map<string, number>();
  let fenced = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading?.[1] || !heading[2]) continue;
    if (start >= 0 && heading[1].length <= level) return lines.slice(start, i).join("\n").trim();
    if (start < 0 && headingAnchor(heading[2], seen) === anchor) {
      start = i;
      level = heading[1].length;
    }
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() : null;
}

/** `@zunialab/…` packages a page mentions, in order of first mention. */
export function packagesIn(markdown: string): string[] {
  return [...new Set(markdown.match(/@zunialab\/[a-z0-9-]+/g) ?? [])];
}

/** The install commands a page's code blocks show (`pnpm add …`, `npm install …`), as written. */
export function installCommandsIn(markdown: string): string[] {
  const commands: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const command = fenced ? /^\s*((?:pnpm add|npm install|npm i|yarn add|bun add)\s+\S.*?)\s*$/.exec(line)?.[1] : undefined;
    if (command && !commands.includes(command)) commands.push(command);
  }
  return commands;
}

/** Docs pages a page links to. */
export function linkedPages(docs: LoadedDocs, page: DocsPage): DocsPage[] {
  const site = docs.index.site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new Map<string, DocsPage>();
  for (const match of page.markdown.matchAll(new RegExp(`${site}/docs/([a-z0-9/_-]+)`, "gi"))) {
    const linked = match[1] ? docs.byId.get(match[1].replace(/\/+$/, "")) : undefined;
    if (linked && linked.id !== page.id) found.set(linked.id, linked);
  }
  return [...found.values()];
}
