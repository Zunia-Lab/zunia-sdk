/**
 * Route planner tests.
 *
 * Pure and offline: the planner never fetches, so the `lcd` factory handed to
 * it throws if anything touches it. Denom traces come from a stub resolver, and
 * the `ibc/…` expectations are the real hashes for the real channels used in
 * the fixture, so a mistake in the trace arithmetic shows up as a denom that
 * does not match a value anyone can look up.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MAX_HOPS,
  MAX_HOPS_CAP,
  bestRoutePlan,
  createChannelDirectory,
  findRoutePaths,
  planRoute,
  type ChainCapabilities,
  type ChannelLink,
  type RouteDenomResolver,
  type RoutePlanCandidate,
  type RoutePlannerDeps,
} from "./route.js";
import {
  isInterchainError,
  type ChainInfoLike,
  type ChainRegistry,
  type JsonObject,
  type LcdClientFactory,
  type ResolvedDenom,
  type RouteRequest,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

/** Real hashes, so the trace arithmetic is checked against the actual network. */
const ATOM_ON_OSMOSIS =
  "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const OSMO_ON_HUB =
  "ibc/14F9BC3E44B8A9C1BE1FB08980FAB87034C9905EF17CF2F5008FC085218811CC";

function chain(
  chainId: string,
  overrides: Partial<ChainInfoLike> = {},
): ChainInfoLike {
  const denom = chainId.split("-")[0] ?? chainId;
  return {
    chainId,
    chainName: chainId,
    bech32Prefix: denom,
    coinType: 118,
    network: "mainnet",
    coinDenom: denom.toUpperCase(),
    coinMinimalDenom: `u${denom}`,
    coinDecimals: 6,
    feeDenom: denom.toUpperCase(),
    feeMinimalDenom: `u${denom}`,
    feeDecimals: 6,
    rest: `https://rest.${chainId}.example`,
    ...overrides,
  };
}

const CHAINS: readonly ChainInfoLike[] = [
  // Safrochain's prefix has an underscore. Nothing in the planner may split,
  // lowercase or otherwise touch an address, and the tests below check that the
  // recipient survives verbatim into the memo.
  chain("safrochain-1", {
    chainName: "Safrochain",
    bech32Prefix: "addr_safro",
    coinMinimalDenom: "usafro",
    feeMinimalDenom: "usafro",
    features: ["cosmwasm"],
  }),
  chain("cosmoshub-4", { chainName: "Cosmos Hub", bech32Prefix: "cosmos", coinMinimalDenom: "uatom", feeMinimalDenom: "uatom" }),
  chain("osmosis-1", { chainName: "Osmosis", bech32Prefix: "osmo", coinMinimalDenom: "uosmo", feeMinimalDenom: "uosmo", features: ["cosmwasm"] }),
  chain("juno-1", { chainName: "Juno", bech32Prefix: "juno", coinMinimalDenom: "ujuno", feeMinimalDenom: "ujuno", features: ["cosmwasm"] }),
  chain("stargaze-1", { chainName: "Stargaze", bech32Prefix: "stars", coinMinimalDenom: "ustars", feeMinimalDenom: "ustars" }),
  chain("safro-testnet-1", { chainName: "Safrochain Testnet", bech32Prefix: "addr_safro", network: "testnet" }),
  chain("norest-1", { chainName: "No REST", rest: undefined }),
];

const registry: ChainRegistry = {
  get: (chainId) => CHAINS.find((row) => row.chainId === chainId),
  list: () => CHAINS,
  byPrefix: (prefix) => CHAINS.filter((row) => row.bech32Prefix === prefix),
};

/**
 * Channel fixture. Hub/Osmosis and Osmosis/Juno use the real channel ids so the
 * computed denoms match the hashes above; the Safrochain edges are invented.
 */
const LINKS: readonly ChannelLink[] = [
  {
    sourceChainId: "cosmoshub-4",
    destChainId: "osmosis-1",
    channelId: "channel-141",
    counterpartyChannelId: "channel-0",
    source: "verified",
    state: "open",
  },
  {
    sourceChainId: "osmosis-1",
    destChainId: "juno-1",
    channelId: "channel-42",
    counterpartyChannelId: "channel-0",
    source: "verified",
    state: "open",
  },
  {
    sourceChainId: "cosmoshub-4",
    destChainId: "juno-1",
    channelId: "channel-207",
    counterpartyChannelId: "channel-1",
    source: "verified",
    state: "open",
  },
  {
    sourceChainId: "juno-1",
    destChainId: "stargaze-1",
    channelId: "channel-5",
    counterpartyChannelId: "channel-7",
    source: "seed",
  },
  {
    sourceChainId: "safrochain-1",
    destChainId: "osmosis-1",
    channelId: "channel-0",
    counterpartyChannelId: "channel-9999",
    source: "verified",
    state: "open",
  },
  {
    sourceChainId: "safro-testnet-1",
    destChainId: "osmosis-1",
    channelId: "channel-3",
    counterpartyChannelId: "channel-8888",
    source: "seed",
  },
];

const directory = createChannelDirectory(LINKS);

/** Fails loudly if the planner ever tries to read the network itself. */
const lcd: LcdClientFactory = () => {
  throw new Error("planRoute must not touch the network");
};

const CAPABILITIES: Readonly<Record<string, ChainCapabilities>> = {
  "osmosis-1": { pfm: true, ibcHooks: true, cosmwasm: true },
  "cosmoshub-4": { pfm: true, ibcHooks: false, cosmwasm: false },
  "juno-1": { pfm: false, ibcHooks: false, cosmwasm: true },
};

const OSMOSIS_XCS = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";

function deps(overrides: Partial<RoutePlannerDeps> = {}): RoutePlannerDeps {
  return {
    registry,
    channels: directory,
    lcd,
    capabilities: (chainId) => CAPABILITIES[chainId],
    venues: [{ chainId: "osmosis-1", contractAddress: OSMOSIS_XCS }],
    ...overrides,
  };
}

