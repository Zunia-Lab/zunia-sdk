import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_ROUTE_MAX_AGE_MS,
  SEED_CHANNEL_ROUTES,
  bech32PrefixOf,
  chainHasFeature,
  checkAddress,
  createChainRegistry,
  createRouteRegistry,
  deserializeRouteRegistry,
  featureSupport,
  inferChainsFromAddress,
  isAddressForChain,
  isRouteFresh,
  isValidBech32Address,
  parseChannelRoute,
  routeNeedsVerification,
  type ChannelRoute,
} from "./registry.js";
import { isInterchainError, type ChainInfoLike } from "./types.js";

/**
 * Address vectors from `zunia-core/tests/vectors/registry-addresses.json`,
 * which was generated with CosmJS from the chain registry. Using them keeps the
 * checksum implementation honest: nothing here was produced by the code under
 * test.
 */
const ADDRESSES = {
  safro: "addr_safro19rl4cm2hmr8afy4kldpxz3fka4jguq0ayvv259",
  safroValoper: "addr_safrovaloper19rl4cm2hmr8afy4kldpxz3fka4jguq0ajj8j94",
  cosmos: "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4",
  cosmosValoper: "cosmosvaloper19rl4cm2hmr8afy4kldpxz3fka4jguq0ae5egnx",
  osmo: "osmo19rl4cm2hmr8afy4kldpxz3fka4jguq0a5m7df8",
  juno: "juno19rl4cm2hmr8afy4kldpxz3fka4jguq0a2jwxcf",
  /** Corrupt: the same vector zunia-core's `rejects_corrupt_bech32` uses. */
  corrupt: "cosmos1nsqz24klmz0mkuvxjjdd3ptzhsfmhs0wcp5rrx",
} as const;

function chain(overrides: Partial<ChainInfoLike> & { chainId: string }): ChainInfoLike {
  return {
    chainName: overrides.chainId,
    bech32Prefix: "cosmos",
    coinType: 118,
    coinDenom: "ATOM",
    coinMinimalDenom: "uatom",
    coinDecimals: 6,
    feeDenom: "ATOM",
    feeMinimalDenom: "uatom",
    feeDecimals: 6,
    ...overrides,
  };
}

const SAFROCHAIN = chain({
  chainId: "safrochain-1",
  chainName: "Safrochain",
  bech32Prefix: "addr_safro",
  network: "mainnet",
  coinDenom: "SAF",
  coinMinimalDenom: "usaf",
  feeDenom: "SAF",
  feeMinimalDenom: "usaf",
  features: ["cosmwasm"],
});

const SAFRO_TESTNET = chain({
  chainId: "safro-testnet-1",
  chainName: "Safrochain Testnet",
  bech32Prefix: "addr_safro",
  network: "testnet",
  features: ["cosmwasm"],
});

const COSMOSHUB = chain({
  chainId: "cosmoshub-4",
  chainName: "Cosmos Hub",
  bech32Prefix: "cosmos",
  network: "mainnet",
  features: [],
});

const OSMOSIS = chain({
  chainId: "osmosis-1",
  chainName: "Osmosis",
  bech32Prefix: "osmo",
  network: "mainnet",
  features: ["cosmwasm", "ibc-transfer"],
});

const OSMO_TESTNET = chain({
  chainId: "osmo-test-5",
  chainName: "Osmosis Testnet",
  bech32Prefix: "osmo",
  network: "testnet",
});

/** No `network`, no `features`: what a hand-added chain usually looks like. */
const CUSTOM = chain({
  chainId: "my-devnet-1",
  chainName: "My Devnet",
  bech32Prefix: "addr",
});

const ALL_CHAINS = [
  SAFROCHAIN,
  SAFRO_TESTNET,
  COSMOSHUB,
  OSMOSIS,
  OSMO_TESTNET,
  CUSTOM,
];

/* -------------------------------------------------------------------------- *
 * Chain registry
 * -------------------------------------------------------------------------- */

