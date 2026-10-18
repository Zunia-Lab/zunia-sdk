import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  adr36SignDoc,
  buildSignInMessage,
  bytesToBase64,
  createNonce,
  pubkeyToAddress,
  serializeAminoSignDoc,
  utf8ToBytes,
} from "@zunialab/sdk-core";
import { RateLimiter, startHttpServer } from "./http.js";
import { createZuniaMcpContext } from "./server.js";
import { fakeUpstreams, fixtureDocsDir } from "./test-support.js";

type TextResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function textOf(result: unknown): string {
  return (result as TextResult).content.map((block) => block.text ?? "").join("\n");
}

function signIn(domain = "app.example.com") {
  const secret = sha256(utf8ToBytes("zunia-mcp-test"));
  const pubKey = secp256k1.getPublicKey(secret, true);
  const address = pubkeyToAddress(pubKey, "cosmos");
  const nonce = createNonce();
  const message = buildSignInMessage({ domain, address, uri: `https://${domain}`, chainId: "cosmoshub-4", nonce });
  const digest = sha256(serializeAminoSignDoc(adr36SignDoc(address, utf8ToBytes(message))));
  const signature = {
    pub_key: { type: "tendermint/PubKeySecp256k1", value: bytesToBase64(pubKey) },
    signature: bytesToBase64(secp256k1.sign(digest, secret, { prehash: false })),
  };
  return { address, nonce, message, signature };
}

const upstreams = fakeUpstreams();
const context = createZuniaMcpContext({ docs: { dir: fixtureDocsDir() }, fetch: upstreams.fetch });
let http: ReturnType<typeof startHttpServer>;
let base: string;