const SAFRO_ADDRESS = "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    sourceChainId: "safrochain-1",
    destChainId: "osmosis-1",
    inputDenom: "usafro",
    amount: "1000000",
    sender: SAFRO_ADDRESS,
    recipient: "osmo1recipient",
    ...overrides,
  };
}

/** Parse a plan's memo, asserting it is an object. */
function memoOf(candidate: RoutePlanCandidate): Record<string, unknown> {
  const parsed: unknown = JSON.parse(candidate.plan.memo);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", `${key} is not an object`);
  const row = (value as Record<string, unknown>)[key];
  assert.ok(row !== null && typeof row === "object", `${key} is missing`);
  return row as Record<string, unknown>;
}

function resolverFor(
  traces: Readonly<Record<string, ResolvedDenom>>,
): RouteDenomResolver {
  return async ({ denom }) => {
    const hit = traces[denom];
    if (!hit) throw new Error(`no trace for ${denom}`);
    return hit;
  };
}

const ATOM_ON_OSMOSIS_TRACE: ResolvedDenom = {
  denom: ATOM_ON_OSMOSIS,
  baseDenom: "uatom",
  path: "transfer/channel-0",
  hops: [{ port: "transfer", channelId: "channel-0" }],
  originChainId: "cosmoshub-4",
  isNative: false,
  ibcHash: ATOM_ON_OSMOSIS.slice("ibc/".length),
};

/* -------------------------------------------------------------------------- *
 * createChannelDirectory
 * -------------------------------------------------------------------------- */

test("createChannelDirectory derives the reverse of a link that names its counterparty", () => {
  const back = directory.from("osmosis-1").find((l) => l.destChainId === "cosmoshub-4");
  assert.ok(back);
  assert.equal(back.channelId, "channel-0");
  assert.equal(back.counterpartyChannelId, "channel-141");
  assert.equal(back.derived, true);
});

test("createChannelDirectory leaves a link without a counterparty one-way", () => {
  const oneWay = createChannelDirectory([
    { sourceChainId: "a-1", destChainId: "b-1", channelId: "channel-1" },
  ]);
  assert.equal(oneWay.from("a-1").length, 1);
  assert.equal(oneWay.from("b-1").length, 0);
});

test("createChannelDirectory prefers an explicit link over a derived one", () => {
  const both = createChannelDirectory([
    {
      sourceChainId: "a-1",
      destChainId: "b-1",
      channelId: "channel-1",
      counterpartyChannelId: "channel-2",
    },
    {
      sourceChainId: "b-1",
      destChainId: "a-1",
      channelId: "channel-2",
      counterpartyChannelId: "channel-1",
      source: "verified",
      state: "open",
    },
  ]);
  const back = both.from("b-1")[0];
  assert.ok(back);
  assert.equal(back.source, "verified");
  assert.notEqual(back.derived, true);
});

test("createChannelDirectory drops rows with missing ids", () => {
  const sparse = createChannelDirectory([
    { sourceChainId: "", destChainId: "b-1", channelId: "channel-1" },
    { sourceChainId: "a-1", destChainId: "", channelId: "channel-1" },
    { sourceChainId: "a-1", destChainId: "b-1", channelId: "" },
  ]);
  assert.equal(sparse.from("a-1").length, 0);
});

test("deriveReverse can be turned off", () => {
  const forward = createChannelDirectory(LINKS, { deriveReverse: false });
  assert.equal(forward.from("osmosis-1").length, 1);
});

/* -------------------------------------------------------------------------- *
 * findRoutePaths
 * -------------------------------------------------------------------------- */

test("findRoutePaths returns shortest paths first", () => {
  const paths = findRoutePaths("safrochain-1", "stargaze-1", directory, { maxHops: 4 });
  assert.ok(paths.length > 0);
  const lengths = paths.map((p) => p.links.length);
  assert.deepEqual([...lengths].sort((a, b) => a - b), lengths);
  const first = paths[0];
  assert.ok(first);
  assert.deepEqual(first.chainIds, ["safrochain-1", "osmosis-1", "juno-1", "stargaze-1"]);
});

test("findRoutePaths never revisits a chain", () => {
  const paths = findRoutePaths("cosmoshub-4", "juno-1", directory, { maxHops: 5 });
  for (const path of paths) {
    assert.equal(new Set(path.chainIds).size, path.chainIds.length);
  }
});

test("findRoutePaths respects the hop budget", () => {
  assert.equal(findRoutePaths("safrochain-1", "stargaze-1", directory, { maxHops: 2 }).length, 0);
  assert.equal(findRoutePaths("safrochain-1", "stargaze-1", directory, { maxHops: 3 }).length, 1);
});

test("findRoutePaths clamps a silly hop budget to the cap", () => {
  const paths = findRoutePaths("safrochain-1", "stargaze-1", directory, {
    maxHops: 500,
  });
  assert.ok(paths.every((p) => p.links.length <= MAX_HOPS_CAP));
});

test("findRoutePaths skips closed channels", () => {
  const closed = createChannelDirectory([
    {
      sourceChainId: "a-1",
      destChainId: "b-1",
      channelId: "channel-1",
      state: "closed",
    },
  ]);
  assert.equal(findRoutePaths("a-1", "b-1", closed, {}).length, 0);
});

test("findRoutePaths caps channels per chain pair", () => {
  const many = createChannelDirectory(
    ["channel-1", "channel-2", "channel-3", "channel-4", "channel-5"].map((id) => ({
      sourceChainId: "a-1",
      destChainId: "b-1",
      channelId: id,
    })),
    { deriveReverse: false },
  );
  assert.equal(findRoutePaths("a-1", "b-1", many, { maxLinksPerPair: 2 }).length, 2);
});

