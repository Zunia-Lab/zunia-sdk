import { McpServer } from "@modelcontextprotocol/server";
import {
  buildForwardMemo,
  checkAddress,
  DEFAULT_PFM_RETRIES,
  DEFAULT_PFM_TIMEOUT,
  ibcDenomHash,
  isInterchainError,
  MAX_FORWARD_HOPS,
  memoByteLength,
  PACKET_MEMO_MAX_BYTES,
  parseTracePath,
  PFM_INTERMEDIATE_RECEIVER,
} from "@zunialab/interchain";
import {
  explainZuniaError,
  verifySignIn,
  ZUNIA_PROVIDER_ERROR_CODES,
  ZuniaConnectError,
  type ZuniaConnectErrorCode,
  ZuniaSignInError,
} from "@zunialab/sdk-core";
import * as z from "zod/v4";
import { CHAIN_REGISTRY_REPO, ChainRegistry, type ChainLookup, summarizeChain } from "./chains.js";
import {
  type DocsPage,
  DocsSource,
  type DocsSourceOptions,
  findPage,
  installCommandsIn,
  linkedPages,
  type LoadedDocs,
  packagesIn,
  sectionOf,
} from "./docs.js";
import type { FetchLike } from "./fetch.js";
import { installCommand, NpmRegistry, type PackageInfo, ZUNIA_PACKAGES } from "./npm.js";
import { VERSION } from "./version.js";

export interface ZuniaMcpOptions {
  docs?: DocsSourceOptions;
  fetch?: FetchLike;
}

/** The long-lived parts: caches survive across the per-request server instances. */
export interface ZuniaMcpContext {
  docs: DocsSource;
  npm: NpmRegistry;
  chains: ChainRegistry;
}

export function createZuniaMcpContext(options: ZuniaMcpOptions = {}): ZuniaMcpContext {
  return {
    docs: new DocsSource({ fetch: options.fetch, ...options.docs }),
    npm: new NpmRegistry({ fetch: options.fetch }),
    chains: new ChainRegistry({ fetch: options.fetch }),
  };
}

