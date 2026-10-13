import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocsIndex, DocsPage } from "./docs.js";
import type { FetchLike } from "./fetch.js";

const SITE = "https://docs.zunialab.com";

function page(id: string, title: string, section: string, markdown: string, description = ""): DocsPage {
  return {
    id,
    title,
    description,
    url: `${SITE}/docs/${id}`,
    markdownUrl: `${SITE}/docs/${id}.md`,
    section,
    optional: false,
    headings: [],
    markdown,
  };
}

/** A small docs index shaped like the one the docs site writes. */
export function fixtureIndex(): DocsIndex {
  const pages = [
    page(
      "get-started/quickstart",
      "Quickstart",
      "Get started",
      "# Connect a site in five minutes\n\nInstall:\n\n```bash\npnpm add @zunialab/sdk-react @zunialab/sdk-web\n```\n\n## 1. Connect\n\nCall `useZuniaSession`.\n\n## 2. Sign in\n\nSee [Sign in with Zunia](https://docs.zunialab.com/docs/integrate/sign-in).\n",
      "Connect a React app to Zunia.",
    ),
    page(
      "integrate/react",
      "React",
      "Integrate",
      "# React\n\n`@zunialab/sdk-react` is a thin layer on `@zunialab/sdk-web`.\n\n## Restore after a reload\n\n`useZuniaSession({ restore })` restores the previous session without a prompt.\n\n## Events\n\nThe hook re-renders on account switches.\n\n```ts\n## not a heading, inside code\n```\n\n## Events\n\nA second section with the same title.\n\nSee the [SDK API](https://docs.zunialab.com/docs/reference/sdk).\n",
      "React hooks and components.",
    ),
    page(
      "integrate/sign-in",
      "Sign in with Zunia",
      "Integrate",
      "# Sign in with Zunia\n\nNo transaction and no fee. Your server checks the result with `verifySignIn` from `@zunialab/sdk-core`.\n\n## Nonce\n\nIssue a fresh nonce per attempt.\n",
      "Know which account is at the keyboard.",
    ),
    page(
      "reference/sdk",
      "SDK API",
      "Reference",
      "# SDK API\n\n## Session\n\n`session.getOfflineSignerFor(chainId, { messages, memo })` hands CosmJS a signer.\n\nThe extension build runs `pnpm --filter @zunialab/ui build` first.\n",
      "Three packages, one session.",
    ),
    page(
      "reference/errors",
      "Errors",
      "Reference",
      "# Errors\n\n| Code | Meaning |\n|---|---|\n| `LOCKED` | The wallet is locked. |\n| `DOMAIN_MISMATCH` | The sign-in names another domain. |\n",
      "Every transport rejects with ZuniaConnectError.",
    ),
  ];
  return {
    version: 1,
    site: SITE,
    title: "Zunia Docs",
    summary: "How to connect a dApp to Zunia.",
    generatedAt: "2026-10-14T00:00:00.000Z",
    commit: "abc123def456",
    sections: [
      { title: "Get started", optional: false, pages: ["get-started/quickstart"] },
      { title: "Integrate", optional: false, pages: ["integrate/react", "integrate/sign-in"] },
      { title: "Reference", optional: false, pages: ["reference/sdk", "reference/errors"] },
    ],
    pages,
  };
}

/** A temporary docs build directory holding the fixture index. */
export function fixtureDocsDir(index: DocsIndex = fixtureIndex()): string {
  const dir = mkdtempSync(join(tmpdir(), "zunia-mcp-docs-"));
  writeFileSync(join(dir, "docs-index.json"), JSON.stringify(index));
  return dir;
}

export const OSMOSIS = {
  chainId: "osmosis-1",
  chainName: "Osmosis",
  rpc: "https://rpc.example",
  rest: "https://rest.example",
  bip44: { coinType: 118 },
  bech32Config: { bech32PrefixAccAddr: "osmo", bech32PrefixValAddr: "osmovaloper" },
  stakeCurrency: { coinDenom: "OSMO", coinMinimalDenom: "uosmo", coinDecimals: 6 },
  currencies: [{ coinDenom: "OSMO", coinMinimalDenom: "uosmo", coinDecimals: 6 }],
  feeCurrencies: [{ coinDenom: "OSMO", coinMinimalDenom: "uosmo", coinDecimals: 6 }],
  features: ["cosmwasm"],
};

/** Answers npm and the chain registry from memory, and counts what was asked. */
export function fakeUpstreams(): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://registry.npmjs.org/@zunialab%2Fsdk-web") {
      return json({
        description: "Connect a web dApp to the Zunia wallet",
        "dist-tags": { latest: "0.1.1" },
        time: { "0.1.1": "2026-10-14T08:00:00.000Z" },
        versions: {
          "0.1.1": {
            description: "Connect a web dApp to the Zunia wallet",
            peerDependencies: { "@walletconnect/sign-client": "^2.17.0" },
            peerDependenciesMeta: { "@walletconnect/sign-client": { optional: true } },
          },
        },
      });
    }
    if (url.startsWith("https://registry.npmjs.org/@zunialab%2Fsdk-")) {
      return json({ "dist-tags": { latest: "0.1.1" }, versions: { "0.1.1": { description: "A Zunia SDK package" } } });
    }
    if (url.startsWith("https://registry.npmjs.org/")) return json({ error: "Not found" }, 404);
    if (url.endsWith("/cosmos/osmosis.json")) return json(OSMOSIS);
    if (url.startsWith("https://raw.githubusercontent.com/")) return new Response("404: Not Found", { status: 404 });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch: fetchImpl, calls };
}