test("findRoutePaths returns nothing for a same-chain or empty request", () => {
  assert.deepEqual(findRoutePaths("a-1", "a-1", directory, {}), []);
  assert.deepEqual(findRoutePaths("", "b-1", directory, {}), []);
});

/* -------------------------------------------------------------------------- *
 * Strategy 1: bank send
 * -------------------------------------------------------------------------- */

test("same chain and same denom is a bank send with no hops", async () => {
  const result = await planRoute(
    request({ destChainId: "safrochain-1", recipient: SAFRO_ADDRESS }),
    deps(),
  );
  const best = result.best;
  assert.ok(best);
  assert.equal(best.strategy, "bank-send");
  assert.deepEqual(best.plan.hops, []);
  assert.equal(best.plan.memo, "");
  assert.equal(best.plan.requiresPfm, false);
  assert.equal(best.plan.requiresIbcHooks, false);
  assert.equal(best.requiresQuote, false);
  assert.equal(best.quote, null);
});

/* -------------------------------------------------------------------------- *
 * Strategy 2: same-chain swap
 * -------------------------------------------------------------------------- */

test("same chain and a different denom needs allowSwap", async () => {
  const result = await planRoute(
    request({
      destChainId: "safrochain-1",
      outputDenom: "uatom",
      recipient: SAFRO_ADDRESS,
    }),
    deps(),
  );
  assert.deepEqual(result.candidates, []);
  assert.ok(result.warnings.some((w) => w.includes("Swaps are turned off")));
});

test("same-chain swap is a contract call with no memo and no quote", async () => {
  const result = await planRoute(
    request({
      destChainId: "safrochain-1",
      outputDenom: "uatom",
      allowSwap: true,
      recipient: SAFRO_ADDRESS,
    }),
    deps({
      venues: [{ chainId: "safrochain-1", contractAddress: "addr_safro1router" }],
    }),
  );
  const best = result.best;
  assert.ok(best);
  assert.equal(best.strategy, "local-swap");
  assert.equal(best.plan.memo, "");
  assert.equal(best.plan.hops.length, 1);
  assert.equal(best.plan.hops[0]?.kind, "swap");
  assert.equal(best.plan.hops[0]?.channelId, "");
  assert.equal(best.requiresQuote, true);
  assert.equal(best.quote, null);
  assert.ok(best.plan.warnings.some((w) => w.includes("unknown until the pool is quoted")));
});

test("a same-chain swap needs a venue on that chain", async () => {
  const result = await planRoute(
    request({
      destChainId: "safrochain-1",
      outputDenom: "uatom",
      allowSwap: true,
      recipient: SAFRO_ADDRESS,
    }),
    deps(),
  );
  assert.deepEqual(result.candidates, []);
  assert.ok(result.warnings.some((w) => w.includes("No swap venue is configured")));
});

test("a chain that does not run CosmWasm cannot host a swap", async () => {
  const result = await planRoute(
    request({
      sourceChainId: "cosmoshub-4",
      destChainId: "cosmoshub-4",
      inputDenom: "uatom",
      outputDenom: "uosmo",
      allowSwap: true,
      recipient: "cosmos1recipient",
    }),
    deps({ venues: [{ chainId: "cosmoshub-4", contractAddress: "cosmos1router" }] }),
  );
  assert.deepEqual(result.candidates, []);
  assert.ok(result.warnings.some((w) => w.includes("does not run CosmWasm")));
});

/* -------------------------------------------------------------------------- *
 * Strategy 3: cross-chain, same asset
 * -------------------------------------------------------------------------- */

test("a direct channel is a plain transfer with no memo", async () => {
  const result = await planRoute(request(), deps());
  const best = result.best;
  assert.ok(best);
  assert.equal(best.strategy, "ibc-transfer");
  assert.equal(best.plan.memo, "");
  assert.equal(best.receiver, "osmo1recipient");
  assert.equal(best.packetHopCount, 1);
  assert.deepEqual(best.plan.hops, [
    {
      chainId: "safrochain-1",
      channelId: "channel-0",
      port: "transfer",
      counterpartyChainId: "osmosis-1",
      kind: "transfer",
    },
  ]);
});

test("the destination denom is the real ibc hash of the wrapped path", async () => {
  const result = await planRoute(
    request({
      sourceChainId: "cosmoshub-4",
      destChainId: "osmosis-1",
      inputDenom: "uatom",
      sender: "cosmos1sender",
    }),
    deps(),
  );
  assert.equal(result.best?.plan.outputDenom, ATOM_ON_OSMOSIS);
});

test("the reverse direction hashes with the counterparty channel", async () => {
  const result = await planRoute(
    request({
      sourceChainId: "osmosis-1",
      destChainId: "cosmoshub-4",
      inputDenom: "uosmo",
      sender: "osmo1sender",
      recipient: "cosmos1recipient",
    }),
    deps(),
  );
  assert.equal(result.best?.plan.outputDenom, OSMO_ON_HUB);
});

test("a two-hop route nests one forward with the real recipient", async () => {
  const result = await planRoute(
    request({ destChainId: "juno-1", recipient: "juno1recipient" }),
    deps(),
  );
  const best = result.best;
  assert.ok(best);
  assert.equal(best.strategy, "ibc-forward");
  assert.equal(best.plan.requiresPfm, true);
  assert.equal(best.plan.requiresIbcHooks, false);

  const memo = memoOf(best);
  assert.deepEqual(Object.keys(memo), ["forward"]);
  const forward = objectAt(memo, "forward");
  assert.equal(forward.receiver, "juno1recipient");
  assert.equal(forward.port, "transfer");
  assert.equal(forward.channel, "channel-42");
  assert.equal(forward.timeout, "10m");
  assert.equal(forward.retries, 2);
  // A single forward has nothing after it, and `undefined` is dropped by
  // JSON.stringify, so the key must not be on the wire at all.
  assert.equal("next" in forward, false);

  assert.deepEqual(
    best.plan.hops.map((hop) => hop.kind),
    ["transfer", "forward"],
  );
});

