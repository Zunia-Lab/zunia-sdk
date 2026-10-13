import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TtlCache } from "./cache.js";
import {
  DocsSource,
  DocsUnavailableError,
  findPage,
  installCommandsIn,
  linkedPages,
  normalizePageRef,
  packagesIn,
  parseDocsIndex,
  sectionOf,
} from "./docs.js";
import { fixtureDocsDir, fixtureIndex } from "./test-support.js";

const SITE = "https://docs.zunialab.com";

test("normalizePageRef accepts ids, paths and URLs", () => {
  for (const input of [
    "integrate/react",
    "/docs/integrate/react",
    "docs/integrate/react/",
    "https://docs.zunialab.com/docs/integrate/react",
    "https://docs.zunialab.com/docs/integrate/react.md",
    "https://docs.zunialab.com/docs/integrate/react?x=1",
  ]) {
    assert.deepEqual(normalizePageRef(input, SITE), { id: "integrate/react", anchor: null }, input);
  }
  assert.deepEqual(normalizePageRef("integrate/react#events-1", SITE), { id: "integrate/react", anchor: "events-1" });
});

test("findPage falls back to a unique last segment, then the title", async () => {
  const docs = await new DocsSource({ dir: fixtureDocsDir() }).load();
  assert.equal(findPage(docs, "react")?.page.id, "integrate/react");
  assert.equal(findPage(docs, "Sign in with Zunia")?.page.id, "integrate/sign-in");
  assert.equal(findPage(docs, "nope"), null);
});

test("sectionOf returns one heading's section and respects repeats", () => {
  const react = fixtureIndex().pages.find((page) => page.id === "integrate/react");
  assert.ok(react);
  assert.match(sectionOf(react, "restore-after-a-reload") ?? "", /^## Restore after a reload\n[\s\S]*without a prompt\.$/);
  assert.match(sectionOf(react, "events-1") ?? "", /A second section/);
  assert.doesNotMatch(sectionOf(react, "events") ?? "", /A second section/);
  assert.equal(sectionOf(react, "missing"), null);
});

test("packagesIn and linkedPages read what a page uses", async () => {
  const docs = await new DocsSource({ dir: fixtureDocsDir() }).load();
  const quickstart = docs.byId.get("get-started/quickstart");
  assert.ok(quickstart);
  assert.deepEqual(packagesIn(quickstart.markdown), ["@zunialab/sdk-react", "@zunialab/sdk-web"]);
  assert.deepEqual(linkedPages(docs, quickstart).map((page) => page.id), ["integrate/sign-in"]);
});

test("installCommandsIn reads install lines from code blocks only", () => {
  const markdown = "Run pnpm add @zunialab/sdk-web in prose.\n\n```bash\npnpm add @zunialab/sdk-react @zunialab/sdk-web\nnpm install @cosmjs/stargate\n```\n";
  assert.deepEqual(installCommandsIn(markdown), ["pnpm add @zunialab/sdk-react @zunialab/sdk-web", "npm install @cosmjs/stargate"]);
});

test("parseDocsIndex refuses anything but a version 1 index", () => {
  assert.throws(() => parseDocsIndex({ version: 2, pages: [], sections: [] }), DocsUnavailableError);
  assert.throws(() => parseDocsIndex({ version: 1, pages: [{ id: "x" }], sections: [] }), DocsUnavailableError);
  assert.equal(parseDocsIndex(fixtureIndex()).pages.length, 5);
});

test("a local docs build is re-read when the file changes, and kept when it breaks", async () => {
  const dir = fixtureDocsDir();
  const source = new DocsSource({ dir });
  assert.equal((await source.load()).index.commit, "abc123def456");

  const file = join(dir, "docs-index.json");
  writeFileSync(file, JSON.stringify({ ...fixtureIndex(), commit: "fedcba987654" }));
  utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  assert.equal((await source.load()).index.commit, "fedcba987654");

  writeFileSync(file, "{ half a file");
  utimesSync(file, new Date(), new Date(Date.now() + 10_000));
  const kept = await source.load();
  assert.equal(kept.index.commit, "fedcba987654");
  assert.equal(kept.stale, true);
});

test("the docs site is fetched once per TTL, and an outage serves the last copy", async () => {
  let calls = 0;
  let up = true;
  const source = new DocsSource({
    url: "https://docs.example/",
    ttlMs: 0,
    fetch: async (url) => {
      calls++;
      assert.equal(url, "https://docs.example/docs-index.json");
      if (!up) throw new Error("connect ECONNREFUSED");
      return new Response(JSON.stringify(fixtureIndex()), { status: 200 });
    },
  });
  assert.equal((await source.load()).stale, false);
  up = false;
  const stale = await source.load();
  assert.equal(stale.stale, true);
  assert.equal(calls, 2);

  const cold = new DocsSource({ url: "https://docs.example", fetch: async () => new Response("nope", { status: 503 }) });
  await assert.rejects(cold.load(), DocsUnavailableError);
  assert.equal(await cold.tryLoad(), undefined);
});

test("TtlCache shares a running load and expires entries", async () => {
  let now = 0;
  const cache = new TtlCache<number>(1_000, () => now);
  let loads = 0;
  const load = async () => {
    loads++;
    return loads;
  };
  const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);
  assert.equal(a.value, 1);
  assert.equal(b.value, 1);
  assert.equal((await cache.get("k", load)).value, 1);
  now = 1_000;
  assert.equal((await cache.get("k", load)).value, 2);
  now = 2_000;
  const failed = await cache.get("k", async () => {
    throw new Error("down");
  });
  assert.deepEqual(failed, { value: 2, stale: true });
});
