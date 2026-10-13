import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkPage, DocsSearch, headingAnchor, snippet, tokenize } from "./search.js";
import { fixtureIndex } from "./test-support.js";

test("tokenize splits identifiers and drops stopwords", () => {
  const tokens = tokenize("How do I use getOfflineSignerFor with window.zunia?");
  assert.ok(tokens.includes("getofflinesignerfor"));
  assert.ok(tokens.includes("offline"));
  assert.ok(tokens.includes("signer"));
  assert.ok(tokens.includes("zunia"));
  assert.ok(!tokens.includes("how"));
  assert.deepEqual(tokenize("events chains"), ["event", "chain"]);
});

test("headingAnchor follows the site's slugs, numbering repeats", () => {
  const seen = new Map<string, number>();
  assert.equal(headingAnchor("Restore after a reload", seen), "restore-after-a-reload");
  assert.equal(headingAnchor("`window.zunia` events", seen), "windowzunia-events");
  assert.equal(headingAnchor("Events", seen), "events");
  assert.equal(headingAnchor("Events", seen), "events-1");
  assert.equal(headingAnchor("Custom {#my-id}", seen), "my-id");
  assert.equal(headingAnchor("1. Connect", seen), "1-connect");
});

test("chunkPage cuts at ## and ###, skips headings inside code, and counts the H1", () => {
  const react = fixtureIndex().pages.find((page) => page.id === "integrate/react");
  assert.ok(react);
  const chunks = chunkPage(react);
  assert.deepEqual(
    chunks.map((chunk) => chunk.anchor),
    [null, "restore-after-a-reload", "events", "events-1"],
  );
  assert.ok(chunks[2]?.text.includes("not a heading, inside code"));
});

test("search ranks the section that answers, with its anchor", () => {
  const search = new DocsSearch(fixtureIndex().pages);
  const [first] = search.search("restore the session after a reload");
  assert.equal(first?.pageId, "integrate/react");
  assert.equal(first?.url, "https://docs.zunialab.com/docs/integrate/react#restore-after-a-reload");

  const [signer] = search.search("getOfflineSignerFor");
  assert.equal(signer?.pageId, "reference/sdk");
  assert.match(signer?.snippet ?? "", /getOfflineSignerFor/);

  assert.deepEqual(search.search("the of and"), []);
  assert.ok(search.search("zunia", 10, 1).every((hit, i, all) => all.findIndex((other) => other.pageId === hit.pageId) === i));
});

test("snippet centres on the first match and marks cuts", () => {
  const text = `## Title\n\n${"word ".repeat(100)}needle ${"word ".repeat(100)}`;
  const cut = snippet(text, ["needle"], "", 40);
  assert.ok(cut.startsWith("…") && cut.endsWith("…"));
  assert.ok(cut.includes("needle"));
});