test("a three-hop route nests forwards outermost-first with pfm placeholders", async () => {
  const result = await planRoute(
    request({ destChainId: "stargaze-1", recipient: "stars1recipient", maxHops: 3 }),
    deps(),
  );
  const best = result.best;
  assert.ok(best);
  const outer = objectAt(memoOf(best), "forward");
  assert.equal(outer.receiver, "pfm");
  assert.equal(outer.channel, "channel-42");
  const inner = objectAt(objectAt(outer, "next"), "forward");
  assert.equal(inner.receiver, "stars1recipient");
  assert.equal(inner.channel, "channel-5");
  assert.equal("next" in inner, false);
  assert.ok(best.plan.warnings.some((w) => w.includes("3 hops")));
});

test("the first packet is addressed to the intermediate chain, not the recipient", async () => {
  const withoutReceivers = await planRoute(
    request({ destChainId: "juno-1", recipient: "juno1recipient" }),
    deps(),
  );
  assert.equal(withoutReceivers.best?.receiver, "pfm");
  assert.ok(
    withoutReceivers.best?.plan.warnings.some((w) =>
      w.includes("No receiver address for Osmosis"),
    ),
  );

  const withReceivers = await planRoute(
    request({ destChainId: "juno-1", recipient: "juno1recipient" }),
    deps(),
    { intermediateReceivers: { "osmosis-1": "osmo1intermediate" } },
  );
  assert.equal(withReceivers.best?.receiver, "osmo1intermediate");
  assert.equal(
    withReceivers.best?.plan.warnings.some((w) => w.includes("No receiver address")),
    false,
  );
});

test("timeout and retries follow the request and the options", async () => {
  const result = await planRoute(
    request({ destChainId: "juno-1", recipient: "juno1recipient", timeoutMinutes: 25 }),
    deps(),
    { pfmRetries: 5 },
  );
  const best = result.best;
  assert.ok(best);
  const forward = objectAt(memoOf(best), "forward");
  assert.equal(forward.timeout, "25m");
  assert.equal(forward.retries, 5);
});

test("allowPfm false rules out everything but a direct channel", async () => {
  const result = await planRoute(
    request({ destChainId: "juno-1", recipient: "juno1recipient", allowPfm: false }),
    deps(),
  );
  assert.deepEqual(result.candidates, []);
  assert.ok(result.warnings.some((w) => w.includes("Packet forwarding is turned off")));
});

test("a chain that does not run PFM is a warning, not a refusal", async () => {
  const result = await planRoute(
    request({ destChainId: "stargaze-1", recipient: "stars1recipient" }),
    deps(),
  );
  const best = result.best;
  assert.ok(best);
  assert.ok(
    best.plan.warnings.some((w) =>
      w.includes("Juno does not run packet-forward-middleware"),
    ),
  );

  const strict = await planRoute(
    request({ destChainId: "stargaze-1", recipient: "stars1recipient" }),
    deps(),
    { requirePfmSupport: true },
  );
  assert.deepEqual(strict.candidates, []);
});

test("an unverified channel is flagged", async () => {
  const result = await planRoute(
    request({
      sourceChainId: "juno-1",
      destChainId: "stargaze-1",
      inputDenom: "ujuno",
      sender: "juno1sender",
      recipient: "stars1recipient",
    }),
    deps(),
  );
  const best = result.best;
  assert.ok(best);
  assert.equal(best.unverifiedChannelCount, 1);
  assert.ok(
    best.plan.warnings.some((w) => w.includes("has not been verified as open")),
  );
});

test("mixing mainnet and testnet is called out", async () => {
  const result = await planRoute(
    request({
      sourceChainId: "safro-testnet-1",
      destChainId: "osmosis-1",
      inputDenom: "usafro",
    }),
    deps(),
  );
  assert.ok(
    result.best?.plan.warnings.some((w) => w.includes("mixes mainnet and testnet")),
  );
});

test("an unknown counterparty channel costs the destination denom, not the route", async () => {
  const partial = createChannelDirectory(
    [{ sourceChainId: "safrochain-1", destChainId: "osmosis-1", channelId: "channel-0" }],
    { deriveReverse: false },
  );
  const result = await planRoute(request(), deps({ channels: partial }));
  const best = result.best;
  assert.ok(best);
  assert.equal(best.plan.outputDenom, "usafro");
  assert.ok(best.plan.warnings.some((w) => w.includes("counterparty of channel-0")));
  assert.ok(
    best.plan.warnings.some((w) => w.includes("could not be computed")),
  );
});

test("a Safrochain recipient keeps its underscore prefix verbatim in the memo", async () => {
  // `addr_safro` contains an underscore, which is legal in a bech32 HRP and
  // which nothing in the planner may normalise, split or lowercase. Route two
  // hops so the address lands inside a nested forward rather than in a field
  // the planner merely copies.
  const result = await planRoute(
    request({
      sourceChainId: "cosmoshub-4",
      destChainId: "safrochain-1",
      inputDenom: "uatom",
      sender: "cosmos1sender",
      recipient: SAFRO_ADDRESS,
    }),
    deps(),
  );
  const best = result.best;
  assert.ok(best);
  assert.equal(best.strategy, "ibc-forward");
  const forward = objectAt(memoOf(best), "forward");
  assert.equal(forward.receiver, SAFRO_ADDRESS);
  assert.ok(best.plan.memo.includes(SAFRO_ADDRESS));
  // And no candidate mangles it either.
  for (const candidate of result.candidates) {
    if (candidate.plan.memo === "") continue;
    assert.ok(candidate.plan.memo.includes(SAFRO_ADDRESS));
  }
});