test("registry looks chains up by id and reports membership", () => {
  const registry = createChainRegistry(ALL_CHAINS);

  assert.equal(registry.get("safrochain-1"), SAFROCHAIN);
  assert.equal(registry.get("  safrochain-1  "), SAFROCHAIN);
  assert.equal(registry.get("nope-1"), undefined);
  assert.equal(registry.has("osmosis-1"), true);
  assert.equal(registry.has(""), false);
  assert.equal(registry.list().length, ALL_CHAINS.length);
});

test("a later row with the same chain id overrides the earlier one", () => {
  // The extension appends user-added chains after the generated catalog and
  // expects them to win.
  const override = chain({
    chainId: "osmosis-1",
    chainName: "Osmosis (my node)",
    bech32Prefix: "osmo",
    network: "mainnet",
    rest: "https://lcd.example",
  });
  const registry = createChainRegistry([SAFROCHAIN, OSMOSIS, COSMOSHUB, override]);

  assert.equal(registry.get("osmosis-1"), override);
  assert.equal(registry.list().length, 3);
  // Position of the first appearance is kept, so pickers do not reorder when a
  // user overrides an endpoint.
  assert.deepEqual(
    registry.list().map((row) => row.chainId),
    ["safrochain-1", "osmosis-1", "cosmoshub-4"],
  );
});

test("registry drops rows that carry no usable chain id", () => {
  const junk = [
    SAFROCHAIN,
    { ...COSMOSHUB, chainId: "   " },
    { ...OSMOSIS, chainId: 7 } as unknown as ChainInfoLike,
    null as unknown as ChainInfoLike,
  ];
  const registry = createChainRegistry(junk);

  assert.deepEqual(
    registry.list().map((row) => row.chainId),
    ["safrochain-1"],
  );
});

test("prefix lookup is exact, so addr_safro does not collide", () => {
  const registry = createChainRegistry(ALL_CHAINS);

  assert.deepEqual(
    registry.byPrefix("addr_safro").map((row) => row.chainId),
    ["safrochain-1", "safro-testnet-1"],
  );
  // `addr` is a chain of its own here; a startsWith test would have swallowed
  // both Safrochain rows into it.
  assert.deepEqual(
    registry.byPrefix("addr").map((row) => row.chainId),
    ["my-devnet-1"],
  );
  // And `addr_safro` must not answer for the valoper prefix that extends it.
  assert.deepEqual(registry.byPrefix("addr_safrovaloper"), []);
  assert.deepEqual(registry.byPrefix("ADDR_SAFRO"), []);
  assert.deepEqual(registry.byPrefix(""), []);
});

test("prefix buckets put mainnets first", () => {
  const registry = createChainRegistry([OSMO_TESTNET, OSMOSIS]);

  assert.deepEqual(
    registry.byPrefix("osmo").map((row) => row.chainId),
    ["osmosis-1", "osmo-test-5"],
  );
});

test("network lists only contain chains that declare a network", () => {
  const registry = createChainRegistry(ALL_CHAINS);

  assert.deepEqual(
    registry.mainnets().map((row) => row.chainId),
    ["safrochain-1", "cosmoshub-4", "osmosis-1"],
  );
  assert.deepEqual(
    registry.testnets().map((row) => row.chainId),
    ["safro-testnet-1", "osmo-test-5"],
  );
  // The unlabelled chain is still in `list()`; it is just not claimed to be
  // either network.
  assert.equal(registry.has("my-devnet-1"), true);
});

test("feature support keeps 'never said' apart from 'no'", () => {
  const registry = createChainRegistry(ALL_CHAINS);

  assert.equal(featureSupport(SAFROCHAIN, "cosmwasm"), "yes");
  assert.equal(featureSupport(COSMOSHUB, "cosmwasm"), "no");
  assert.equal(featureSupport(CUSTOM, "cosmwasm"), "unknown");
  assert.equal(featureSupport(undefined, "cosmwasm"), "unknown");
  // The registry vocabulary is open, so spelling is normalised.
  assert.equal(
    featureSupport(chain({ chainId: "x-1", features: [" CosmWasm "] }), "cosmwasm"),
    "yes",
  );

  assert.equal(registry.supports("safrochain-1", "cosmwasm"), true);
  assert.equal(registry.supports("cosmoshub-4", "cosmwasm"), false);
  assert.equal(registry.supports("my-devnet-1", "cosmwasm"), false);
  assert.equal(registry.supports("nope-1", "cosmwasm"), false);
  assert.equal(chainHasFeature(undefined, "cosmwasm"), false);
});

