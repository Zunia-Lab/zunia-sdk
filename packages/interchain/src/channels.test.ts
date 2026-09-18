import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_CHANNEL_MESSAGES,
  createIbcChannelService,
  normalizeChannelId,
  parseChannelState,
  type IbcChannelServiceConfig,
} from "./channels.js";
import {
  InterchainError,
  type ChainInfoLike,
  type ChainRegistry,
  type LcdClient,
  type LcdClientFactory,
  type LcdRequestOptions,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

/** Safrochain's prefix has an underscore; nothing here may normalise it away. */
const SAFRO: ChainInfoLike = {
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
  rest: "https://api.safrochain.example",
  features: ["cosmwasm"],
};

const OSMO: ChainInfoLike = {
  chainId: "osmosis-1",
  chainName: "Osmosis",
  bech32Prefix: "osmo",
  coinType: 118,
  coinDenom: "OSMO",
  coinMinimalDenom: "uosmo",
  coinDecimals: 6,
  feeDenom: "OSMO",
  feeMinimalDenom: "uosmo",
  feeDecimals: 6,
  rest: "https://lcd.osmosis.example",
  features: ["cosmwasm"],
};

/** A chain that declares no CosmWasm, used for the ibc-hooks negative. */
const HUB: ChainInfoLike = {
  ...OSMO,
  chainId: "cosmoshub-4",
  chainName: "Cosmos Hub",
  bech32Prefix: "cosmos",
  coinDenom: "ATOM",
  coinMinimalDenom: "uatom",
  feeDenom: "ATOM",
  feeMinimalDenom: "uatom",
  rest: "https://lcd.cosmoshub.example",
  features: ["ibc-transfer"],
};

type Handler = (path: string, options: LcdRequestOptions) => unknown;

interface Stub {
  readonly client: LcdClient;
  readonly calls: string[];
}

function httpError(chainId: string, status: number): InterchainError {
  return new InterchainError("lcd-unreachable", `${chainId}: HTTP ${status}`, {
    chainId,
    httpStatus: status,
  });
}

function readsDisabled(chainId: string): InterchainError {
  return new InterchainError("reads-disabled", `${chainId}: reads off`, { chainId });
}

function formatCall(path: string, options: LcdRequestOptions): string {
  const query = options.query;
  if (!query) return path;
  const parts = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length === 0 ? path : `${path}?${parts.join("&")}`;
}

/**
 * An LcdClient stub. The handler returns a body, an Error to throw, or
 * `undefined` to stand for "this node has no such route" (HTTP 404).
 */
function stubClient(chainId: string, handler: Handler): Stub {
  const calls: string[] = [];
  const client: LcdClient = {
    chainId,
    getJson(path, options = {}) {
      calls.push(formatCall(path, options));
      if (options.signal?.aborted === true) {
        return Promise.reject(
          new InterchainError("aborted", "cancelled", { chainId }),
        );
      }
      let value: unknown;
      try {
        value = handler(path, options);
      } catch (error) {
        return Promise.reject(error);
      }
      if (value instanceof Error) return Promise.reject(value);
      if (value === undefined) return Promise.reject(httpError(chainId, 404));
      return Promise.resolve(value);
    },
  };
  return { client, calls };
}

function registryOf(chains: readonly ChainInfoLike[]): ChainRegistry {
  return {
    get: (chainId) => chains.find((row) => row.chainId === chainId),
    list: () => chains,
    byPrefix: (prefix) => chains.filter((row) => row.bech32Prefix === prefix),
  };
}

/** Wires stubs to a factory that mimics `createLcdClient`'s endpoint refusal. */
function harness(
  stubs: Readonly<Record<string, Stub>>,
  extra: Partial<IbcChannelServiceConfig> = {},
  chains: readonly ChainInfoLike[] = [SAFRO, OSMO, HUB],
): { readonly service: ReturnType<typeof createIbcChannelService>; readonly seen: ChainInfoLike[] } {
  const seen: ChainInfoLike[] = [];
  const lcd: LcdClientFactory = (chain) => {
    seen.push(chain);
    const stub = stubs[chain.chainId];
    if (!stub) {
      throw new InterchainError(
        "unsupported-chain",
        `No REST endpoint configured for ${chain.chainId}`,
        { chainId: chain.chainId },
      );
    }
    return stub.client;
  };
  return {
    service: createIbcChannelService({ lcd, registry: registryOf(chains), ...extra }),
    seen,
  };
}

interface ChannelRowOverrides {
  readonly channel_id?: string;
  readonly port_id?: string;
  readonly state?: unknown;
  readonly connection_hops?: readonly string[];
  readonly counterparty?: unknown;
}

function channelRow(over: ChannelRowOverrides = {}): Record<string, unknown> {
  return {
    state: "STATE_OPEN",
    port_id: "transfer",
    channel_id: "channel-0",
    connection_hops: ["connection-0"],
    counterparty: { channel_id: "channel-100", port_id: "transfer" },
    ...over,
  };
}

/** Source LCD that resolves connection-N to a chain id from `map`. */
function connectionRoutes(map: Readonly<Record<string, string>>): Handler {
  return (path) => {
    const connection = /\/connections\/(.+)$/.exec(path)?.[1];
    if (connection !== undefined) {
      return map[connection] === undefined
        ? undefined
        : { connection: { client_id: `07-tendermint-${connection}` } };
    }
    const client = /\/client_states\/07-tendermint-(.+)$/.exec(path)?.[1];
    if (client !== undefined) {
      const chainId = map[client];
      return chainId === undefined
        ? undefined
        : { client_state: { "@type": "/ibc.lightclients.tendermint.v1.ClientState", chain_id: chainId } };
    }
    return undefined;
  };
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

test("normalizeChannelId accepts both entry styles", () => {
  assert.equal(normalizeChannelId("channel-141"), "channel-141");
  assert.equal(normalizeChannelId("141"), "channel-141");
  assert.equal(normalizeChannelId("  CHANNEL-7 "), "channel-7");
  assert.equal(normalizeChannelId("\t0\n"), "channel-0");
  assert.equal(normalizeChannelId(""), "");
  assert.equal(normalizeChannelId("   "), "");
  // Anything else is passed through for the chain to reject with a real answer.
  assert.equal(normalizeChannelId("Transfer/Channel-1"), "transfer/channel-1");
  assert.equal(normalizeChannelId("channel-"), "channel-");
});

test("parseChannelState does not read TRYOPEN as open", () => {
  // The three implementations this module replaces tested includes("OPEN")
  // first, and "STATE_TRYOPEN" contains "OPEN".
  assert.equal(parseChannelState("STATE_TRYOPEN"), "tryopen");
  assert.equal(parseChannelState("TRY_OPEN"), "tryopen");
  assert.equal(parseChannelState("STATE_OPEN"), "open");
  assert.equal(parseChannelState("STATE_CLOSED"), "closed");
  assert.equal(parseChannelState("STATE_INIT"), "init");
  assert.equal(parseChannelState("state_open"), "open");
});

test("parseChannelState tolerates junk and integer enums", () => {
  assert.equal(parseChannelState(undefined), "unknown");
  assert.equal(parseChannelState(null), "unknown");
  assert.equal(parseChannelState(""), "unknown");
  // "STATE_UNINITIALIZED_UNSPECIFIED" contains "INIT".
  assert.equal(parseChannelState("STATE_UNINITIALIZED_UNSPECIFIED"), "unknown");
  // Channel-upgrade states have no member in the shared union.
  assert.equal(parseChannelState("STATE_FLUSHING"), "unknown");
  assert.equal(parseChannelState("STATE_FLUSHCOMPLETE"), "unknown");
  assert.equal(parseChannelState({}), "unknown");
  assert.equal(parseChannelState(1), "init");
  assert.equal(parseChannelState(2), "tryopen");
  assert.equal(parseChannelState(3), "open");
  assert.equal(parseChannelState(4), "closed");
  assert.equal(parseChannelState(9), "unknown");
});

/* -------------------------------------------------------------------------- *
 * findIbcChannels
 * -------------------------------------------------------------------------- */

test("findIbcChannels keeps open transfer channels pointing at the destination", async () => {
  const resolve = connectionRoutes({ "connection-0": "osmosis-1", "connection-9": "cosmoshub-4" });
  const source = stubClient("safrochain-1", (path, options) => {
    if (path === "/ibc/core/channel/v1/channels") {
      return {
        channels: [
          channelRow({ channel_id: "channel-10", counterparty: { channel_id: "channel-200" } }),
          channelRow({ channel_id: "channel-2" }),
          channelRow({ channel_id: "channel-3", state: "STATE_CLOSED" }),
          channelRow({ channel_id: "channel-4", state: "STATE_TRYOPEN" }),
          channelRow({ channel_id: "channel-5", connection_hops: ["connection-9"] }),
          channelRow({ channel_id: "channel-6", port_id: "icahost" }),
          channelRow({ channel_id: "channel-7", connection_hops: [] }),
        ],
        pagination: { next_key: null },
      };
    }
    return resolve(path, options);
  });

  const { service } = harness({ "safrochain-1": source });
  const found = await service.findIbcChannels("safrochain-1", "osmosis-1");

  assert.deepEqual(
    found.map((row) => row.channelId),
    // Numeric sort: channel-2 before channel-10.
    ["channel-2", "channel-10"],
  );
  assert.deepEqual(found[1], {
    channelId: "channel-10",
    portId: "transfer",
    counterpartyChannelId: "channel-200",
    counterpartyPortId: "transfer",
    connectionId: "connection-0",
    counterpartyChainId: "osmosis-1",
    state: "open",
  });
  // connection-0 is shared by both matches and resolved once.
  const connectionCalls = source.calls.filter((call) => call.includes("/connections/"));
  assert.equal(connectionCalls.length, 2, "connection-0 and connection-9, once each");
});

test("findIbcChannels memoises connection lookups across calls", async () => {
  const resolve = connectionRoutes({ "connection-0": "osmosis-1" });
  const source = stubClient("safrochain-1", (path, options) =>
    path === "/ibc/core/channel/v1/channels"
      ? { channels: [channelRow()], pagination: {} }
      : resolve(path, options),
  );
  const { service } = harness({ "safrochain-1": source });

  await service.findIbcChannels(SAFRO, OSMO);
  await service.findIbcChannels(SAFRO, OSMO);
  assert.equal(source.calls.filter((call) => call.includes("/connections/")).length, 1);

  service.clearCache();
  await service.findIbcChannels(SAFRO, OSMO);
  assert.equal(source.calls.filter((call) => call.includes("/connections/")).length, 2);
});

test("findIbcChannels honours pageLimit and maxPages", async () => {
  const resolve = connectionRoutes({ "connection-0": "osmosis-1" });
  let page = 0;
  const source = stubClient("safrochain-1", (path, options) => {
    if (path === "/ibc/core/channel/v1/channels") {
      page += 1;
      return {
        channels: [channelRow({ channel_id: `channel-${page}` })],
        // Never exhausts: only maxPages stops the walk.
        pagination: { next_key: `key-${page}` },
      };
    }
    return resolve(path, options);
  });

  const { service } = harness({ "safrochain-1": source }, { pageLimit: 5, maxPages: 2 });
  const found = await service.findIbcChannels(SAFRO, OSMO);

  assert.deepEqual(found.map((row) => row.channelId), ["channel-1", "channel-2"]);
  const listCalls = source.calls.filter((call) => call.startsWith("/ibc/core/channel/v1/channels?"));
  assert.deepEqual(listCalls, [
    "/ibc/core/channel/v1/channels?pagination.limit=5",
    "/ibc/core/channel/v1/channels?pagination.limit=5&pagination.key=key-1",
  ]);

  // Per-call overrides win over the service defaults.
  page = 0;
  const one = await service.findIbcChannels(SAFRO, OSMO, { maxPages: 1, pageLimit: 3 });
  assert.equal(one.length, 1);
  assert.ok(source.calls.includes("/ibc/core/channel/v1/channels?pagination.limit=3"));
});

test("findIbcChannels stops when a node repeats its cursor", async () => {
  const resolve = connectionRoutes({ "connection-0": "osmosis-1" });
  let page = 0;
  const source = stubClient("safrochain-1", (path, options) => {
    if (path === "/ibc/core/channel/v1/channels") {
      page += 1;
      return {
        channels: [channelRow({ channel_id: `channel-${page}` })],
        pagination: { next_key: "stuck" },
      };
    }
    return resolve(path, options);
  });

  const { service } = harness({ "safrochain-1": source }, { maxPages: 10 });
  const found = await service.findIbcChannels(SAFRO, OSMO);
  assert.equal(found.length, 2, "one page, then the repeated cursor ends the walk");
});

test("findIbcChannels returns nothing for the states the UI treats as empty", async () => {
  const source = stubClient("safrochain-1", () => ({ channels: [], pagination: {} }));
  const { service } = harness({ "safrochain-1": source });

  assert.deepEqual(await service.findIbcChannels(SAFRO, SAFRO), []);
  assert.deepEqual(await service.findIbcChannels(SAFRO, ""), []);
  assert.deepEqual(await service.findIbcChannels("nope-1", OSMO), []);
  // osmosis-1 has no stub, so the factory refuses it the way createLcdClient does.
  assert.deepEqual(await service.findIbcChannels(OSMO, SAFRO), []);
  assert.equal(source.calls.length, 0);
});

test("findIbcChannels is empty when live reads are off but rethrows real failures", async () => {
  const off = stubClient("safrochain-1", () => readsDisabled("safrochain-1"));
  const { service: offService } = harness({ "safrochain-1": off });
  assert.deepEqual(await offService.findIbcChannels(SAFRO, OSMO), []);

  const broken = stubClient("safrochain-1", () => httpError("safrochain-1", 503));
  const { service } = harness({ "safrochain-1": broken });
  await assert.rejects(
    () => service.findIbcChannels(SAFRO, OSMO),
    (error: unknown) => error instanceof InterchainError && error.code === "lcd-unreachable",
  );
});

test("findIbcChannels propagates an abort", async () => {
  const controller = new AbortController();
  controller.abort();
  const source = stubClient("safrochain-1", () => ({ channels: [], pagination: {} }));
  const { service } = harness({ "safrochain-1": source });
  await assert.rejects(
    () => service.findIbcChannels(SAFRO, OSMO, { signal: controller.signal }),
    (error: unknown) => error instanceof InterchainError && error.code === "aborted",
  );
});

test("findIbcChannels survives malformed listings", async () => {
  const bodies: unknown[] = [
    null,
    "not json object",
    [],
    { channels: "nope" },
    { channels: [null, 42, "x", {}, { channel_id: 5 }] },
    { channels: [channelRow({ connection_hops: "connection-0" as unknown as string[] })] },
    { channels: [channelRow({ counterparty: "oops" })], pagination: "bad" },
  ];
  for (const body of bodies) {
    const source = stubClient("safrochain-1", (path) =>
      path === "/ibc/core/channel/v1/channels" ? body : undefined,
    );
    const { service } = harness({ "safrochain-1": source });
    const found = await service.findIbcChannels(SAFRO, OSMO);
    assert.equal(Array.isArray(found), true);
    // The last body has a usable channel but an unresolvable connection.
    assert.equal(found.length, 0);
  }
});

test("findIbcChannels drops a channel whose client state is unusable", async () => {
  const source = stubClient("safrochain-1", (path) => {
    if (path === "/ibc/core/channel/v1/channels") {
      return { channels: [channelRow()], pagination: {} };
    }
    if (path.includes("/connections/")) return { connection: { client_id: "09-localhost" } };
    // A solo-machine or localhost client has no chain_id.
    return { client_state: { "@type": "/ibc.lightclients.localhost.v2.ClientState" } };
  });
  const { service } = harness({ "safrochain-1": source });
  assert.deepEqual(await service.findIbcChannels(SAFRO, OSMO), []);
});

test("findIbcChannels hands the host's chain row through untouched", async () => {
  const resolve = connectionRoutes({ "connection-0": "osmosis-1" });
  const source = stubClient("safrochain-1", (path, options) =>
    path === "/ibc/core/channel/v1/channels"
      ? { channels: [channelRow()], pagination: {} }
      : resolve(path, options),
  );
  const { service, seen } = harness({ "safrochain-1": source });
  await service.findIbcChannels("safrochain-1", "osmosis-1");
  // Nothing in this module parses or rewrites the bech32 prefix, so the
  // non-standard `addr_safro` reaches the client factory intact.
  assert.equal(seen[0]?.bech32Prefix, "addr_safro");
});

/* -------------------------------------------------------------------------- *
 * validateIbcChannel
 * -------------------------------------------------------------------------- */

function sourceForValidate(over: ChannelRowOverrides = {}, map: Readonly<Record<string, string>> = { "connection-0": "osmosis-1" }): Stub {
  const resolve = connectionRoutes(map);
  return stubClient("safrochain-1", (path, options) => {
    if (path.startsWith("/ibc/core/channel/v1/channels/")) {
      return { channel: channelRow(over) };
    }
    return resolve(path, options);
  });
}

test("validateIbcChannel reproduces the existing copy", async () => {
  const { service } = harness({ "safrochain-1": sourceForValidate() });

  const empty = await service.validateIbcChannel(SAFRO, "   ");
  assert.deepEqual(empty, {
    ok: false,
    state: "unknown",
    channelId: "",
    portId: "transfer",
    message: "Enter a channel id (e.g. channel-141)",
  });

  const ok = await service.validateIbcChannel(SAFRO, "141", "osmosis-1");
  assert.equal(ok.ok, true);
  assert.equal(ok.channelId, "channel-141");
  assert.equal(ok.counterpartyChainId, "osmosis-1");
  assert.equal(ok.counterpartyChannelId, "channel-100");
  assert.equal(ok.message, "Open · osmosis-1");
  assert.equal(ok.counterparty, undefined);
});

test("validateIbcChannel queries the id and port it was given", async () => {
  const source = sourceForValidate();
  const { service } = harness({ "safrochain-1": source });
  await service.validateIbcChannel(SAFRO, "channel-141", undefined, { portId: "wasm.juno1abc" });
  assert.equal(
    source.calls[0],
    "/ibc/core/channel/v1/channels/channel-141/ports/wasm.juno1abc",
  );
});

test("validateIbcChannel reports a channel that is not open", async () => {
  const closed = await harness({ "safrochain-1": sourceForValidate({ state: "STATE_CLOSED" }) })
    .service.validateIbcChannel(SAFRO, "channel-1");
  assert.equal(closed.ok, false);
  assert.equal(closed.state, "closed");
  assert.equal(closed.message, "Channel is closed, not open");

  // Regression: the code this replaces answered "Open · osmosis-1" here.
  const half = await harness({ "safrochain-1": sourceForValidate({ state: "STATE_TRYOPEN" }) })
    .service.validateIbcChannel(SAFRO, "channel-1");
  assert.equal(half.ok, false);
  assert.equal(half.state, "tryopen");
  assert.equal(half.message, "Channel is tryopen, not open");
});

test("validateIbcChannel reports a channel that goes somewhere else", async () => {
  const { service } = harness({ "safrochain-1": sourceForValidate() });
  const result = await service.validateIbcChannel(SAFRO, "channel-1", "cosmoshub-4");
  assert.equal(result.ok, false);
  assert.equal(result.message, "Open, but connects to osmosis-1");
  assert.equal(result.counterpartyChainId, "osmosis-1");
});

test("validateIbcChannel falls back to generic copy without a client chain id", async () => {
  const source = stubClient("safrochain-1", (path) =>
    path.startsWith("/ibc/core/channel/v1/channels/")
      ? { channel: channelRow({ connection_hops: [] }) }
      : undefined,
  );
  const { service } = harness({ "safrochain-1": source });
  const result = await service.validateIbcChannel(SAFRO, "channel-1");
  assert.equal(result.ok, true);
  assert.equal(result.message, "Open and ready");
  assert.equal(result.counterpartyChainId, null);
});

test("validateIbcChannel maps every failure to its message", async () => {
  const missingChain = harness({}).service;
  assert.equal(
    (await missingChain.validateIbcChannel(SAFRO, "channel-1")).message,
    "No REST endpoint for this chain",
  );
  assert.equal(
    (await missingChain.validateIbcChannel("who-1", "channel-1")).message,
    "No REST endpoint for this chain",
  );

  const empty = harness({
    "safrochain-1": stubClient("safrochain-1", () => ({})),
  }).service;
  assert.equal(
    (await empty.validateIbcChannel(SAFRO, "channel-1")).message,
    "Channel not found on this chain",
  );

  const notFound = harness({
    "safrochain-1": stubClient("safrochain-1", () => httpError("safrochain-1", 404)),
  }).service;
  assert.equal(
    (await notFound.validateIbcChannel(SAFRO, "channel-1")).message,
    "Channel not found on this chain",
  );

  const down = harness({
    "safrochain-1": stubClient("safrochain-1", () => httpError("safrochain-1", 502)),
  }).service;
  assert.equal(
    (await down.validateIbcChannel(SAFRO, "channel-1")).message,
    "Could not reach the chain to verify this channel",
  );

  const off = harness({
    "safrochain-1": stubClient("safrochain-1", () => readsDisabled("safrochain-1")),
  }).service;
  assert.equal(
    (await off.validateIbcChannel(SAFRO, "channel-1")).message,
    "Turn on live reads to check channels",
  );

  // The extension labels its switch "Live balances"; copy is overridable.
  const custom = harness(
    { "safrochain-1": stubClient("safrochain-1", () => readsDisabled("safrochain-1")) },
    { messages: { readsDisabled: "Turn on live balances to check channels" } },
  ).service;
  assert.equal(
    (await custom.validateIbcChannel(SAFRO, "channel-1")).message,
    "Turn on live balances to check channels",
  );
});

test("validateIbcChannel propagates an abort", async () => {
  const controller = new AbortController();
  controller.abort();
  const { service } = harness({ "safrochain-1": sourceForValidate() });
  await assert.rejects(
    () => service.validateIbcChannel(SAFRO, "channel-1", OSMO, { signal: controller.signal }),
    (error: unknown) => error instanceof InterchainError && error.code === "aborted",
  );
});

/* -------------------------------------------------------------------------- *
 * Counterparty check
 * -------------------------------------------------------------------------- */

/** Destination LCD answering for the far half of the pair. */
function destStub(over: ChannelRowOverrides = {}, map: Readonly<Record<string, string>> = { "connection-0": "safrochain-1" }): Stub {
  const resolve = connectionRoutes(map);
  return stubClient("osmosis-1", (path, options) => {
    if (path.startsWith("/ibc/core/channel/v1/channels/")) {
      return {
        channel: channelRow({
          channel_id: "channel-100",
          counterparty: { channel_id: "channel-141", port_id: "transfer" },
          ...over,
        }),
      };
    }
    return resolve(path, options);
  });
}

test("counterparty check confirms both halves", async () => {
  const { service } = harness({ "safrochain-1": sourceForValidate(), "osmosis-1": destStub() });
  const result = await service.validateIbcChannel(SAFRO, "141", OSMO, { checkCounterparty: true });

  assert.equal(result.ok, true);
  assert.equal(result.message, "Open on both sides · osmosis-1");
  assert.equal(result.counterparty?.status, "ok");
  assert.equal(result.counterparty?.channelId, "channel-100");
  assert.equal(result.counterparty?.pointsBackTo, "channel-141");
  assert.equal(result.counterparty?.state, "open");
});

test("counterparty check fails a one-sided channel", async () => {
  const closed = await harness({
    "safrochain-1": sourceForValidate(),
    "osmosis-1": destStub({ state: "STATE_CLOSED" }),
  }).service.validateIbcChannel(SAFRO, "141", OSMO, { checkCounterparty: true });
  assert.equal(closed.ok, false);
  assert.equal(closed.state, "open", "the source side really is open");
  assert.equal(closed.counterparty?.status, "not-open");
  assert.equal(closed.message, "Open here, but closed on osmosis-1");

  const missing = await harness({
    "safrochain-1": sourceForValidate(),
    "osmosis-1": stubClient("osmosis-1", () => undefined),
  }).service.validateIbcChannel(SAFRO, "141", OSMO, { checkCounterparty: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.counterparty?.status, "not-found");
  assert.equal(missing.message, "Open here, but missing on osmosis-1");

  const emptyBody = await harness({
    "safrochain-1": sourceForValidate(),
    "osmosis-1": stubClient("osmosis-1", () => ({ channel: null })),
  }).service.validateIbcChannel(SAFRO, "141", OSMO, { checkCounterparty: true });
  assert.equal(emptyBody.counterparty?.status, "not-found");
});

test("counterparty check fails when the far side points elsewhere", async () => {
  const other = await harness({
    "safrochain-1": sourceForValidate(),
    "osmosis-1": destStub({ counterparty: { channel_id: "channel-9", port_id: "transfer" } }),
  }).service.validateIbcChannel(SAFRO, "141", OSMO, { checkCounterparty: true });
  assert.equal(other.ok, false);
  assert.equal(other.counterparty?.status, "mismatch");
  assert.equal(other.counterparty?.pointsBackTo, "channel-9");
  assert.equal(other.message, "The other side points at channel-9, not channel-141");

  const noBack = await harness({
    "safrochain-1": sourceForValidate(),
    "osmosis-1": destStub({ counterparty: {} }),
  }).service.validateIbcChannel(SAFRO, "141", OSMO, { checkCounterparty: true });
  assert.equal(noBack.message, "The other side does not point back at channel-141");

  const wrongPort = await harness({
    "safrochain-1": sourceForValidate(),
    "osmosis-1": destStub({ counterparty: { channel_id: "channel-141", port_id: "icahost" } }),
  }).service.validateIbcChannel(SAFRO, "141", OSMO, { checkCounterparty: true });
  assert.equal(wrongPort.counterparty?.status, "mismatch");
});

test("counterparty check fails when the far client tracks another chain", async () => {
  const result = await harness({
    "safrochain-1": sourceForValidate(),
    "osmosis-1": destStub({}, { "connection-0": "some-fork-1" }),
  }).service.validateIbcChannel(SAFRO, "141", OSMO, { checkCounterparty: true });
  assert.equal(result.ok, false);
  assert.equal(result.counterparty?.status, "mismatch");
  assert.equal(result.message, "The other side points at some-fork-1, not safrochain-1");
});

test("counterparty check that learns nothing leaves the source verdict alone", async () => {
  const unreachable = await harness({
    "safrochain-1": sourceForValidate(),
    "osmosis-1": stubClient("osmosis-1", () => httpError("osmosis-1", 503)),
  }).service.validateIbcChannel(SAFRO, "141", OSMO, { checkCounterparty: true });
  assert.equal(unreachable.ok, true);
  assert.equal(unreachable.message, "Open · osmosis-1");
  assert.equal(unreachable.counterparty?.status, "unreachable");
  assert.equal(
    unreachable.counterparty?.message,
    "Could not reach osmosis-1 to check the other side",
  );

  // No stub for osmosis-1: no REST endpoint, so nothing can be asked.
  const noEndpoint = await harness({ "safrochain-1": sourceForValidate() })
    .service.validateIbcChannel(SAFRO, "141", OSMO, { checkCounterparty: true });
  assert.equal(noEndpoint.ok, true);
  assert.equal(noEndpoint.counterparty?.status, "skipped");

  // Destination not in the registry and not passed in.
  const unknownChain = await harness(
    { "safrochain-1": sourceForValidate() },
    {},
    [SAFRO],
  ).service.validateIbcChannel(SAFRO, "141", undefined, { checkCounterparty: true });
  assert.equal(unknownChain.ok, true);
  assert.equal(unknownChain.counterparty?.status, "skipped");
  assert.equal(
    unknownChain.counterparty?.message,
    "Other side not checked: the destination chain is not in the registry",
  );

  // The source did not name a counterparty channel at all.
  const unnamed = await harness({
    "safrochain-1": sourceForValidate({ counterparty: {} }),
    "osmosis-1": destStub(),
  }).service.validateIbcChannel(SAFRO, "141", OSMO, { checkCounterparty: true });
  assert.equal(unnamed.counterparty?.status, "skipped");
});

test("counterparty check resolves the destination from the connection client", async () => {
  // No `dest` argument: the chain is found through the source connection's
  // client state and then looked up in the registry.
  const result = await harness({
    "safrochain-1": sourceForValidate(),
    "osmosis-1": destStub(),
  }).service.validateIbcChannel(SAFRO, "141", undefined, { checkCounterparty: true });
  assert.equal(result.counterparty?.status, "ok");
  assert.equal(result.counterparty?.chainId, "osmosis-1");
});

test("checkCounterpartyChannel deep-checks one discovered option", async () => {
  const { service } = harness({ "safrochain-1": sourceForValidate(), "osmosis-1": destStub() });
  const check = await service.checkCounterpartyChannel(SAFRO, {
    channelId: "channel-141",
    portId: "transfer",
    counterpartyChannelId: "channel-100",
    counterpartyPortId: "transfer",
    connectionId: "connection-0",
    counterpartyChainId: "osmosis-1",
    state: "open",
  });
  assert.equal(check.ok, true);
  assert.equal(check.status, "ok");
  assert.equal(check.message, "Open on both sides · osmosis-1");
});

/* -------------------------------------------------------------------------- *
 * Module probes
 * -------------------------------------------------------------------------- */

test("detectPfmSupport believes a params route and caches the answer", async () => {
  const source = stubClient("safrochain-1", (path) =>
    path === "/ibc/apps/packetforward/v1/params"
      ? { params: { fee_percentage: "0.000000000000000000" } }
      : undefined,
  );
  const { service } = harness({ "safrochain-1": source });

  const first = await service.detectPfmSupport(SAFRO);
  assert.equal(first.status, "supported");
  assert.equal(first.supported, true);
  assert.equal(first.module, "packet-forward");
  assert.equal(first.evidence, "/ibc/apps/packetforward/v1/params answered");

  const calls = source.calls.length;
  const second = await service.detectPfmSupport("safrochain-1");
  assert.equal(second.status, "supported");
  assert.equal(source.calls.length, calls, "cached");
});

test("detectPfmSupport calls a route that is registered nowhere unsupported", async () => {
  const source = stubClient("safrochain-1", () => httpError("safrochain-1", 501));
  const { service } = harness({ "safrochain-1": source });
  const result = await service.detectPfmSupport(SAFRO);
  assert.equal(result.status, "unsupported");
  assert.equal(result.supported, false);
  assert.equal(source.calls.length, 3, "one call per candidate route");
});

test("detectPfmSupport stays honest when a probe is inconclusive", async () => {
  // A node that is simply down proves nothing about the module set.
  const down = harness({
    "safrochain-1": stubClient("safrochain-1", () => httpError("safrochain-1", 502)),
  }).service;
  assert.equal((await down.detectPfmSupport(SAFRO)).status, "unknown");

  // A proxy that answers 200 with a body that is not params is not evidence.
  const proxy = harness({
    "safrochain-1": stubClient("safrochain-1", () => ({ ok: true })),
  }).service;
  const proxied = await proxy.detectPfmSupport(SAFRO);
  assert.equal(proxied.status, "unknown");
  assert.match(proxied.evidence, /without a params object/);

  // 404 on one route plus a transport failure on another: still unknown.
  const mixed = harness({
    "safrochain-1": stubClient("safrochain-1", (path) =>
      path === "/ibc/apps/packetforward/v1/params"
        ? httpError("safrochain-1", 404)
        : httpError("safrochain-1", 500),
    ),
  }).service;
  assert.equal((await mixed.detectPfmSupport(SAFRO)).status, "unknown");
});

test("detectPfmSupport reports an unknown chain rather than guessing", async () => {
  const { service } = harness({}, {}, [SAFRO]);
  const missing = await service.detectPfmSupport("nowhere-1");
  assert.equal(missing.status, "unknown");
  assert.equal(missing.evidence, "chain is not in the registry");

  const noRest = await service.detectPfmSupport(SAFRO);
  assert.equal(noRest.status, "unknown");
  assert.equal(noRest.evidence, "chain has no REST endpoint");
});

test("a host declaration beats the probe and skips the network", async () => {
  const source = stubClient("safrochain-1", () => {
    throw new Error("the probe must not run");
  });
  const { service } = harness(
    { "safrochain-1": source },
    { moduleSupport: { "safrochain-1": { packetForward: true, ibcHooks: false } } },
  );
  const pfm = await service.detectPfmSupport(SAFRO);
  assert.equal(pfm.status, "supported");
  assert.equal(pfm.evidence, "declared by the host");
  assert.equal((await service.detectIbcHooksSupport(SAFRO)).status, "unsupported");
  assert.equal(source.calls.length, 0);
});

test("detectIbcHooksSupport rules the module out without CosmWasm", async () => {
  const source = stubClient("cosmoshub-4", () => {
    throw new Error("the registry flag settles this without a request");
  });
  const { service } = harness({ "cosmoshub-4": source });
  const result = await service.detectIbcHooksSupport(HUB);
  assert.equal(result.status, "unsupported");
  assert.equal(result.evidence, "registry declares no cosmwasm feature");
  assert.equal(source.calls.length, 0);

  // And by asking, when the chain has no wasm routes at all.
  const noWasm = harness({
    "osmosis-1": stubClient("osmosis-1", () => httpError("osmosis-1", 501)),
  }).service;
  const probed = await noWasm.detectIbcHooksSupport(OSMO);
  assert.equal(probed.status, "unsupported");
  assert.equal(probed.evidence, "no CosmWasm module on this chain");
});

test("detectIbcHooksSupport admits it cannot see the middleware", async () => {
  const source = stubClient("osmosis-1", (path) =>
    path === "/cosmwasm/wasm/v1/codes"
      ? { code_infos: [], pagination: {} }
      : httpError("osmosis-1", 501),
  );
  const { service } = harness({ "osmosis-1": source });
  const result = await service.detectIbcHooksSupport(OSMO);
  assert.equal(result.status, "unknown");
  assert.equal(result.supported, false);
  assert.equal(result.evidence, "CosmWasm is present but ibc-hooks exposes no query route");

  // A hooks params route, where a chain exposes one, is taken as support.
  const withRoute = harness({
    "osmosis-1": stubClient("osmosis-1", (path) =>
      path === "/osmosis/ibchooks/v1beta1/params" ? { params: { allowed_async_ack_contracts: [] } } : undefined,
    ),
  }).service;
  assert.equal((await withRoute.detectIbcHooksSupport(OSMO)).status, "supported");
});

test("a probe blocked by the live-reads gate is not cached", async () => {
  let attempts = 0;
  const source = stubClient("safrochain-1", () => {
    attempts += 1;
    return readsDisabled("safrochain-1");
  });
  const { service } = harness({ "safrochain-1": source });

  const first = await service.detectPfmSupport(SAFRO);
  assert.equal(first.status, "unknown");
  assert.equal(first.evidence, "live reads are off");
  assert.equal(attempts, 1, "the first candidate route is enough to learn this");

  await service.detectPfmSupport(SAFRO);
  assert.equal(attempts, 2, "asked again, because the switch can be flipped");
});

test("probes propagate an abort", async () => {
  const controller = new AbortController();
  controller.abort();
  const { service } = harness({
    "safrochain-1": stubClient("safrochain-1", () => ({ params: {} })),
  });
  await assert.rejects(
    () => service.detectPfmSupport(SAFRO, { signal: controller.signal }),
    (error: unknown) => error instanceof InterchainError && error.code === "aborted",
  );
});

/* -------------------------------------------------------------------------- *
 * Wiring
 * -------------------------------------------------------------------------- */

test("looking a chain up by id without a registry is a wiring error", async () => {
  const service = createIbcChannelService({
    lcd: () => stubClient("safrochain-1", () => ({})).client,
  });
  await assert.rejects(
    () => service.findIbcChannels("safrochain-1", "osmosis-1"),
    (error: unknown) => error instanceof InterchainError && error.code === "unsupported-chain",
  );
  // Passing the chain object works with no registry at all.
  assert.equal((await service.validateIbcChannel(SAFRO, "")).message, DEFAULT_CHANNEL_MESSAGES.emptyInput);
});