test("byPrefix finds every chain sharing the addr_safro prefix", () => {
  // The registry contract says prefixes are not unique and must be matched
  // whole; `addr_safro` must never be treated as `addr` plus a separator.
  const rows = registry.byPrefix("addr_safro").map((row) => row.chainId);
  assert.deepEqual(rows.sort(), ["safro-testnet-1", "safrochain-1"]);
  assert.deepEqual(registry.byPrefix("addr"), []);
});

/* -------------------------------------------------------------------------- *
 * Strategy 5: unwinding a wrapped denom
 * -------------------------------------------------------------------------- */

test("a wrapped token unwinds along the channel it arrived on", async () => {
  const result = await planRoute(
    request({
      sourceChainId: "osmosis-1",
      destChainId: "cosmoshub-4",
      inputDenom: ATOM_ON_OSMOSIS,
      sender: "osmo1sender",
      recipient: "cosmos1recipient",
    }),
    deps({ resolveDenom: resolverFor({ [ATOM_ON_OSMOSIS]: ATOM_ON_OSMOSIS_TRACE }) }),
  );
  const best = result.best;
  assert.ok(best);
  assert.equal(best.unwindsDenom, true);
  assert.equal(best.links[0]?.channelId, "channel-0");
  // Unwinding one hop leaves the token native on its origin chain.
  assert.equal(best.plan.outputDenom, "uatom");
  assert.equal(result.resolvedInput?.originChainId, "cosmoshub-4");
});

test("forwarding a wrapped token onward is offered but ranked below unwinding", async () => {
  const result = await planRoute(
    request({
      sourceChainId: "osmosis-1",
      destChainId: "juno-1",
      inputDenom: ATOM_ON_OSMOSIS,
      sender: "osmo1sender",
      recipient: "juno1recipient",
      maxHops: 3,
    }),
    deps({ resolveDenom: resolverFor({ [ATOM_ON_OSMOSIS]: ATOM_ON_OSMOSIS_TRACE }) }),
  );
  const best = result.best;
  assert.ok(best);
  assert.equal(best.unwindsDenom, true);
  // Back to the Hub over the channel the token arrived on, then out to Juno.
  assert.deepEqual(
    best.links.map((l) => l.channelId),
    ["channel-0", "channel-207"],
  );
  assert.deepEqual(best.plan.hops.map((h) => h.counterpartyChainId), [
    "cosmoshub-4",
    "juno-1",
  ]);

  const direct = result.candidates.find((c) => !c.unwindsDenom);
  assert.ok(direct, "the double-wrapping route is still offered");
  assert.ok(direct.score > best.score);
  assert.ok(
    direct.plan.warnings.some((w) => w.includes("double-wrapped denom")),
  );
  // The onward route really does double-wrap: transfer/channel-0 (Juno's end of
  // the Osmosis channel) prefixed onto the existing transfer/channel-0.
  assert.ok(direct.plan.outputDenom.startsWith("ibc/"));
  assert.notEqual(direct.plan.outputDenom, ATOM_ON_OSMOSIS);
});

test("the unwind channel is added to the graph when the directory has never seen it", async () => {
  const bare = createChannelDirectory([], { deriveReverse: false });
  const result = await planRoute(
    request({
      sourceChainId: "osmosis-1",
      destChainId: "cosmoshub-4",
      inputDenom: ATOM_ON_OSMOSIS,
      sender: "osmo1sender",
      recipient: "cosmos1recipient",
    }),
    deps({
      channels: bare,
      resolveDenom: resolverFor({ [ATOM_ON_OSMOSIS]: ATOM_ON_OSMOSIS_TRACE }),
    }),
  );
  assert.equal(result.best?.links[0]?.channelId, "channel-0");
  assert.equal(result.best?.unwindsDenom, true);
});

test("a multi-hop trace whose unwind channel is unknown warns instead of guessing", async () => {
  const twoHopTrace: ResolvedDenom = {
    denom: "ibc/DEADBEEF",
    baseDenom: "uatom",
    path: "transfer/channel-777/transfer/channel-0",
    hops: [
      { port: "transfer", channelId: "channel-777" },
      { port: "transfer", channelId: "channel-0" },
    ],
    originChainId: "cosmoshub-4",
    isNative: false,
    ibcHash: "DEADBEEF",
  };
  const result = await planRoute(
    request({
      sourceChainId: "osmosis-1",
      destChainId: "cosmoshub-4",
      inputDenom: "ibc/DEADBEEF",
      sender: "osmo1sender",
      recipient: "cosmos1recipient",
    }),
    deps({ resolveDenom: resolverFor({ "ibc/DEADBEEF": twoHopTrace }) }),
  );
  assert.ok(
    result.warnings.some((w) =>
      w.includes("channel-777 unwinds this token but is not in the channel list"),
    ),
  );
});

test("a resolver that throws leaves a warning and still plans", async () => {
  const result = await planRoute(
    request({
      sourceChainId: "osmosis-1",
      destChainId: "cosmoshub-4",
      inputDenom: ATOM_ON_OSMOSIS,
      sender: "osmo1sender",
      recipient: "cosmos1recipient",
    }),
    deps({
      resolveDenom: async () => {
        throw new Error("lcd down");
      },
    }),
  );
  assert.ok(result.best);
  assert.equal(result.resolvedInput, null);
  assert.ok(result.warnings.some((w) => w.includes("Could not read the denom trace")));
});

test("without a resolver a wrapped denom stays opaque", async () => {
  const result = await planRoute(
    request({
      sourceChainId: "osmosis-1",
      destChainId: "cosmoshub-4",
      inputDenom: ATOM_ON_OSMOSIS,
      sender: "osmo1sender",
      recipient: "cosmos1recipient",
    }),
    deps({ resolveDenom: undefined }),
  );
  assert.ok(result.warnings.some((w) => w.includes("No denom resolver was supplied")));
  assert.ok(
    result.best?.plan.warnings.some((w) => w.includes("could not be computed")),
  );
});