before(async () => {
  http = startHttpServer(context, { port: 0, host: "127.0.0.1", perMinute: 1_000 });
  await new Promise<void>((resolve) => http.server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
});

after(async () => {
  await http.close();
});

for (const era of ["legacy", "modern"] as const) {
  describe(`over HTTP, ${era} protocol`, () => {
    let client: Client;

    before(async () => {
      client = new Client(
        { name: "zunia-mcp-test", version: "1.0.0" },
        { versionNegotiation: { mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" } } },
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    });

    after(async () => {
      await client.close();
    });

    test("introduces itself and lists the tools", async () => {
      assert.equal(client.getServerVersion()?.name, "zunia");
      assert.match(client.getInstructions() ?? "", /list_integrations/);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        "build_forward_memo",
        "check_address",
        "explain_error",
        "get_chain",
        "get_doc",
        "get_integration_guide",
        "get_sdk_packages",
        "ibc_denom",
        "list_docs",
        "list_integrations",
        "search_docs",
        "verify_sign_in",
      ]);
      assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
    });

    test("search_docs and get_doc answer from the docs", async () => {
      const search = await client.callTool({ name: "search_docs", arguments: { query: "restore after a reload" } });
      assert.match(textOf(search), /integrate\/react#restore-after-a-reload/);
      assert.match(textOf(search), /built 2026-10-14 00:00 UTC from commit abc123def456/);

      const page = await client.callTool({ name: "get_doc", arguments: { page: "https://docs.zunialab.com/docs/integrate/react.md" } });
      assert.match(textOf(page), /# React/);

      const section = await client.callTool({ name: "get_doc", arguments: { page: "integrate/react#events-1" } });
      assert.match(textOf(section), /A second section/);
      assert.doesNotMatch(textOf(section), /restores the previous session/);

      const missing = (await client.callTool({ name: "get_doc", arguments: { page: "integrate/nothing-here" } })) as TextResult;
      assert.equal(missing.isError, true);
    });

    test("list_integrations and get_integration_guide carry live package versions", async () => {
      const list = (await client.callTool({ name: "list_integrations", arguments: {} })) as TextResult;
      const keys = (list.structuredContent?.integrations as { key: string }[]).map((item) => item.key);
      assert.deepEqual(keys, ["quickstart", "react", "sign-in"]);

      const guide = await client.callTool({ name: "get_integration_guide", arguments: { integration: "quickstart" } });
      const text = textOf(guide);
      assert.match(text, /@zunialab\/sdk-web 0\.1\.1, published 2026-10-14/);
      assert.match(text, /Install: `pnpm add @zunialab\/sdk-react @zunialab\/sdk-web`/);
      assert.match(text, /Sign in with Zunia: https:\/\/docs\.zunialab\.com\/docs\/integrate\/sign-in/);

      const unknown = (await client.callTool({ name: "get_integration_guide", arguments: { integration: "carrier pigeon" } })) as TextResult;
      assert.equal(unknown.isError, true);
      assert.match(textOf(unknown), /Known keys: quickstart, react, sign-in/);
    });

    test("get_sdk_packages reads npm and reports what is not published", async () => {
      const result = (await client.callTool({ name: "get_sdk_packages", arguments: {} })) as TextResult;
      const packages = result.structuredContent?.packages as { name: string; published?: boolean; latest?: string }[];
      assert.equal(packages.find((info) => info.name === "@zunialab/sdk-web")?.latest, "0.1.1");
      assert.equal(packages.find((info) => info.name === "@zunialab/mcp")?.published, false);
      // Named in the docs' build steps only, and not on npm: an internal package, not listed.
      assert.equal(packages.some((info) => info.name === "@zunialab/ui"), false);
      assert.match(textOf(result), /@walletconnect\/sign-client \^2\.17\.0 \(optional\)/);
      const flutter = packages.find((info) => info.name === "zunia_sdk") as { latest?: string; pub?: string } | undefined;
      assert.equal(flutter?.latest, "0.1.1");
      assert.equal(flutter?.pub, "https://pub.dev/packages/zunia_sdk");
      assert.match(textOf(result), /zunia_sdk 0\.1\.1, published 2026-10-18: Connect Flutter apps to the Zunia wallet: QR pairing and deep links\./);
      assert.match(textOf(result), /Needs Dart \^3\.6\.0, Flutter >=3\.27\.0/);
      assert.match(textOf(result), /flutter pub add zunia_sdk/);
    });

    test("get_chain and check_address read the chain registry", async () => {
      const chain = await client.callTool({ name: "get_chain", arguments: { chain: "osmosis-1" } });
      assert.match(textOf(chain), /"bech32Prefix": "osmo"/);
      const absent = (await client.callTool({ name: "get_chain", arguments: { chain: "nochain-7" } })) as TextResult;
      assert.equal(absent.isError, true);
      const unsafe = (await client.callTool({ name: "get_chain", arguments: { chain: "../../etc/passwd" } })) as TextResult;
      assert.equal(unsafe.isError, true);

      const { address } = signIn();
      const wrong = (await client.callTool({ name: "check_address", arguments: { address, chain: "osmosis-1" } })) as TextResult;
      assert.equal(wrong.structuredContent?.problem, "wrong-prefix");
      const plain = (await client.callTool({ name: "check_address", arguments: { address } })) as TextResult;
      assert.equal(plain.structuredContent?.ok, true);
      const typo = (await client.callTool({ name: "check_address", arguments: { address: `${address.slice(0, -1)}q` } })) as TextResult;
      assert.equal(typo.structuredContent?.ok, false);
    });

    test("explain_error speaks with the SDK's words", async () => {
      const locked = (await client.callTool({ name: "explain_error", arguments: { code: "LOCKED" } })) as TextResult;
      assert.equal(locked.structuredContent?.code, "LOCKED");
      assert.match(textOf(locked), /Wallet locked/);
      const timeout = (await client.callTool({ name: "explain_error", arguments: { code: "timeout" } })) as TextResult;
      assert.equal(timeout.structuredContent?.code, "TIMEOUT");
      const blind = (await client.callTool({
        name: "explain_error",
        arguments: { code: "UNSUPPORTED", message: "Blind signing disabled for unknown messages" },
      })) as TextResult;
      assert.equal(blind.structuredContent?.reason, "blind-signing");
      assert.match(textOf(await client.callTool({ name: "explain_error", arguments: { code: "DOMAIN_MISMATCH" } })), /ZuniaSignInError/);
      assert.match(textOf(await client.callTool({ name: "explain_error", arguments: {} })), /USER_REJECTED/);
    });

    test("verify_sign_in runs verifySignIn", async () => {
      const { message, signature, nonce, address } = signIn();
      const ok = (await client.callTool({
        name: "verify_sign_in",
        arguments: { message, signature, nonce, domain: "app.example.com" },
      })) as TextResult;
      assert.equal(ok.structuredContent?.ok, true);
      assert.equal(ok.structuredContent?.address, address);

      const other = (await client.callTool({
        name: "verify_sign_in",
        arguments: { message, signature, nonce, domain: "evil.example.com" },
      })) as TextResult;
      assert.deepEqual([other.structuredContent?.ok, other.structuredContent?.code], [false, "DOMAIN_MISMATCH"]);
    });

    test("ibc_denom and build_forward_memo use @zunialab/interchain", async () => {
      const atom = (await client.callTool({ name: "ibc_denom", arguments: { path: "transfer/channel-0", base_denom: "uatom" } })) as TextResult;
      assert.equal(atom.structuredContent?.denom, "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2");
      const odd = (await client.callTool({ name: "ibc_denom", arguments: { path: "transfer", base_denom: "uatom" } })) as TextResult;
      assert.equal(odd.isError, true);

      const { address } = signIn();
      const memo = (await client.callTool({
        name: "build_forward_memo",
        arguments: { receiver: address, hops: [{ channel: "channel-141" }] },
      })) as TextResult;
      const parsed = JSON.parse(String(memo.structuredContent?.memo)) as { forward: { receiver: string; channel: string } };
      assert.equal(parsed.forward.receiver, address);
      assert.equal(parsed.forward.channel, "channel-141");
      const sentinel = (await client.callTool({
        name: "build_forward_memo",
        arguments: { receiver: "pfm", hops: [{ channel: "channel-141" }] },
      })) as TextResult;
      assert.equal(sentinel.isError, true);
    });

    test("pages are resources, and the prompt plans from the tools", async () => {
      const { resources } = await client.listResources();
      assert.ok(resources.some((resource) => resource.uri === "https://docs.zunialab.com/docs/integrate/react.md"));
      const read = await client.readResource({ uri: "https://docs.zunialab.com/docs/integrate/react.md" });
      assert.match(String((read.contents[0] as { text?: string }).text), /# React/);

      const { prompts } = await client.listPrompts();
      assert.deepEqual(prompts.map((prompt) => prompt.name), ["integrate_zunia"]);
      const prompt = await client.getPrompt({ name: "integrate_zunia", arguments: { stack: "Vite + React", features: "connect, sign-in" } });
      assert.match(JSON.stringify(prompt.messages), /Vite \+ React for: connect, sign-in/);
    });
  });
}

describe("the HTTP front", () => {
  test("health reports the docs build", async () => {
    const response = await fetch(`${base}/mcp/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; docs: { pages: number; commit: string } };
    assert.deepEqual([body.ok, body.docs.pages, body.docs.commit], [true, 5, "abc123def456"]);
  });

  test("unknown hosts are refused, browsers are sent to the docs, other paths are 404", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, { method: "POST", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(status, 403);

    const browser = await fetch(`${base}/mcp`, { headers: { accept: "text/html" }, redirect: "manual" });
    assert.equal(browser.status, 302);
    assert.equal(browser.headers.get("location"), "https://docs.zunialab.com/docs/get-started/ai");

    assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
    const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  });

  test("the rate limit refills over time", () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    assert.equal(limiter.take("a"), 0);
    assert.equal(limiter.take("a"), 0);
    assert.ok(limiter.take("a") > 0);
    assert.equal(limiter.take("b"), 0);
    now = 30_000;
    assert.equal(limiter.take("a"), 0);
  });
});