test("prefixes are distinct and sorted", () => {
  const registry = createChainRegistry(ALL_CHAINS);
  assert.deepEqual(registry.prefixes(), ["addr", "addr_safro", "cosmos", "osmo"]);
});

test("registry results are frozen so a caller cannot corrupt the index", () => {
  const registry = createChainRegistry(ALL_CHAINS);
  assert.equal(Object.isFrozen(registry.list()), true);
  assert.equal(Object.isFrozen(registry.byPrefix("osmo")), true);
});

/* -------------------------------------------------------------------------- *
 * bech32
 * -------------------------------------------------------------------------- */

test("bech32 validation accepts the CosmJS golden vectors", () => {
  const valid = [
    ADDRESSES.safro,
    ADDRESSES.safroValoper,
    ADDRESSES.cosmos,
    ADDRESSES.cosmosValoper,
    ADDRESSES.osmo,
    ADDRESSES.juno,
  ];
  for (const address of valid) {
    assert.equal(isValidBech32Address(address), true, address);
  }
});

test("bech32 prefix survives the underscore in addr_safro", () => {
  assert.equal(bech32PrefixOf(ADDRESSES.safro), "addr_safro");
  assert.equal(bech32PrefixOf(ADDRESSES.safroValoper), "addr_safrovaloper");
  assert.equal(bech32PrefixOf(ADDRESSES.cosmos), "cosmos");
  assert.equal(bech32PrefixOf(`  ${ADDRESSES.osmo}  `), "osmo");
});

test("bech32 validation rejects malformed input", () => {
  const bad = [
    "",
    "   ",
    "not-an-address",
    // Corrupt payload, checksum no longer matches.
    ADDRESSES.corrupt,
    // Last character flipped.
    `${ADDRESSES.cosmos.slice(0, -1)}5`,
    // Separator but no data.
    "cosmos1",
    // Data shorter than the six checksum characters.
    "cosmos1qqqq",
    // `b` is not in the bech32 alphabet.
    `${ADDRESSES.cosmos.slice(0, -1)}b`,
    // No separator at all.
    "cosmos",
    // Empty human-readable part.
    "19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4",
    // Mixed case is forbidden by BIP-173.
    `Cosmos1${ADDRESSES.cosmos.slice(7)}`,
  ];
  for (const value of bad) {
    assert.equal(isValidBech32Address(value), false, `expected ${value} to fail`);
  }
});

test("an all-uppercase address is the same address", () => {
  assert.equal(isValidBech32Address(ADDRESSES.safro.toUpperCase()), true);
  assert.equal(bech32PrefixOf(ADDRESSES.safro.toUpperCase()), "addr_safro");
});

test("checkAddress reports why an address does not fit a chain", () => {
  assert.deepEqual(checkAddress(ADDRESSES.safro, SAFROCHAIN), {
    ok: true,
    problem: "ok",
    prefix: "addr_safro",
    expectedPrefix: "addr_safro",
  });
  assert.equal(checkAddress("", SAFROCHAIN).problem, "empty");
  assert.equal(checkAddress("not-an-address", SAFROCHAIN).problem, "malformed");
  assert.equal(checkAddress(ADDRESSES.corrupt, COSMOSHUB).problem, "bad-checksum");
  assert.equal(checkAddress(ADDRESSES.cosmos, SAFROCHAIN).problem, "wrong-prefix");
  assert.equal(checkAddress(ADDRESSES.cosmos, SAFROCHAIN).prefix, "cosmos");
});