test("a pre-resolved trace makes the planner fully synchronous in effect", async () => {
  const result = await planRoute(
    request({
      sourceChainId: "osmosis-1",
      destChainId: "cosmoshub-4",
      inputDenom: ATOM_ON_OSMOSIS,
      sender: "osmo1sender",
      recipient: "cosmos1recipient",
    }),
    deps({
      resolveDenom: async () => {
        throw new Error("must not be called");
      },
    }),
    { resolvedInput: ATOM_ON_OSMOSIS_TRACE },
  );
  assert.equal(result.best?.plan.outputDenom, "uatom");
});

test("a malformed trace path is truncated to whole hops, not guessed at", async () => {
  const odd: ResolvedDenom = {
    denom: ATOM_ON_OSMOSIS,
    baseDenom: "uatom",
    // Trailing "transfer" with no channel: one complete hop, one fragment.
    path: "transfer/channel-0/transfer",
    hops: [{ port: "transfer", channelId: "channel-0" }],
    originChainId: "cosmoshub-4",
    isNative: false,
    ibcHash: ATOM_ON_OSMOSIS.slice("ibc/".length),
  };
  const result = await planRoute(
    request({
      sourceChainId: "osmosis-1",
      destChainId: "cosmoshub-4",
      inputDenom: ATOM_ON_OSMOSIS,
      sender: "osmo1sender",
      recipient: "cosmos1recipient",
    }),
    deps({ resolveDenom: resolverFor({ [ATOM_ON_OSMOSIS]: odd }) }),
  );
  assert.equal(result.best?.plan.outputDenom, "uatom");
});

/* -------------------------------------------------------------------------- *
 * Strategy 4: cross-chain swap
 * -------------------------------------------------------------------------- */

test("a cross-chain swap builds a wasm memo with exactly contract and msg", async () => {
  const result = await planRoute(
    request({
      destChainId: "osmosis-1",
      outputDenom: "uosmo",
      allowSwap: true,
      slippagePercent: 20,
      recoveryAddress: "osmo1recovery",
    }),
    deps(),
  );
  const best = result.best;
  assert.ok(best);
  assert.equal(best.strategy, "ibc-swap");
  assert.equal(best.plan.requiresIbcHooks, true);
  assert.equal(best.plan.requiresPfm, false);
  assert.equal(best.requiresQuote, true);
  assert.equal(best.quote, null);

  const memo = memoOf(best);
  assert.deepEqual(Object.keys(memo), ["wasm"]);
  const wasm = objectAt(memo, "wasm");
  // The middleware rejects the packet unless this object holds exactly these
  // two keys, in any order.
  assert.deepEqual([...Object.keys(wasm)].sort(), ["contract", "msg"]);
  assert.equal(wasm.contract, OSMOSIS_XCS);

  const swap = objectAt(objectAt(wasm, "msg"), "osmosis_swap");
  assert.equal(swap.output_denom, "uosmo");
  assert.equal(swap.receiver, "osmo1recipient");
  assert.equal(swap.next_memo, null);
  assert.deepEqual(swap.on_failed_delivery, { local_recovery_addr: "osmo1recovery" });
  assert.deepEqual(swap.slippage, {
    twap: { slippage_percentage: "20", window_seconds: 10 },
  });

  // ibc-hooks requires the ICS20 receiver to be "" or the contract address.
  assert.equal(best.receiver, OSMOSIS_XCS);
});

test("no recovery address means do_nothing, and the user is told", async () => {
  const result = await planRoute(
    request({ destChainId: "osmosis-1", outputDenom: "uosmo", allowSwap: true }),
    deps(),
  );
  const best = result.best;
  assert.ok(best);
  const swap = objectAt(objectAt(objectAt(memoOf(best), "wasm"), "msg"), "osmosis_swap");
  assert.equal(swap.on_failed_delivery, "do_nothing");
  assert.ok(result.warnings.some((w) => w.includes("cannot be reclaimed")));
});

test("a quoted minimum switches the slippage form", async () => {
  const result = await planRoute(
    request({ destChainId: "osmosis-1", outputDenom: "uosmo", allowSwap: true }),
    deps(),
    { minOutputAmount: "990000" },
  );
  const best = result.best;
  assert.ok(best);
  const swap = objectAt(objectAt(objectAt(memoOf(best), "wasm"), "msg"), "osmosis_swap");
  assert.deepEqual(swap.slippage, { min_output_amount: "990000" });
});

test("a swap with a hop after it addresses the recipient and leaves next_memo null", async () => {
  const result = await planRoute(
    request({
      destChainId: "juno-1",
      outputDenom: "uosmo",
      allowSwap: true,
      recipient: "juno1recipient",
      maxHops: 3,
    }),
    deps(),
  );
  const best = result.best;
  assert.ok(best);
  const swap = objectAt(objectAt(objectAt(memoOf(best), "wasm"), "msg"), "osmosis_swap");
  // One outbound hop: the contract sends straight to the recipient, so nothing
  // needs forwarding afterwards.
  assert.equal(swap.receiver, "juno1recipient");
  assert.equal(swap.next_memo, null);
  assert.deepEqual(
    best.plan.hops.map((hop) => hop.kind),
    ["transfer", "swap", "forward"],
  );
  assert.equal(best.plan.hops[1]?.channelId, "");
  assert.equal(best.plan.hops[1]?.counterpartyChainId, "osmosis-1");
});

