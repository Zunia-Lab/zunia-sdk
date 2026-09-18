import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLcdClient,
  createLcdClientFactory,
  lcdEndpointsFromChain,
  type FetchLike,
  type LcdClientConfig,
} from "./lcd.js";
import { isInterchainError, type ChainInfoLike } from "./types.js";

const CHAIN: ChainInfoLike = {
  chainId: "safrochain-1",
  chainName: "Safrochain",
  bech32Prefix: "addr_safro",
  coinType: 118,
  coinDenom: "SAFRO",
  coinMinimalDenom: "usafro",
  coinDecimals: 6,
  feeDenom: "SAFRO",
  feeMinimalDenom: "usafro",
  feeDecimals: 6,
  rest: "https://api.safrochain.example/",
  features: ["cosmwasm"],
};

interface Recorder {
  readonly urls: string[];
  readonly fetchImpl: FetchLike;
}

/** A fetch stub driven by a queue of handlers, one per attempt. */
function recorder(
  handlers: ReadonlyArray<(url: string, init: RequestInit) => Promise<Response>>,
): Recorder {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const handler = handlers[urls.length];
    urls.push(url);
    if (!handler) throw new Error(`unexpected request #${urls.length}: ${url}`);
    return handler(url, init);
  };
  return { urls, fetchImpl };
}

function ok(body: unknown): () => Promise<Response> {
  return async () => new Response(JSON.stringify(body), { status: 200 });
}

function status(code: number): () => Promise<Response> {
  return async () => new Response("{}", { status: code });
}

function boom(message: string): () => Promise<Response> {
  return async () => {
    throw new TypeError(message);
  };
}

/** Never settles until aborted, like a node that accepted the socket and stalled. */
const hang: FetchLike = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    });
  });

function config(
  overrides: Partial<LcdClientConfig> & Pick<LcdClientConfig, "endpoints" | "fetchImpl">,
): LcdClientConfig {
  return {
    chainId: "safrochain-1",
    retries: 0,
    // Tests never wait: backoff is observed through the sleep stub instead.
    sleep: async () => {},
    ...overrides,
  };
}

test("getJson parses the body and appends query parameters", async () => {
  const rec = recorder([ok({ channels: [] })]);
  const client = createLcdClient(
    config({ endpoints: ["https://a.example/"], fetchImpl: rec.fetchImpl }),
  );

  const body = await client.getJson("/ibc/core/channel/v1/channels", {
    query: { "pagination.limit": 100, "pagination.key": undefined },
  });

  assert.deepEqual(body, { channels: [] });
  assert.deepEqual(rec.urls, [
    "https://a.example/ibc/core/channel/v1/channels?pagination.limit=100",
  ]);
});