test("a valoper address is never accepted for the account prefix it extends", () => {
  // The whole reason prefix matching is `===`: `addr_safro` is a strict prefix
  // of `addr_safrovaloper`, and both are valid bech32.
  assert.equal(isValidBech32Address(ADDRESSES.safroValoper), true);
  assert.equal(isAddressForChain(ADDRESSES.safroValoper, SAFROCHAIN), false);
  assert.equal(isAddressForChain(ADDRESSES.cosmosValoper, COSMOSHUB), false);
  assert.equal(isAddressForChain(ADDRESSES.safro, SAFROCHAIN), true);
  assert.equal(isAddressForChain(ADDRESSES.cosmos, COSMOSHUB), true);
});

test("chain inference returns every candidate, never one guess", () => {
  const registry = createChainRegistry(ALL_CHAINS);

  assert.deepEqual(
    inferChainsFromAddress(ADDRESSES.osmo, registry).map((row) => row.chainId),
    ["osmosis-1", "osmo-test-5"],
  );
  assert.deepEqual(
    inferChainsFromAddress(ADDRESSES.safro, registry).map((row) => row.chainId),
    ["safrochain-1", "safro-testnet-1"],
  );
  // A prefix nobody in the registry uses, and a valoper address, both yield
  // nothing rather than a near match.
  assert.deepEqual(inferChainsFromAddress(ADDRESSES.juno, registry), []);
  assert.deepEqual(inferChainsFromAddress(ADDRESSES.safroValoper, registry), []);
  assert.deepEqual(inferChainsFromAddress("not-an-address", registry), []);
  assert.deepEqual(inferChainsFromAddress("", registry), []);
});

test("inference still answers for a mistyped address", () => {
  const registry = createChainRegistry(ALL_CHAINS);
  // Checksum is broken, but telling the user "that looks like a Cosmos Hub
  // address" is exactly the help they need here.
  assert.deepEqual(
    inferChainsFromAddress(ADDRESSES.corrupt, registry).map((row) => row.chainId),
    ["cosmoshub-4"],
  );
});

/* -------------------------------------------------------------------------- *
 * Route registry
 * -------------------------------------------------------------------------- */

function route(overrides: Partial<ChannelRoute> = {}): ChannelRoute {
  return {
    sourceChainId: "safrochain-1",
    destChainId: "osmosis-1",
    channelId: "channel-3",
    counterpartyChannelId: "channel-7",
    verifiedAt: 1_000,
    source: "discovered",
    ...overrides,
  };
}

test("routes are stored per direction and channel", () => {
  const routes = createRouteRegistry();
  routes.put(route());
  routes.put(route({ channelId: "channel-4", counterpartyChannelId: "channel-8" }));
  routes.put(route({ sourceChainId: "osmosis-1", destChainId: "safrochain-1" }));

  assert.equal(routes.size, 3);
  assert.equal(routes.getAll("safrochain-1", "osmosis-1").length, 2);
  assert.equal(routes.getAll("osmosis-1", "safrochain-1").length, 1);
  assert.equal(routes.get("safrochain-1", "cosmoshub-4"), undefined);
  assert.equal(routes.get("", "osmosis-1"), undefined);
});

test("a bare channel number is canonicalised", () => {
  const routes = createRouteRegistry();
  const stored = routes.put(route({ channelId: "141", counterpartyChannelId: "0" }));

  assert.equal(stored.channelId, "channel-141");
  assert.equal(stored.counterpartyChannelId, "channel-0");
  assert.equal(routes.get("safrochain-1", "osmosis-1")?.channelId, "channel-141");
});

test("put rejects a route that could never work", () => {
  const routes = createRouteRegistry();
  const bad = [
    route({ sourceChainId: "" }),
    route({ destChainId: "  " }),
    route({ sourceChainId: "osmosis-1", destChainId: "osmosis-1" }),
    route({ channelId: "transfer/channel-3" }),
    route({ channelId: "" }),
  ];
  for (const value of bad) {
    assert.throws(() => routes.put(value), (error: unknown) =>
      isInterchainError(error) && error.code === "invalid-request");
  }
  assert.equal(routes.size, 0);
});