test("two hops after the swap put a forward in next_memo", async () => {
  const result = await planRoute(
    request({
      destChainId: "stargaze-1",
      outputDenom: "uosmo",
      allowSwap: true,
      recipient: "stars1recipient",
      maxHops: 3,
    }),
    deps(),
    { intermediateReceivers: { "juno-1": "juno1intermediate" } },
  );
  const best = result.best;
  assert.ok(best);
  const swap = objectAt(objectAt(objectAt(memoOf(best), "wasm"), "msg"), "osmosis_swap");
  assert.equal(swap.receiver, "juno1intermediate");
  const forward = objectAt(swap.next_memo, "forward");
  assert.equal(forward.channel, "channel-5");
  assert.equal(forward.receiver, "stars1recipient");
  assert.equal(best.plan.requiresPfm, true);
});

test("a hop before the swap wraps the wasm memo in a forward to the contract", async () => {
  const result = await planRoute(
    request({
      sourceChainId: "cosmoshub-4",
      destChainId: "osmosis-1",
      inputDenom: "uatom",
      outputDenom: "uosmo",
      allowSwap: true,
      sender: "cosmos1sender",
      maxHops: 3,
    }),
    deps(),
    { intermediateReceivers: { "juno-1": "juno1intermediate" } },
  );
  const viaJuno = result.candidates.find((c) => c.links[0]?.channelId === "channel-207");
  assert.ok(viaJuno, "the route through Juno should be offered");
  const forward = objectAt(memoOf(viaJuno), "forward");
  // The forward that lands on Osmosis must address the contract, and the wasm
  // memo rides in `next` so ibc-hooks sees it on arrival.
  assert.equal(forward.receiver, OSMOSIS_XCS);
  const wasm = objectAt(objectAt(forward, "next"), "wasm");
  assert.deepEqual([...Object.keys(wasm)].sort(), ["contract", "msg"]);
  assert.equal(viaJuno.receiver, "juno1intermediate");
  assert.equal(viaJuno.plan.requiresPfm, true);
  assert.equal(viaJuno.plan.requiresIbcHooks, true);
});

test("a venue on the source chain is not planned as one route", async () => {
  const result = await planRoute(
    request({
      sourceChainId: "osmosis-1",
      destChainId: "juno-1",
      inputDenom: "uosmo",
      outputDenom: "ujuno",
      allowSwap: true,
      sender: "osmo1sender",
      recipient: "juno1recipient",
    }),
    deps(),
  );
  assert.deepEqual(result.candidates, []);
  assert.ok(result.warnings.some((w) => w.includes("takes two transactions")));
});

test("a venue whose denom list excludes the arriving token is flagged", async () => {
  const result = await planRoute(
    request({ destChainId: "osmosis-1", outputDenom: "uosmo", allowSwap: true }),
    deps({ venues: [{ chainId: "osmosis-1", contractAddress: OSMOSIS_XCS, denoms: ["uosmo"] }] }),
  );
  const best = result.best;
  assert.ok(best);
  assert.ok(best.plan.warnings.some((w) => w.includes("does not list")));
});

test("an unknown venue denom list is a warning, not a block", async () => {
  const result = await planRoute(
    request({ destChainId: "osmosis-1", outputDenom: "uosmo", allowSwap: true }),
    deps(),
  );
  assert.ok(
    result.best?.plan.warnings.some((w) => w.includes("tradeable denoms")),
  );
});

test("ibc-hooks support that is denied can be made fatal", async () => {
  const noHooks = deps({
    capabilities: (chainId) =>
      chainId === "osmosis-1" ? { pfm: true, ibcHooks: false, cosmwasm: true } : CAPABILITIES[chainId],
  });
  const lenient = await planRoute(
    request({ destChainId: "osmosis-1", outputDenom: "uosmo", allowSwap: true }),
    noHooks,
  );
  assert.ok(lenient.best);
  assert.ok(
    lenient.best.plan.warnings.some((w) => w.includes("does not run ibc-hooks")),
  );

  const strict = await planRoute(
    request({ destChainId: "osmosis-1", outputDenom: "uosmo", allowSwap: true }),
    noHooks,
    { requireIbcHooksSupport: true },
  );
  assert.deepEqual(strict.candidates, []);
});

test("no venue configured means no cross-chain swap", async () => {
  const result = await planRoute(
    request({ destChainId: "osmosis-1", outputDenom: "uosmo", allowSwap: true }),
    deps({ venues: [] }),
  );
  assert.deepEqual(result.candidates, []);
  assert.ok(result.warnings.some((w) => w.includes("No swap venue is configured")));
});

test("a venue chain missing from the registry is reported, not thrown", async () => {
  const result = await planRoute(
    request({ destChainId: "osmosis-1", outputDenom: "uosmo", allowSwap: true }),
    deps({ venues: [{ chainId: "nowhere-1", contractAddress: "nowhere1contract" }] }),
  );
  assert.deepEqual(result.candidates, []);
  assert.ok(result.warnings.some((w) => w.includes("is not in the registry")));
});

/* -------------------------------------------------------------------------- *
 * Manual overrides
 * -------------------------------------------------------------------------- */

test("an override alone can build a route when discovery found nothing", async () => {
  const bare = createChannelDirectory([], { deriveReverse: false });
  const result = await planRoute(request(), deps({ channels: bare }), {
    overrides: [
      {
        fromChainId: "safrochain-1",
        toChainId: "osmosis-1",
        channelId: "channel-77",
        counterpartyChannelId: "channel-88",
      },
    ],
  });
  const best = result.best;
  assert.ok(best);
  assert.equal(best.links[0]?.channelId, "channel-77");
  assert.equal(best.links[0]?.source, "manual");
  assert.ok(
    best.plan.warnings.some((w) => w.includes("entered by hand and has not been checked")),
  );
});

test("an override by hop index replaces the channel the search chose", async () => {
  const result = await planRoute(
    request({ destChainId: "juno-1", recipient: "juno1recipient" }),
    deps(),
    { overrides: [{ hopIndex: 1, channelId: "channel-1234" }] },
  );
  const best = result.best;
  assert.ok(best);
  assert.equal(best.links[1]?.channelId, "channel-1234");
  const forward = objectAt(memoOf(best), "forward");
  assert.equal(forward.channel, "channel-1234");
});