export const SERVER_INSTRUCTIONS = `Zunia is a self-custody multi-chain Cosmos wallet: a browser extension that injects window.zunia, a phone app, and a web dashboard (https://app.zunialab.com) that holds no keys. This server answers from the published Zunia docs (https://docs.zunialab.com), npm and the Zunia chain registry, read live.

To add Zunia to a dApp: call list_integrations, then get_integration_guide for the path you need (quickstart, extension, react, sign-in, qr, walletconnect, suggest-chain, flutter...). Call get_sdk_packages before writing an install command, so the versions are the published ones. Use search_docs for anything else and cite the page URL it returns. Use only APIs the docs show; do not invent methods or options.

Never ask anyone for a recovery phrase or a private key: integrating Zunia never needs one, and keys never leave the wallet.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const CONNECTION_CODES = ["NOT_INSTALLED", "TIMEOUT", "DISCONNECTED", "PAIRING_FAILED", "SESSION_EXPIRED", "NETWORK"] as const;
const SIGN_IN_CODES = [
  "INVALID_MESSAGE",
  "DOMAIN_MISMATCH",
  "URI_MISMATCH",
  "NONCE_MISMATCH",
  "CHAIN_MISMATCH",
  "ADDRESS_MISMATCH",
  "ISSUED_IN_FUTURE",
  "TOO_OLD",
  "EXPIRED",
  "NOT_YET_VALID",
  "UNSUPPORTED_KEY",
  "KEY_MISMATCH",
  "INVALID_SIGNATURE",
] as const;
const CONNECT_CODES: readonly string[] = [...ZUNIA_PROVIDER_ERROR_CODES, ...CONNECTION_CODES];

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function reply(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return structuredContent ? { content: [{ type: "text", text }], structuredContent } : { content: [{ type: "text", text }] };
}

function refuse(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function builtLine(docs: LoadedDocs): string {
  const { generatedAt, commit } = docs.index;
  const stale = docs.stale ? " The docs site could not be reached just now, so this is the last copy that loaded." : "";
  return `Zunia docs built ${generatedAt.slice(0, 16).replace("T", " ")} UTC${commit ? ` from commit ${commit}` : ""}.${stale}`;
}

/** Integration paths: every page of the docs' Integrate section, plus the quickstart. */
export function integrationsOf(docs: LoadedDocs): { key: string; page: DocsPage }[] {
  let pages = docs.index.pages.filter((page) => page.section === "Integrate" || page.id === "get-started/quickstart");
  if (!pages.some((page) => page.section === "Integrate")) {
    pages = docs.index.pages.filter((page) => page.id.startsWith("integrate/") || page.id === "get-started/quickstart");
  }
  const keys = new Map<string, number>();
  for (const page of pages) {
    const key = page.id.split("/").pop() ?? page.id;
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  return pages.map((page) => {
    const key = page.id.split("/").pop() ?? page.id;
    return { key: (keys.get(key) ?? 0) > 1 ? page.id : key, page };
  });
}

function packageLine(info: PackageInfo | { name: string; error: string }): string {
  if ("error" in info) return `- ${info.name}: npm could not be read (${info.error})`;
  if (!info.published) return `- ${info.name}: not on npm yet`;
  const date = info.publishedAt ? `, published ${info.publishedAt.slice(0, 10)}` : "";
  const peers = Object.entries(info.peerDependencies ?? {})
    .map(([peer, range]) => `${peer} ${range}${info.optionalPeers?.includes(peer) ? " (optional)" : ""}`)
    .join(", ");
  return `- ${info.name} ${info.latest}${date}: ${info.description ?? ""}${peers ? `\n  Peer dependencies: ${peers}` : ""}\n  ${info.npm}`;
}

async function withDocs(context: ZuniaMcpContext, run: (docs: LoadedDocs) => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  let docs: LoadedDocs;
  try {
    docs = await context.docs.load();
  } catch (error) {
    return refuse(messageOf(error));
  }
  return run(docs);
}

/** A fresh server over long-lived caches. HTTP builds one per request; stdio one per connection. */
export async function createZuniaMcpServer(context: ZuniaMcpContext): Promise<McpServer> {
  const server = new McpServer(
    { name: "zunia", title: "Zunia", version: VERSION, websiteUrl: "https://docs.zunialab.com/docs/get-started/ai" },
    { instructions: SERVER_INSTRUCTIONS, maxToolInputElements: 2_000 },
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search the Zunia docs",
      description:
        "Full-text search of the Zunia documentation (docs.zunialab.com): integration guides, the window.zunia provider, the JS SDK API, events, errors, the zunia.connect.v2 QR protocol, the security model and how to use the wallet. Returns the best sections with their URLs. Read a page in full with get_doc.",
      inputSchema: z.object({
        query: z.string().min(2).max(200).describe('Words or an identifier, e.g. "restore the session after a reload" or "getOfflineSignerFor"'),
        limit: z.number().int().min(1).max(10).optional().describe("How many results. Default 5"),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, limit }) =>
      withDocs(context, (docs) => {
        const hits = docs.search.search(query, limit ?? 5);
        if (hits.length === 0) {
          return reply(`No section of the Zunia docs matches "${query}". Try other words, or list_docs for every page.\n${builtLine(docs)}`);
        }
        const lines = hits.map(
          (hit, i) =>
            `${i + 1}. ${hit.title}${hit.heading ? ` > ${hit.heading}` : ""}\n   ${hit.url}\n   page id: ${hit.pageId}\n   ${hit.snippet}`,
        );
        return reply(`${lines.join("\n\n")}\n\n${builtLine(docs)}`, {
          query,
          results: hits.map(({ pageId, title, heading, url, snippet }) => ({ page: pageId, title, heading, url, snippet })),
        });
      }),
  );

  server.registerTool(
    "get_doc",
    {
      title: "Read a Zunia docs page",
      description:
        'Returns one page of the Zunia docs as Markdown. Accepts a page id ("integrate/react"), a path ("/docs/integrate/react") or a full docs.zunialab.com URL. With an anchor ("integrate/react#restore-after-a-reload") only that section is returned.',
      inputSchema: z.object({
        page: z.string().min(1).max(300).describe("Page id, path or URL, optionally with #anchor"),
      }),
      annotations: READ_ONLY,
    },
    async ({ page: ref }) =>
      withDocs(context, (docs) => {
        const found = findPage(docs, ref);
        if (!found) {
          const guesses = docs.search
            .search(ref.replace(/[/#._-]+/g, " "), 5, 1)
            .map((hit) => `- ${hit.pageId}: ${hit.title}`)
            .join("\n");
          return refuse(`No Zunia docs page "${ref}".${guesses ? ` Closest pages:\n${guesses}` : " Call list_docs for every page."}`);
        }
        const { page, anchor } = found;
        const section = anchor ? sectionOf(page, anchor) : null;
        const head = `URL: ${page.url}${section ? `#${anchor}` : ""}\nMarkdown: ${page.markdownUrl}\nSection of the docs: ${page.section}\n${builtLine(docs)}`;
        if (anchor && !section) return reply(`${head}\n\n(No heading #${anchor} on this page; here is the whole page.)\n\n${page.markdown}`);
        return reply(`${head}\n\n${section ? `From "${page.title}":\n\n${section}` : page.markdown}`);
      }),
  );

  server.registerTool(
    "list_docs",
    {
      title: "List the Zunia docs pages",
      description: "Every page of the Zunia docs, grouped as on the site, with a one-line description and its id for get_doc.",
      annotations: READ_ONLY,
    },
    async () =>
      withDocs(context, (docs) => {
        const blocks = docs.index.sections.map((section) => {
          const pages = section.pages.flatMap((id) => {
            const page = docs.byId.get(id);
            return page ? [`- ${page.title} (id: ${page.id})${page.description ? `: ${page.description}` : ""}`] : [];
          });
          return `## ${section.title}${section.optional ? " (optional)" : ""}\n${pages.join("\n")}`;
        });
        return reply(`# ${docs.index.title}\n\n${docs.index.summary}\n\n${blocks.join("\n\n")}\n\n${builtLine(docs)}`);
      }),
  );

  server.registerTool(
    "list_integrations",
    {
      title: "List the ways to integrate Zunia",
      description:
        "The integration paths the Zunia docs cover (extension, React, sign-in, events, QR pairing, WalletConnect, chain suggestion, Flutter, troubleshooting, and the quickstart), each with the @zunialab packages it uses. Pass a key to get_integration_guide.",
      annotations: READ_ONLY,
    },
    async () =>
      withDocs(context, (docs) => {
        const items = integrationsOf(docs).map(({ key, page }) => ({
          key,
          title: page.title,
          description: page.description,
          url: page.url,
          packages: packagesIn(page.markdown),
        }));
        const lines = items.map(
          (item) =>
            `- ${item.key}: ${item.title}${item.description ? `. ${item.description}` : ""}${item.packages.length ? `\n  Packages: ${item.packages.join(", ")}` : ""}\n  ${item.url}`,
        );
        return reply(`${lines.join("\n")}\n\n${builtLine(docs)}`, { integrations: items });
      }),
  );

  server.registerTool(
    "get_integration_guide",
    {
      title: "Get a Zunia integration guide",
      description:
        "The full guide for one integration path, with the @zunialab packages it uses at their latest npm versions, the install command, and the reference pages it links to. Keys come from list_integrations (e.g. quickstart, extension, react, sign-in, qr, walletconnect, suggest-chain, flutter).",
      inputSchema: z.object({
        integration: z.string().min(1).max(100).describe('A key from list_integrations, e.g. "react" or "sign-in"'),
      }),
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async ({ integration }) =>
      withDocs(context, async (docs) => {
        const all = integrationsOf(docs);
        const wanted = integration.trim().toLowerCase();
        const match =
          all.find(({ key, page }) => key.toLowerCase() === wanted || page.id.toLowerCase() === wanted) ??
          all.find(({ page }) => page.title.toLowerCase() === wanted) ??
          (() => {
            const ids = new Set(all.map(({ page }) => page.id));
            const best = docs.search.search(integration, 10, 1).find((hit) => ids.has(hit.pageId));
            return best ? all.find(({ page }) => page.id === best.pageId) : undefined;
          })();
        if (!match) {
          return refuse(`No integration "${integration}". Known keys: ${all.map(({ key }) => key).join(", ")}.`);
        }
        const { key, page } = match;
        // The guide's own install line wins; the versions come from npm either way.
        const written = installCommandsIn(page.markdown);
        const installed = packagesIn(written.join("\n"));
        const names = installed.length ? installed : packagesIn(page.markdown);
        const infos = names.length ? await context.npm.getMany(names) : [];
        const published = infos.filter((info): info is PackageInfo => !("error" in info));
        const install = written.length ? written.join(" && ") : installCommand(published);
        const related = linkedPages(docs, page)
          .map((linked) => `- ${linked.title}: ${linked.url} (get_doc "${linked.id}")`)
          .join("\n");
        const parts = [
          `# Integration guide: ${page.title} (${key})`,
          `URL: ${page.url}\n${builtLine(docs)}`,
          infos.length ? `## Packages, latest on npm\n${infos.map(packageLine).join("\n")}${install ? `\n\nInstall: \`${install}\`` : ""}` : "",
          related ? `## Pages this guide links to\n${related}` : "",
          `## The guide\n\n${page.markdown}`,
        ];
        return reply(parts.filter(Boolean).join("\n\n"));
      }),
  );

  server.registerTool(
    "get_sdk_packages",
    {
      title: "Zunia packages on npm",
      description:
        "The @zunialab packages, read live from the npm registry: latest version, publish date, description and peer dependencies. Call it before writing an install command or a version range.",
      outputSchema: z.object({
        packages: z.array(
          z.object({
            name: z.string(),
            published: z.boolean().optional(),
            latest: z.string().optional(),
            publishedAt: z.string().optional(),
            description: z.string().optional(),
            peerDependencies: z.record(z.string(), z.string()).optional(),
            optionalPeers: z.array(z.string()).optional(),
            npm: z.string().optional(),
            error: z.string().optional(),
          }),
        ),
      }),
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async () => {
      const docs = await context.docs.tryLoad();
      const mentioned = docs ? docs.index.pages.flatMap((page) => packagesIn(page.markdown)) : [];
      const infos = await context.npm.getMany([...new Set<string>([...ZUNIA_PACKAGES, ...mentioned])]);
      return reply(
        `Zunia packages, read now from registry.npmjs.org:\n\n${infos.map(packageLine).join("\n")}\n\nThe Flutter package is documented at https://docs.zunialab.com/docs/integrate/flutter.`,
        { packages: infos.map((info) => ({ ...info })) },
      );
    },
  );

  server.registerTool(
    "get_chain",
    {
      title: "Look up a chain in the Zunia registry",
      description:
        'A chain\'s entry in the Zunia chain registry, the catalogue Zunia wallets are built from: chain id, RPC/REST, bech32 prefix, coin type, stake and fee currencies, features. Accepts a chain id ("osmosis-1"), a registry name ("osmosis") or a CAIP-2 id ("eip155:1"). A chain that is not there can still be suggested to the wallet by a dApp.',
      inputSchema: z.object({
        chain: z.string().min(1).max(100).describe('Chain id, registry name or CAIP-2 id, e.g. "cosmoshub-4"'),
        full: z.boolean().optional().describe("Return the whole registry file (every currency). Default false"),
      }),
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async ({ chain, full }) => {
      let found: { lookup: ChainLookup | null; tried: string[] };
      try {
        found = await context.chains.find(chain);
      } catch (error) {
        return refuse(`The Zunia chain registry could not be read: ${messageOf(error)}. Browse ${CHAIN_REGISTRY_REPO}.`);
      }
      if (!found.lookup) {
        const docs = await context.docs.tryLoad();
        const suggest = docs?.index.pages.find((page) => page.id === "integrate/suggest-chain");
        return refuse(
          `"${chain}" is not in the Zunia chain registry${found.tried.length ? ` (looked for ${found.tried.join(", ")})` : ""}. Pass the chain id, e.g. "cosmoshub-4". A dApp can still ask the wallet to add a chain${suggest ? `: ${suggest.url}` : "."} Registry: ${CHAIN_REGISTRY_REPO}`,
        );
      }
      const body = full ? found.lookup.chain : summarizeChain(found.lookup);
      return reply(
        `${found.lookup.chain.chainName} (${found.lookup.chain.chainId}) is in the Zunia chain registry, the catalogue Zunia wallets are built from.\n\n${JSON.stringify(body, null, 2)}`,
      );
    },
  );

  server.registerTool(
    "explain_error",
    {
      title: "Explain a Zunia error",
      description:
        "What a Zunia error code means and what to do next, in the SDK's own words (explainZuniaError), plus the docs lines that mention it. Takes a ZuniaConnectError code (USER_REJECTED, LOCKED, UNSUPPORTED, TIMEOUT...), a verifySignIn code (DOMAIN_MISMATCH, TOO_OLD...), or the error message a wallet returned. With no argument, lists every code.",
      inputSchema: z.object({
        code: z.string().max(60).optional().describe('An error code, e.g. "UNSUPPORTED"'),
        message: z.string().max(2000).optional().describe("The error message, when you have it"),
      }),
      annotations: READ_ONLY,
    },
    async ({ code, message }) => {
      const docs = await context.docs.tryLoad();
      const mentions = (needle: string) => {
        if (!docs) return "";
        const lines: string[] = [];
        for (const page of docs.index.pages) {
          for (const line of page.markdown.split("\n")) {
            if (line.includes(needle) && lines.length < 6) lines.push(`- ${line.trim().slice(0, 300)} (${page.url})`);
          }
        }
        return lines.length ? `\n\nIn the docs:\n${lines.join("\n")}` : "";
      };

      if (!code && !message) {
        const describe = (name: string) => {
          const copy = explainZuniaError(new ZuniaConnectError(name as ZuniaConnectErrorCode, ""));
          return `- ${name}: ${copy.title}. ${copy.message}${copy.retryable ? " (retryable)" : ""}`;
        };
        return reply(
          [
            "Codes on a ZuniaConnectError (every transport: extension, QR, WalletConnect):",
            ...CONNECT_CODES.map(describe),
            "",
            `Codes verifySignIn throws on your server (ZuniaSignInError): ${SIGN_IN_CODES.join(", ")}.`,
            docs?.byId.get("reference/errors") ? `\nReference: ${docs.byId.get("reference/errors")?.url}` : "",
          ].join("\n"),
        );
      }

      const upper = code?.trim().toUpperCase();
      if (upper && (SIGN_IN_CODES as readonly string[]).includes(upper)) {
        return reply(
          `${upper} is a ZuniaSignInError code: verifySignIn refused the sign-in on your server. Its message says which check failed; it is safe to log but should not be echoed to the client.${mentions(upper)}`,
        );
      }
      if (upper && !CONNECT_CODES.includes(upper) && !message) {
        return refuse(`"${code}" is not a Zunia error code. Call explain_error with no argument for the list.${mentions(code ?? "")}`);
      }
      // As a wallet would throw it, so the SDK can read a reason (blind signing, stale page...) from the message.
      let explained = explainZuniaError(Object.assign(new Error(message ?? ""), upper ? { code: upper } : {}));
      if (upper && CONNECT_CODES.includes(upper) && explained.code !== upper) {
        // Connection codes (TIMEOUT, NETWORK...) come from the SDK itself, never from a wallet.
        explained = explainZuniaError(new ZuniaConnectError(upper as ZuniaConnectErrorCode, message ?? ""));
      }
      return reply(
        `${explained.code}${explained.reason ? ` (reason: ${explained.reason})` : ""}: ${explained.title}\n${explained.message}\nRetryable: ${explained.retryable ? "yes" : "no"}${mentions(explained.code)}`,
        { ...explained },
      );
    },
  );

  server.registerTool(
    "verify_sign_in",
    {
      title: "Check a Sign in with Zunia result",
      description:
        "Runs the SDK's verifySignIn on a sign-in your app captured, as your server would, and says which check failed if any: signature, key, address, domain, URI, nonce, chain and dates. Nothing is stored. Use it to debug a server-side sign-in check.",
      inputSchema: z.object({
        message: z.string().min(1).max(4000).describe("The exact text the wallet signed"),
        signature: z
          .object({
            pub_key: z.object({ type: z.string().max(100), value: z.string().max(200) }),
            signature: z.string().max(200),
          })
          .describe("What session.signIn() returned: { pub_key: { type, value }, signature }, base64"),
        domain: z.string().min(1).max(255).describe("The host your site is served on, e.g. app.example.com"),
        nonce: z.string().min(1).max(200).describe("The nonce your server issued"),
        chain_id: z.string().max(100).optional().describe("Require this chain"),
        address: z.string().max(200).optional().describe("Require this address"),
        max_age_minutes: z.number().positive().max(525_600).optional().describe("Oldest Issued At to accept. Default 10, as verifySignIn"),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
        address: z.string().optional(),
        chainId: z.string().optional(),
        issuedAt: z.string().optional(),
        expirationTime: z.string().optional(),
        code: z.string().optional(),
        reason: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ message, signature, domain, nonce, chain_id, address, max_age_minutes }) => {
      try {
        const verified = verifySignIn({
          message,
          signature,
          domain,
          nonce,
          ...(chain_id ? { chainId: chain_id } : {}),
          ...(address ? { address } : {}),
          ...(max_age_minutes ? { maxAgeMs: max_age_minutes * 60_000 } : {}),
        });
        const result = {
          ok: true,
          address: verified.address,
          chainId: verified.chainId,
          issuedAt: verified.issuedAt,
          ...(verified.expirationTime ? { expirationTime: verified.expirationTime } : {}),
        };
        return reply(`Valid. ${verified.address} signed in to ${verified.domain} on ${verified.chainId}, issued ${verified.issuedAt}.`, result);
      } catch (error) {
        const code = error instanceof ZuniaSignInError ? error.code : "INVALID_MESSAGE";
        return reply(`Refused: ${code}. ${messageOf(error)}`, { ok: false, code, reason: messageOf(error) });
      }
    },
  );

  server.registerTool(
    "ibc_denom",
    {
      title: "Compute an IBC denom",
      description:
        'The ibc/HASH denom a token gets after it travels a trace path, computed with @zunialab/interchain (sha256 of "path/base_denom"). Example: path "transfer/channel-0", base_denom "uatom".',
      inputSchema: z.object({
        path: z.string().max(500).describe('Port/channel pairs the token traveled, receiving side, e.g. "transfer/channel-0". Empty for a native token'),
        base_denom: z.string().min(1).max(200).describe('The denom on its origin chain, e.g. "uatom"'),
      }),
      outputSchema: z.object({ denom: z.string(), path: z.string(), baseDenom: z.string(), hops: z.number() }),
      annotations: READ_ONLY,
    },
    async ({ path, base_denom }) => {
      try {
        const hops = parseTracePath(path);
        const denom = hops.length ? await ibcDenomHash(path, base_denom) : base_denom.trim();
        return reply(
          hops.length ? `${denom}\n(${hops.length} hop${hops.length > 1 ? "s" : ""}: ${path.trim()}/${base_denom.trim()})` : `${denom} (no path: a native denom keeps its name)`,
          { denom, path: path.trim(), baseDenom: base_denom.trim(), hops: hops.length },
        );
      } catch (error) {
        return refuse(isInterchainError(error) ? error.message : messageOf(error));
      }
    },
  );

  server.registerTool(
    "build_forward_memo",
    {
      title: "Build a packet-forward memo",
      description: `The packet-forward-middleware memo for a multi-hop IBC transfer, built and validated by @zunialab/interchain. Hops are in execution order: hops[0] is the channel the first destination chain forwards over. Only the last hop carries the receiver; earlier hops get "${PFM_INTERMEDIATE_RECEIVER}". Every chain the funds pass through must run packet-forward-middleware.`,
      inputSchema: z.object({
        receiver: z.string().min(1).max(200).describe("Address that receives the funds on the final chain"),
        hops: z
          .array(
            z.object({
              channel: z.string().min(1).max(64).describe('Channel the hop leaves over, e.g. "channel-141"'),
              port: z.string().max(64).optional().describe('Default "transfer"'),
              timeout: z.string().max(20).optional().describe('Go duration, e.g. "10m"'),
              retries: z.number().int().min(0).max(255).optional(),
            }),
          )
          .min(1)
          .max(MAX_FORWARD_HOPS),
        timeout: z.string().max(20).optional().describe(`Go duration for every hop without its own. Default "${DEFAULT_PFM_TIMEOUT}"`),
        retries: z.number().int().min(0).max(255).optional().describe(`Retries for every hop without its own. Default ${DEFAULT_PFM_RETRIES}`),
      }),
      outputSchema: z.object({ memo: z.string(), bytes: z.number(), maxBytes: z.number() }),
      annotations: READ_ONLY,
    },
    async ({ receiver, hops, timeout, retries }) => {
      try {
        const memo = buildForwardMemo(
          hops.map((hop) => ({
            channelId: hop.channel,
            ...(hop.port ? { port: hop.port } : {}),
            ...(hop.timeout ? { timeout: hop.timeout } : {}),
            ...(hop.retries !== undefined ? { retries: hop.retries } : {}),
          })),
          receiver,
          { ...(timeout ? { timeout } : {}), ...(retries !== undefined ? { retries } : {}) },
        );
        const bytes = memoByteLength(memo);
        return reply(
          `Put this string in the memo of the MsgTransfer you sign (${bytes} of ${PACKET_MEMO_MAX_BYTES} bytes):\n\n${memo}\n\nA memo the middleware cannot act on stops the tokens on an intermediate chain, so check every channel before signing.`,
          { memo, bytes, maxBytes: PACKET_MEMO_MAX_BYTES },
        );
      } catch (error) {
        return refuse(isInterchainError(error) ? error.message : messageOf(error));
      }
    },
  );

  server.registerTool(
    "check_address",
    {
      title: "Check an address for a chain",
      description:
        "Checks a bech32 address (structure and checksum) and, given a chain, that its prefix is exactly that chain's, using @zunialab/interchain and the Zunia chain registry.",
      inputSchema: z.object({
        address: z.string().min(1).max(200),
        chain: z.string().max(100).optional().describe('Chain id or registry name, e.g. "osmosis-1"'),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
        problem: z.string(),
        prefix: z.string().nullable(),
        expectedPrefix: z.string().optional(),
        chainId: z.string().optional(),
      }),
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async ({ address, chain }) => {
      let expected: { chainId: string; chainName: string; prefix: string } | undefined;
      if (chain) {
        try {
          const { lookup } = await context.chains.find(chain);
          const prefix = lookup?.chain.bech32Config?.bech32PrefixAccAddr;
          if (!lookup || !prefix) return refuse(`"${chain}" is not a Cosmos chain in the Zunia chain registry.`);
          expected = { chainId: lookup.chain.chainId, chainName: lookup.chain.chainName, prefix };
        } catch (error) {
          return refuse(`The Zunia chain registry could not be read: ${messageOf(error)}`);
        }
      }
      const check = checkAddress(address, {
        chainId: expected?.chainId ?? "",
        chainName: expected?.chainName ?? "",
        bech32Prefix: expected?.prefix ?? "",
        coinType: 118,
        coinDenom: "",
        coinMinimalDenom: "",
        coinDecimals: 0,
        feeDenom: "",
        feeMinimalDenom: "",
        feeDecimals: 0,
      });
      // Without a chain only the checksum counts: any prefix is "wrong" against an empty one.
      const ok = expected ? check.ok : check.problem === "ok" || check.problem === "wrong-prefix";
      const problem = expected ? check.problem : ok ? "ok" : check.problem;
      const words: Record<string, string> = {
        ok: expected ? `valid ${expected.chainName} address` : `valid bech32 address with prefix "${check.prefix}"`,
        empty: "empty",
        malformed: "not a bech32 address",
        "bad-checksum": "bech32-shaped but the checksum is wrong: a character was mistyped",
        "wrong-prefix": `prefix "${check.prefix}", but ${expected?.chainName} addresses start with "${expected?.prefix}"`,
      };
      return reply(`${ok ? "Valid" : "Invalid"}: ${words[problem] ?? problem}.`, {
        ok,
        problem,
        prefix: check.prefix,
        ...(expected ? { expectedPrefix: expected.prefix, chainId: expected.chainId } : {}),
      });
    },
  );

  server.registerPrompt(
    "integrate_zunia",
    {
      title: "Add Zunia to this app",
      description: "Plan and write a Zunia integration for the current project, from the live docs.",
      argsSchema: z.object({
        stack: z.string().max(200).optional().describe('The app, e.g. "Next.js app router", "Vite + React", "plain TypeScript", "Flutter"'),
        features: z.string().max(300).optional().describe('What it needs, e.g. "connect, sign-in, send tokens, QR for phones"'),
      }),
    },
    ({ stack, features }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Add the Zunia wallet to this ${stack?.trim() || "app"}${features?.trim() ? ` for: ${features.trim()}` : ""}.

Work from the Zunia MCP tools, not from memory:
1. list_integrations, then get_integration_guide for each path this needs (start with "quickstart" if unsure).
2. get_sdk_packages for the published versions before you add dependencies.
3. search_docs or get_doc for anything the guides do not cover; cite the URL you used.
4. If the app signs transactions, read how the session hands CosmJS a signer, and handle errors with explainZuniaError (explain_error lists the codes).
5. If the app checks sign-in on a server, use verifySignIn from @zunialab/sdk-core with a fresh nonce per attempt.

Show the plan first: files to change, packages to add, and what the user will see. Never ask for or handle a recovery phrase or private key.`,
          },
        },
      ],
    }),
  );

  // Each docs page as a resource, for clients that attach resources to the context.
  const docs = await context.docs.tryLoad();
  for (const page of docs?.index.pages ?? []) {
    server.registerResource(
      page.id,
      page.markdownUrl,
      { title: page.title, description: page.description || undefined, mimeType: "text/markdown" },
      async (uri) => {
        const latest = await context.docs.tryLoad();
        const current = latest?.byId.get(page.id) ?? page;
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: current.markdown }] };
      },
    );
  }

  return server;
}