test("putMany skips what it cannot use instead of failing the batch", () => {
  // Discovery hands us whatever the LCD listed; one unusable row should not
  // cost us the rest of the page.
  const routes = createRouteRegistry();
  const stored = routes.putMany([
    route({ channelId: "channel-1" }),
    route({ channelId: "not-a-channel" }),
    route({ channelId: "channel-2" }),
  ]);

  assert.equal(stored, 2);
  assert.equal(routes.size, 2);
});

test("manual routes outrank discovered, which outrank seeds", () => {
  const routes = createRouteRegistry();
  routes.put(route({ channelId: "channel-1", source: "seed", verifiedAt: 0 }));
  routes.put(route({ channelId: "channel-2", source: "discovered", verifiedAt: 10 }));
  routes.put(route({ channelId: "channel-3", source: "manual", verifiedAt: 5 }));

  assert.equal(routes.get("safrochain-1", "osmosis-1")?.channelId, "channel-3");
  assert.deepEqual(
    routes.getAll("safrochain-1", "osmosis-1").map((row) => row.channelId),
    ["channel-3", "channel-2", "channel-1"],
  );
});

test("two discovered routes are ordered by how recently they were verified", () => {
  const routes = createRouteRegistry();
  routes.put(route({ channelId: "channel-1", verifiedAt: 10 }));
  routes.put(route({ channelId: "channel-2", verifiedAt: 99 }));

  assert.equal(routes.get("safrochain-1", "osmosis-1")?.channelId, "channel-2");
});

test("re-discovering a manual route keeps it manual", () => {
  const routes = createRouteRegistry();
  routes.put(route({ source: "manual", verifiedAt: 100, counterpartyChannelId: "channel-7" }));
  const merged = routes.put(
    route({ source: "discovered", verifiedAt: 500, counterpartyChannelId: "" }),
  );

  // Otherwise the next prune would silently delete a channel the user typed.
  assert.equal(merged.source, "manual");
  assert.equal(merged.verifiedAt, 500);
  // A blank counterparty never overwrites one we already know.
  assert.equal(merged.counterpartyChannelId, "channel-7");
  assert.equal(routes.size, 1);
});

test("a stale timestamp never moves verifiedAt backwards", () => {
  const routes = createRouteRegistry();
  routes.put(route({ verifiedAt: 500 }));
  const merged = routes.put(route({ verifiedAt: 100 }));
  assert.equal(merged.verifiedAt, 500);
});

test("prune drops stale discovered routes and nothing else", () => {
  let clock = 10_000;
  const routes = createRouteRegistry([], { now: () => clock });
  routes.put(route({ channelId: "channel-1", source: "discovered", verifiedAt: 1_000 }));
  routes.put(route({ channelId: "channel-2", source: "discovered", verifiedAt: 9_500 }));
  routes.put(route({ channelId: "channel-3", source: "manual", verifiedAt: 1 }));
  routes.put(route({ channelId: "channel-4", source: "seed", verifiedAt: 0 }));

  const removed = routes.prune(1_000);

  assert.deepEqual(
    removed.map((row) => row.channelId),
    ["channel-1"],
  );
  assert.deepEqual(
    routes.list().map((row) => row.channelId),
    ["channel-3", "channel-2", "channel-4"],
  );

  // Even a zero-age prune leaves the user's own entry and the compiled-in hint.
  clock = 20_000;
  routes.prune(0);
  assert.deepEqual(
    routes.list({ source: "discovered" }),
    [],
  );
  assert.equal(routes.size, 2);
  const badArg = (error: unknown): boolean =>
    isInterchainError(error) && error.code === "invalid-request";
  assert.throws(() => routes.prune(-1), badArg);
  assert.throws(() => routes.prune(Number.NaN), badArg);
});

test("remove and clear", () => {
  const routes = createRouteRegistry([route()]);

  assert.equal(routes.remove("safrochain-1", "osmosis-1", "141"), false);
  assert.equal(routes.remove("safrochain-1", "osmosis-1", "3"), true);
  assert.equal(routes.size, 0);

  routes.put(route());
  routes.clear();
  assert.equal(routes.size, 0);
});