test("an override by chain pair replaces every matching hop", async () => {
  const result = await planRoute(request(), deps(), {
    overrides: [
      { fromChainId: "safrochain-1", toChainId: "osmosis-1", channelId: "channel-555" },
    ],
  });
  assert.ok(result.candidates.every((c) => c.links[0]?.channelId === "channel-555"));
});

/* -------------------------------------------------------------------------- *
 * Failure and edge cases
 * -------------------------------------------------------------------------- */

test("an unknown chain is unsupported-chain, on either side", async () => {
  await assert.rejects(
    () => planRoute(request({ sourceChainId: "nope-1" }), deps()),
    (error: unknown) =>
      isInterchainError(error) &&
      error.code === "unsupported-chain" &&
      error.chainId === "nope-1",
  );
  await assert.rejects(
    () => planRoute(request({ destChainId: "nope-1" }), deps()),
    (error: unknown) => isInterchainError(error) && error.code === "unsupported-chain",
  );
});

test("no path is an empty result, and bestRoutePlan turns it into no-route", async () => {
  const result = await planRoute(
    request({ destChainId: "norest-1", recipient: "norest1recipient" }),
    deps(),
  );
  assert.deepEqual(result.candidates, []);
  assert.equal(result.best, null);
  assert.ok(result.warnings.some((w) => w.includes("No channel path")));

  await assert.rejects(
    () => bestRoutePlan(request({ destChainId: "norest-1", recipient: "norest1recipient" }), deps()),
    (error: unknown) =>
      isInterchainError(error) &&
      error.code === "no-route" &&
      error.message.includes("No channel path"),
  );
});

test("bestRoutePlan returns the top plan when one exists", async () => {
  const plan = await bestRoutePlan(request(), deps());
  assert.equal(plan.sourceChainId, "safrochain-1");
  assert.equal(plan.destChainId, "osmosis-1");
  assert.equal(plan.hops.length, 1);
});

test("an amount that is not base units is warned about, not rejected", async () => {
  const result = await planRoute(request({ amount: "1.5" }), deps());
  assert.ok(result.best);
  assert.ok(result.warnings.some((w) => w.includes("whole number of base units")));
});

test("an empty recipient is warned about", async () => {
  const result = await planRoute(request({ recipient: "" }), deps());
  assert.ok(result.warnings.some((w) => w.includes("No recipient address")));
});

test("the hop budget is clamped to the cap", async () => {
  const result = await planRoute(
    request({ destChainId: "stargaze-1", recipient: "stars1recipient", maxHops: 99 }),
    deps(),
  );
  assert.ok(result.candidates.every((c) => c.packetHopCount <= MAX_HOPS_CAP));
});

test("candidates are capped and ordered by score", async () => {
  const result = await planRoute(
    request({ destChainId: "stargaze-1", recipient: "stars1recipient", maxHops: 3 }),
    deps(),
    { maxCandidates: 1 },
  );
  assert.ok(result.candidates.length <= 1);

  const all = await planRoute(
    request({ destChainId: "stargaze-1", recipient: "stars1recipient", maxHops: 3 }),
    deps(),
  );
  const scores = all.candidates.map((c) => c.score);
  assert.deepEqual([...scores].sort((a, b) => a - b), scores);
});

test("planning is deterministic", async () => {
  const first = await planRoute(request({ destChainId: "juno-1", recipient: "juno1recipient" }), deps());
  const second = await planRoute(request({ destChainId: "juno-1", recipient: "juno1recipient" }), deps());
  assert.deepEqual(first.candidates, second.candidates);
});

test("a hasher that cannot run leaves the denom unknown instead of wrong", async () => {
  const result = await planRoute(request(), deps(), {
    hashDenom: async () => null,
  });
  const best = result.best;
  assert.ok(best);
  assert.equal(best.plan.outputDenom, "usafro");
  assert.ok(best.plan.warnings.some((w) => w.includes("could not be computed")));
});

test("duration estimates grow with the hop count and can be overridden", async () => {
  const oneHop = await planRoute(request(), deps());
  const twoHop = await planRoute(
    request({ destChainId: "juno-1", recipient: "juno1recipient" }),
    deps(),
  );
  assert.ok(oneHop.best);
  assert.ok(twoHop.best);
  assert.ok(
    twoHop.best.plan.estimatedDurationSeconds >
      oneHop.best.plan.estimatedDurationSeconds,
  );

  const custom = await planRoute(request(), deps(), {
    durations: { baseSeconds: 1, perPacketHopSeconds: 2 },
  });
  assert.equal(custom.best?.plan.estimatedDurationSeconds, 3);
});

test("the default hop budget is what the contract documents", () => {
  assert.equal(DEFAULT_MAX_HOPS, 3);
  assert.ok(MAX_HOPS_CAP >= DEFAULT_MAX_HOPS);
});

test("a memo is either empty or a JSON object, never null or a bare string", async () => {
  const requests: readonly RouteRequest[] = [
    request(),
    request({ destChainId: "juno-1", recipient: "juno1recipient" }),
    request({ destChainId: "osmosis-1", outputDenom: "uosmo", allowSwap: true }),
  ];
  for (const req of requests) {
    const result = await planRoute(req, deps());
    for (const candidate of result.candidates) {
      if (candidate.plan.memo === "") continue;
      const parsed: unknown = JSON.parse(candidate.plan.memo);
      assert.ok(parsed !== null && typeof parsed === "object");
      const keys = Object.keys(parsed as JsonObject);
      assert.deepEqual(keys.length, 1);
      assert.ok(keys[0] === "forward" || keys[0] === "wasm");
    }
  }
});