test("a 5xx is retried on the same endpoint with doubling backoff", async () => {
  const rec = recorder([status(503), status(503), ok({ ok: true })]);
  const delays: number[] = [];
  const client = createLcdClient(
    config({
      endpoints: ["https://a.example"],
      fetchImpl: rec.fetchImpl,
      retries: 2,
      backoffMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }),
  );

  assert.deepEqual(await client.getJson("/x"), { ok: true });
  assert.equal(rec.urls.length, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("retries are exhausted before the next endpoint is tried", async () => {
  const rec = recorder([boom("ECONNRESET"), boom("ECONNRESET"), ok({ from: "b" })]);
  const client = createLcdClient(
    config({
      endpoints: ["https://a.example", "https://b.example"],
      fetchImpl: rec.fetchImpl,
      retries: 1,
    }),
  );

  assert.deepEqual(await client.getJson("/x"), { from: "b" });
  assert.deepEqual(rec.urls, [
    "https://a.example/x",
    "https://a.example/x",
    "https://b.example/x",
  ]);
});

test("all endpoints failing throws lcd-unreachable", async () => {
  const rec = recorder([boom("ENOTFOUND"), boom("ENOTFOUND")]);
  const client = createLcdClient(
    config({
      endpoints: ["https://a.example", "https://b.example"],
      fetchImpl: rec.fetchImpl,
    }),
  );

  await assert.rejects(client.getJson("/x"), (error: unknown) => {
    assert.ok(isInterchainError(error));
    assert.equal(error.code, "lcd-unreachable");
    assert.equal(error.chainId, "safrochain-1");
    return true;
  });
});

test("a 404 falls back without retrying; a 400 stops immediately", async () => {
  const missing = recorder([status(404), ok({ from: "b" })]);
  const notFoundClient = createLcdClient(
    config({
      endpoints: ["https://a.example", "https://b.example"],
      fetchImpl: missing.fetchImpl,
      retries: 3,
    }),
  );
  assert.deepEqual(await notFoundClient.getJson("/x"), { from: "b" });
  assert.equal(missing.urls.length, 2, "404 must not be retried on the same host");

  const bad = recorder([status(400), ok({ from: "b" })]);
  const badRequestClient = createLcdClient(
    config({
      endpoints: ["https://a.example", "https://b.example"],
      fetchImpl: bad.fetchImpl,
      retries: 3,
    }),
  );
  await assert.rejects(badRequestClient.getJson("/x"), (error: unknown) => {
    assert.ok(isInterchainError(error));
    assert.equal(error.code, "lcd-unreachable");
    assert.equal(error.httpStatus, 400);
    return true;
  });
  assert.equal(bad.urls.length, 1, "a 400 is an answer, not a transport failure");
});

test("a non-JSON body is malformed-response and moves to the next endpoint", async () => {
  const rec = recorder([
    async () => new Response("<html>rate limited</html>", { status: 200 }),
    ok({ from: "b" }),
  ]);
  const client = createLcdClient(
    config({
      endpoints: ["https://a.example", "https://b.example"],
      fetchImpl: rec.fetchImpl,
      retries: 2,
    }),
  );

  assert.deepEqual(await client.getJson("/x"), { from: "b" });
  assert.equal(rec.urls.length, 2, "a bad body will not become good on a retry");

  const allBad = recorder([
    async () => new Response("not json", { status: 200 }),
  ]);
  const strict = createLcdClient(
    config({ endpoints: ["https://a.example"], fetchImpl: allBad.fetchImpl }),
  );
  await assert.rejects(strict.getJson("/x"), (error: unknown) => {
    assert.ok(isInterchainError(error));
    assert.equal(error.code, "malformed-response");
    return true;
  });
});

test("a stalled endpoint times out and reports lcd-unreachable", async () => {
  const client = createLcdClient(
    config({ endpoints: ["https://a.example"], fetchImpl: hang, timeoutMs: 5 }),
  );

  await assert.rejects(client.getJson("/x"), (error: unknown) => {
    assert.ok(isInterchainError(error));
    assert.equal(error.code, "lcd-unreachable");
    assert.match(error.message, /timed out after 5ms/);
    return true;
  });
});

test("the timeout is per attempt, so a retry gets a fresh budget", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = (url, init) => {
    calls++;
    if (calls === 1) return hang(url, init);
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  };
  const client = createLcdClient(
    config({
      endpoints: ["https://a.example"],
      fetchImpl,
      timeoutMs: 5,
      retries: 1,
    }),
  );

  assert.deepEqual(await client.getJson("/x"), { ok: true });
  assert.equal(calls, 2);
});

test("a caller abort is reported as aborted, not as a timeout", async () => {
  const controller = new AbortController();
  const client = createLcdClient(
    config({ endpoints: ["https://a.example"], fetchImpl: hang, timeoutMs: 5_000 }),
  );

  const pending = client.getJson("/x", { signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(isInterchainError(error));
    assert.equal(error.code, "aborted");
    return true;
  });
});

test("an already-aborted signal short-circuits before any request", async () => {
  const rec = recorder([ok({})]);
  const client = createLcdClient(
    config({ endpoints: ["https://a.example"], fetchImpl: rec.fetchImpl }),
  );

  await assert.rejects(
    client.getJson("/x", { signal: AbortSignal.abort() }),
    (error: unknown) => isInterchainError(error) && error.code === "aborted",
  );
  assert.equal(rec.urls.length, 0);
});

test("cache serves repeats within the TTL and refetches after it", async () => {
  let clock = 1_000;
  const rec = recorder([ok({ n: 1 }), ok({ n: 2 })]);
  const client = createLcdClient(
    config({
      endpoints: ["https://a.example"],
      fetchImpl: rec.fetchImpl,
      cacheTtlMs: 60_000,
      now: () => clock,
    }),
  );

  assert.deepEqual(await client.getJson("/x"), { n: 1 });
  assert.deepEqual(await client.getJson("/x"), { n: 1 });
  assert.equal(rec.urls.length, 1);

  clock += 60_001;
  assert.deepEqual(await client.getJson("/x"), { n: 2 });
  assert.equal(rec.urls.length, 2);
});

test("the cache key is the request, not the endpoint that served it", async () => {
  const rec = recorder([boom("ECONNRESET"), ok({ from: "b" })]);
  const client = createLcdClient(
    config({
      endpoints: ["https://a.example", "https://b.example"],
      fetchImpl: rec.fetchImpl,
      cacheTtlMs: 60_000,
    }),
  );

  assert.deepEqual(await client.getJson("/x"), { from: "b" });
  // The fallback body must satisfy the next read even though the primary
  // endpoint would be tried first.
  assert.deepEqual(await client.getJson("/x"), { from: "b" });
  assert.equal(rec.urls.length, 2);
});

test("query parameters and clearCache change the cache identity", async () => {
  const rec = recorder([ok({ n: 1 }), ok({ n: 2 }), ok({ n: 3 })]);
  const client = createLcdClient(
    config({
      endpoints: ["https://a.example"],
      fetchImpl: rec.fetchImpl,
      cacheTtlMs: 60_000,
    }),
  );

  await client.getJson("/x", { query: { page: 1 } });
  await client.getJson("/x", { query: { page: 2 } });
  assert.equal(rec.urls.length, 2);

  client.clearCache();
  assert.deepEqual(await client.getJson("/x", { query: { page: 1 } }), { n: 3 });
  assert.equal(rec.urls.length, 3);
});

test("cacheTtlMs of 0 on a call opts that call out of a cached client", async () => {
  const rec = recorder([ok({ n: 1 }), ok({ n: 2 })]);
  const client = createLcdClient(
    config({
      endpoints: ["https://a.example"],
      fetchImpl: rec.fetchImpl,
      cacheTtlMs: 60_000,
    }),
  );

  await client.getJson("/x");
  await client.getJson("/x", { cacheTtlMs: 0 });
  assert.equal(rec.urls.length, 2);
});

test("the reads gate blocks the request instead of blaming the network", async () => {
  const rec = recorder([ok({})]);
  let allowed = false;
  const client = createLcdClient(
    config({
      endpoints: ["https://a.example"],
      fetchImpl: rec.fetchImpl,
      readsAllowed: async () => allowed,
    }),
  );

  await assert.rejects(client.getJson("/x"), (error: unknown) => {
    assert.ok(isInterchainError(error));
    assert.equal(error.code, "reads-disabled");
    return true;
  });
  assert.equal(rec.urls.length, 0);

  allowed = true;
  assert.deepEqual(await client.getJson("/x"), {});
});

test("a chain with no REST endpoint is unsupported-chain, detectable up front", () => {
  const chain: ChainInfoLike = { ...CHAIN, rest: undefined };
  assert.deepEqual(lcdEndpointsFromChain(chain), []);
  assert.throws(
    () => createLcdClient({ chainId: chain.chainId, endpoints: [] }),
    (error: unknown) =>
      isInterchainError(error) && error.code === "unsupported-chain",
  );
});

test("endpoints are trimmed, de-duplicated and host-supplied ones come first", () => {
  const chain: ChainInfoLike = {
    ...CHAIN,
    rest: "https://public.example/",
    restEndpoints: ["https://private.example//", " https://public.example ", ""],
  };
  assert.deepEqual(lcdEndpointsFromChain(chain), [
    "https://private.example",
    "https://public.example",
  ]);
});

test("the factory reuses one client per chain id", () => {
  const factory = createLcdClientFactory({ fetchImpl: recorder([]).fetchImpl });
  const first = factory(CHAIN);
  const second = factory({ ...CHAIN, rest: "https://other.example" });
  assert.equal(first, second, "config changes need a new factory, not a new client");
  assert.equal(first.chainId, "safrochain-1");
});

/* -------------------------------------------------------------------------- *
 * postJson
 * -------------------------------------------------------------------------- */

test("the client handle can POST, and sends JSON with no cookies", async () => {
  let seen: RequestInit | undefined;
  const rec = recorder([
    async (_url, init) => {
      seen = init;
      return new Response(JSON.stringify({ gas_info: { gas_used: "42" } }), {
        status: 200,
      });
    },
  ]);
  const client = createLcdClient({
    chainId: CHAIN.chainId,
    endpoints: ["https://api.example/"],
    fetchImpl: rec.fetchImpl,
  });

  const body = await client.postJson("/cosmos/tx/v1beta1/simulate", {
    tx_bytes: "AA==",
  });
  assert.deepEqual(body, { gas_info: { gas_used: "42" } });
  assert.deepEqual(rec.urls, ["https://api.example/cosmos/tx/v1beta1/simulate"]);
  assert.equal(seen?.method, "POST");
  assert.equal(seen?.credentials, "omit");
  assert.equal(seen?.body, JSON.stringify({ tx_bytes: "AA==" }));
});

test("a POST falls back to the next endpoint but is never retried on one", async () => {
  const rec = recorder([status(502), ok({ ok: true })]);
  const client = createLcdClient({
    chainId: CHAIN.chainId,
    // `retries: 3` governs reads. A broadcast that was retried against the same
    // node comes back as "tx already exists in cache", so POST ignores it.
    retries: 3,
    endpoints: ["https://a.example", "https://b.example"],
    fetchImpl: rec.fetchImpl,
  });
  assert.deepEqual(await client.postJson("/broadcast", {}), { ok: true });
  assert.deepEqual(rec.urls, ["https://a.example/broadcast", "https://b.example/broadcast"]);
});

test("a POST stops at a 400 and carries the gateway's own message", async () => {
  const rec = recorder([
    async () =>
      new Response(JSON.stringify({ code: 3, message: "out of gas" }), {
        status: 400,
      }),
  ]);
  const client = createLcdClient({
    chainId: CHAIN.chainId,
    endpoints: ["https://a.example", "https://b.example"],
    fetchImpl: rec.fetchImpl,
  });
  await assert.rejects(
    () => client.postJson("/simulate", {}),
    (error: unknown) =>
      isInterchainError(error) &&
      error.code === "lcd-unreachable" &&
      error.message.includes("out of gas"),
  );
  assert.equal(rec.urls.length, 1, "a definitive 4xx must not fall back");
});

test("the live-reads gate does not block a POST", async () => {
  const rec = recorder([ok({ ok: true })]);
  const client = createLcdClient({
    chainId: CHAIN.chainId,
    endpoints: ["https://a.example"],
    fetchImpl: rec.fetchImpl,
    readsAllowed: () => false,
  });
  // Broadcasting is a foreground action the user just authorised; the switch
  // governs background reads of their balance, not their own transaction.
  assert.deepEqual(await client.postJson("/broadcast", {}), { ok: true });
  await assert.rejects(
    () => client.getJson("/anything"),
    (error: unknown) => isInterchainError(error) && error.code === "reads-disabled",
  );
});