test("list filters and stays in a stable order", () => {
  const routes = createRouteRegistry([
    route({ sourceChainId: "osmosis-1", destChainId: "cosmoshub-4", channelId: "channel-0" }),
    route({ channelId: "channel-2", source: "manual" }),
    route({ channelId: "channel-1" }),
  ]);

  assert.deepEqual(
    routes.list().map((row) => `${row.sourceChainId}:${row.channelId}`),
    ["osmosis-1:channel-0", "safrochain-1:channel-2", "safrochain-1:channel-1"],
  );
  assert.equal(routes.list({ sourceChainId: "osmosis-1" }).length, 1);
  assert.equal(routes.list({ destChainId: "osmosis-1" }).length, 2);
  assert.equal(routes.list({ source: "manual" }).length, 1);
});

test("a snapshot round-trips through JSON", () => {
  const routes = createRouteRegistry([
    route({ source: "manual" }),
    route({ channelId: "channel-9", verifiedAt: 42 }),
  ]);

  const restored = deserializeRouteRegistry(JSON.parse(JSON.stringify(routes)));

  assert.deepEqual(restored.toJSON(), routes.toJSON());
  assert.equal(restored.get("safrochain-1", "osmosis-1")?.source, "manual");
  // Hosts that keep the string rather than the object get the same result.
  assert.deepEqual(
    deserializeRouteRegistry(JSON.stringify(routes)).toJSON(),
    routes.toJSON(),
  );
  // As do hosts that persisted only the array.
  assert.deepEqual(
    deserializeRouteRegistry(routes.toJSON().routes).toJSON(),
    routes.toJSON(),
  );
});

test("unusable persisted state yields an empty registry, never a throw", () => {
  const cases: unknown[] = [
    undefined,
    null,
    "",
    "{not json",
    42,
    {},
    { version: 2, routes: [route()] },
    { version: 1, routes: "nope" },
    { version: "1", routes: [route()] },
  ];
  for (const value of cases) {
    const restored = deserializeRouteRegistry(value);
    assert.equal(restored.size, 0, `expected ${JSON.stringify(value)} to be dropped`);
  }
});

test("one corrupt row does not cost us the whole cache", () => {
  const restored = deserializeRouteRegistry({
    version: 1,
    routes: [
      route(),
      null,
      "channel-3",
      { sourceChainId: "safrochain-1" },
      { ...route(), channelId: "wat" },
      { ...route(), sourceChainId: "osmosis-1", destChainId: "osmosis-1" },
    ],
  });

  assert.equal(restored.size, 1);
  assert.equal(restored.get("safrochain-1", "osmosis-1")?.channelId, "channel-3");
});

test("parseChannelRoute normalises what it can and drops what it cannot", () => {
  assert.equal(parseChannelRoute(null), null);
  assert.equal(parseChannelRoute([]), null);
  assert.equal(parseChannelRoute({}), null);
  assert.equal(parseChannelRoute({ ...route(), channelId: 3 }), null);
  assert.equal(parseChannelRoute({ ...route(), sourceChainId: 1 }), null);

  const loose = parseChannelRoute({
    sourceChainId: "  safrochain-1 ",
    destChainId: "osmosis-1",
    channelId: "CHANNEL-3",
    counterpartyChannelId: "garbage",
    verifiedAt: -5,
    source: "imported",
  });
  assert.deepEqual(loose, {
    sourceChainId: "safrochain-1",
    destChainId: "osmosis-1",
    channelId: "channel-3",
    // An unreadable counterparty becomes "unknown" rather than a bad value.
    counterpartyChannelId: "",
    verifiedAt: 0,
    // An unrecognised source can never claim to be something the user entered.
    source: "discovered",
  });

  assert.equal(
    parseChannelRoute({ ...route(), verifiedAt: 12.9 })?.verifiedAt,
    12,
  );
  assert.equal(
    parseChannelRoute({ ...route(), verifiedAt: Number.POSITIVE_INFINITY })?.verifiedAt,
    0,
  );
});

test("freshness is by age, and a seed is never fresh", () => {
  const now = 1_000_000;
  assert.equal(isRouteFresh(route({ verifiedAt: now - 10 }), 1_000, now), true);
  assert.equal(isRouteFresh(route({ verifiedAt: now - 5_000 }), 1_000, now), false);
  assert.equal(isRouteFresh(route({ verifiedAt: 0 }), DEFAULT_ROUTE_MAX_AGE_MS, now), false);

  assert.equal(
    routeNeedsVerification(route({ verifiedAt: now - 10 }), 1_000, now),
    false,
  );
  assert.equal(
    routeNeedsVerification(route({ verifiedAt: now - 5_000 }), 1_000, now),
    true,
  );
  // A seed always needs verifying, whatever timestamp it carries.
  assert.equal(
    routeNeedsVerification(
      route({ source: "seed", verifiedAt: now }),
      1_000,
      now,
    ),
    true,
  );
});

/* -------------------------------------------------------------------------- *
 * Seeds
 * -------------------------------------------------------------------------- */

test("every seed is marked unverified and gets re-checked", () => {
  assert.ok(SEED_CHANNEL_ROUTES.length > 0);
  for (const seed of SEED_CHANNEL_ROUTES) {
    assert.equal(seed.source, "seed", seed.channelId);
    assert.equal(seed.verifiedAt, 0, seed.channelId);
    assert.equal(routeNeedsVerification(seed), true, seed.channelId);
    assert.match(seed.channelId, /^channel-\d+$/);
    assert.match(seed.counterpartyChannelId, /^channel-\d+$/);
    assert.notEqual(seed.sourceChainId, seed.destChainId);
    // A seed must survive its own parser, or it would be dropped on load.
    assert.deepEqual(parseChannelRoute(seed), seed);
  }
});

test("seed directions agree with each other", () => {
  for (const seed of SEED_CHANNEL_ROUTES) {
    const reverse = SEED_CHANNEL_ROUTES.find(
      (row) =>
        row.sourceChainId === seed.destChainId &&
        row.destChainId === seed.sourceChainId,
    );
    assert.ok(reverse, `no reverse seed for ${seed.sourceChainId}`);
    assert.equal(reverse.channelId, seed.counterpartyChannelId);
    assert.equal(reverse.counterpartyChannelId, seed.channelId);
  }
});

test("no seed claims a Safrochain channel", () => {
  // Guardrail, not a preference: no Safrochain channel number could be
  // confirmed from a primary source, and a guessed one would point real funds
  // at a channel that may not exist. If this ever fails, the number needs a
  // citation, not a fix to the test.
  for (const seed of SEED_CHANNEL_ROUTES) {
    assert.equal(seed.sourceChainId.startsWith("safro"), false);
    assert.equal(seed.destChainId.startsWith("safro"), false);
  }
});

test("seeding a registry leaves discovery in charge", () => {
  const routes = createRouteRegistry(SEED_CHANNEL_ROUTES, { now: () => 5_000 });
  assert.equal(routes.size, SEED_CHANNEL_ROUTES.length);

  const seeded = routes.get("cosmoshub-4", "osmosis-1");
  assert.equal(seeded?.source, "seed");
  assert.equal(routeNeedsVerification(seeded ?? route()), true);

  // Verifying the seed on chain promotes it; a prune then treats it as the
  // cache entry it has become.
  const verified = routes.put(
    route({
      sourceChainId: "cosmoshub-4",
      destChainId: "osmosis-1",
      channelId: "channel-141",
      counterpartyChannelId: "channel-0",
      source: "discovered",
      verifiedAt: 4_000,
    }),
  );
  assert.equal(verified.source, "discovered");
  assert.equal(routes.size, SEED_CHANNEL_ROUTES.length);
  assert.equal(routeNeedsVerification(verified, 10_000, 5_000), false);
});
