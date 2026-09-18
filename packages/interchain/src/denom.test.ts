import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  createDenomResolver,
  ibcDenomHash,
  ibcDenomHashHex,
  ibcHashFromDenom,
  identifyDenoms,
  indexDenomTraces,
  isIbcDenom,
  joinTracePath,
  listDenomTraces,
  originCandidates,
  parseDenomTrace,
  parseDenomTracesPage,
  parseTracePath,
  recommendDenom,
  resolveDenom,
  unwindPath,
  type ChannelCounterpartyLookup,
  type DenomContext,
} from "./denom.js";
import {
  InterchainError,
  isInterchainError,
  type ChainInfoLike,
  type ChainRegistry,
  type LcdClient,
  type LcdClientFactory,
  type LcdRequestOptions,
  type ResolvedDenom,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Vectors, derived here rather than copied out of the implementation
 * -------------------------------------------------------------------------- */

/** Independent implementation of ibc-go's `DenomTrace.Hash()`, via node:crypto. */
function vector(path: string, baseDenom: string): string {
  const full = path === "" ? baseDenom : `${path}/${baseDenom}`;
  return `ibc/${createHash("sha256").update(full, "utf8").digest("hex").toUpperCase()}`;
}

/** ATOM as held on Osmosis. The one hash every Cosmos UI shows. */
const ATOM_ON_OSMOSIS =
  "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
/** The same ATOM after a second hop, Osmosis -> Juno over Juno's channel-42. */
const ATOM_VIA_OSMOSIS_ON_JUNO = vector(
  "transfer/channel-42/transfer/channel-0",
  "uatom",
);

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

function chain(
  chainId: string,
  chainName: string,
  prefix: string,
  minimalDenom: string,
): ChainInfoLike {
  return {
    chainId,
    chainName,
    bech32Prefix: prefix,
    coinType: 118,
    coinDenom: minimalDenom.slice(1).toUpperCase(),
    coinMinimalDenom: minimalDenom,
    coinDecimals: 6,
    feeDenom: minimalDenom.slice(1).toUpperCase(),
    feeMinimalDenom: minimalDenom,
    feeDecimals: 6,
    rest: `https://rest.${chainId}.example`,
  };
}

const HUB = chain("cosmoshub-4", "Cosmos Hub", "cosmos", "uatom");
const OSMOSIS = chain("osmosis-1", "Osmosis", "osmo", "uosmo");
const JUNO = chain("juno-1", "Juno", "juno", "ujuno");
// Safrochain's prefix carries an underscore; nothing here may split on it.
const SAFRO = chain("safrochain-1", "Safrochain", "addr_safro", "usafro");

const CHAINS = [HUB, OSMOSIS, JUNO, SAFRO] as const;

function registryOf(chains: readonly ChainInfoLike[] = CHAINS): ChainRegistry {
  return {
    get: (chainId) => chains.find((row) => row.chainId === chainId),
    list: () => chains,
    byPrefix: (prefix) => chains.filter((row) => row.bech32Prefix === prefix),
  };
}

type Handler = (options: LcdRequestOptions | undefined) => unknown;

interface Harness {
  readonly ctx: DenomContext;
  /** Every `${chainId}${path}` asked for, in order. */
  readonly calls: string[];
  readonly options: (LcdRequestOptions | undefined)[];
}

/**
 * A DenomContext whose LCD is a lookup table. Nothing touches the network:
 * an unmapped path answers HTTP 404 the way a real LCD does for an unknown
 * hash, so the fallback logic is exercised for free.
 */
function harness(config: {
  routes?: Record<string, Handler>;
  chains?: readonly ChainInfoLike[];
  counterparty?: ChannelCounterpartyLookup;
  inferOriginFromRegistry?: boolean;
} = {}): Harness {
  const routes = config.routes ?? {};
  const calls: string[] = [];
  const options: (LcdRequestOptions | undefined)[] = [];

  const lcd: LcdClientFactory = (chainInfo): LcdClient => ({
    chainId: chainInfo.chainId,
    getJson: async (path, requestOptions) => {
      const key = `${chainInfo.chainId}${path}`;
      calls.push(key);
      options.push(requestOptions);
      const handler = routes[key];
      if (!handler) {
        throw new InterchainError("lcd-unreachable", `no stub for ${key}`, {
          chainId: chainInfo.chainId,
          httpStatus: 404,
        });
      }
      return handler(requestOptions);
    },
  });

  const ctx: DenomContext = {
    lcd,
    registry: registryOf(config.chains ?? CHAINS),
    ...(config.counterparty ? { counterparty: config.counterparty } : {}),
    ...(config.inferOriginFromRegistry === undefined
      ? {}
      : { inferOriginFromRegistry: config.inferOriginFromRegistry }),
  };
  return { ctx, calls, options };
}

function traceRoute(chainId: string, denom: string, body: unknown): [string, Handler] {
  const hash = denom.slice("ibc/".length);
  return [`${chainId}/ibc/apps/transfer/v1/denom_traces/${hash}`, () => body];
}

function wrapped(path: string, baseDenom: string): unknown {
  return { denom_trace: { path, base_denom: baseDenom } };
}

/** Osmosis knows ATOM; Juno knows the twice-wrapped ATOM that came via Osmosis. */
function defaultRoutes(): Record<string, Handler> {
  return Object.fromEntries([
    traceRoute("osmosis-1", ATOM_ON_OSMOSIS, wrapped("transfer/channel-0", "uatom")),
    traceRoute(
      "juno-1",
      ATOM_VIA_OSMOSIS_ON_JUNO,
      wrapped("transfer/channel-42/transfer/channel-0", "uatom"),
    ),
  ]);
}

/** juno-1/channel-42 -> osmosis-1 -> (channel-0) -> cosmoshub-4. */
const COUNTERPARTY: ChannelCounterpartyLookup = async (chainId, port, channelId) => {
  assert.equal(port, "transfer");
  if (chainId === "juno-1" && channelId === "channel-42") return "osmosis-1";
  if (chainId === "osmosis-1" && channelId === "channel-0") return "cosmoshub-4";
  return null;
};

async function rejects(
  run: () => Promise<unknown>,
  code: string,
): Promise<InterchainError> {
  try {
    await run();
  } catch (error) {
    assert.ok(isInterchainError(error), `expected an InterchainError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected a rejection with code ${code}`);
}

function throws(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(isInterchainError(error));
    assert.equal(error.code, code);
    return true;
  });
}

/* -------------------------------------------------------------------------- *
 * Hashing
 * -------------------------------------------------------------------------- */

test("ibcDenomHash matches an independently derived SHA-256", async () => {
  assert.equal(
    await ibcDenomHash("transfer/channel-0", "uatom"),
    vector("transfer/channel-0", "uatom"),
  );
  assert.equal(
    await ibcDenomHash("transfer/channel-42/transfer/channel-0", "uatom"),
    vector("transfer/channel-42/transfer/channel-0", "uatom"),
  );
  // No hops: the hash is over the base denom alone.
  assert.equal(await ibcDenomHash("", "uatom"), vector("", "uatom"));
});

test("ibcDenomHash reproduces the known ATOM-on-Osmosis denom", async () => {
  assert.equal(await ibcDenomHash("transfer/channel-0", "uatom"), ATOM_ON_OSMOSIS);
});

test("ibcDenomHashHex is uppercase hex with no prefix", async () => {
  const hex = await ibcDenomHashHex("transfer/channel-0", "uatom");
  assert.match(hex, /^[0-9A-F]{64}$/);
  assert.equal(`ibc/${hex}`, ATOM_ON_OSMOSIS);
});

test("ibcDenomHash ignores stray slashes and whitespace in the path", async () => {
  assert.equal(await ibcDenomHash("/transfer/channel-0/", "uatom"), ATOM_ON_OSMOSIS);
  assert.equal(await ibcDenomHash("  transfer/channel-0  ", " uatom "), ATOM_ON_OSMOSIS);
});

test("ibcDenomHash rejects an empty base denom", async () => {
  await rejects(() => ibcDenomHash("transfer/channel-0", "   "), "malformed-response");
});

test("isIbcDenom / ibcHashFromDenom", () => {
  assert.equal(isIbcDenom("uatom"), false);
  assert.equal(isIbcDenom(ATOM_ON_OSMOSIS), true);
  assert.equal(ibcHashFromDenom("uatom"), null);
  assert.equal(ibcHashFromDenom("factory/osmo1abc/uusdc"), null);
  assert.equal(
    ibcHashFromDenom(ATOM_ON_OSMOSIS),
    ATOM_ON_OSMOSIS.slice(4),
  );
  // Lowercase in, canonical uppercase out, so hashes compare by string.
  assert.equal(
    ibcHashFromDenom(`ibc/${ATOM_ON_OSMOSIS.slice(4).toLowerCase()}`),
    ATOM_ON_OSMOSIS.slice(4),
  );
});

test("ibcHashFromDenom rejects an ibc/ denom that is not a 64-char hash", () => {
  throws(() => ibcHashFromDenom("ibc/NOPE"), "malformed-response");
  throws(() => ibcHashFromDenom(`ibc/${"Z".repeat(64)}`), "malformed-response");
  throws(() => ibcHashFromDenom("ibc/"), "malformed-response");
});

/* -------------------------------------------------------------------------- *
 * Trace paths
 * -------------------------------------------------------------------------- */

test("parseTracePath splits ordered hops", () => {
  assert.deepEqual(parseTracePath(""), []);
  assert.deepEqual(parseTracePath("transfer/channel-0"), [
    { port: "transfer", channelId: "channel-0" },
  ]);
  // Outermost hop first: channel-42 is on the chain holding the token.
  assert.deepEqual(parseTracePath("transfer/channel-42/transfer/channel-0"), [
    { port: "transfer", channelId: "channel-42" },
    { port: "transfer", channelId: "channel-0" },
  ]);
});

test("parseTracePath rejects an odd segment count", () => {
  throws(() => parseTracePath("transfer/channel-0/transfer"), "malformed-response");
  throws(() => parseTracePath("transfer"), "malformed-response");
});

test("parseTracePath rejects an empty segment", () => {
  throws(() => parseTracePath("transfer//transfer/channel-0"), "malformed-response");
});

test("parseTracePath rejects a non-transfer port unless asked not to", () => {
  throws(() => parseTracePath("wasm.juno1abc/channel-9"), "malformed-response");
  assert.deepEqual(
    parseTracePath("wasm.juno1abc/channel-9", { allowNonTransferPorts: true }),
    [{ port: "wasm.juno1abc", channelId: "channel-9" }],
  );
});

test("parseTracePath rejects a channel id that is not channel-<n>", () => {
  throws(() => parseTracePath("transfer/uatom"), "malformed-response");
  assert.deepEqual(
    parseTracePath("transfer/chan-9", { allowNonStandardChannelIds: true }),
    [{ port: "transfer", channelId: "chan-9" }],
  );
});

test("joinTracePath inverts parseTracePath", () => {
  const path = "transfer/channel-42/transfer/channel-0";
  assert.equal(joinTracePath(parseTracePath(path)), path);
  assert.equal(joinTracePath([]), "");
});

/* -------------------------------------------------------------------------- *
 * Response parsers
 * -------------------------------------------------------------------------- */

test("parseDenomTrace accepts the documented wrapped shape", () => {
  assert.deepEqual(parseDenomTrace(wrapped("transfer/channel-0", "uatom")), {
    path: "transfer/channel-0",
    baseDenom: "uatom",
  });
});

test("parseDenomTrace accepts a bare object and ignores extra keys", () => {
  assert.deepEqual(
    parseDenomTrace({ path: "transfer/channel-0", base_denom: "uatom", extra: 1 }),
    { path: "transfer/channel-0", baseDenom: "uatom" },
  );
});

test("parseDenomTrace accepts a native trace with no path", () => {
  assert.deepEqual(parseDenomTrace({ denom_trace: { path: "", base_denom: "uatom" } }), {
    path: "",
    baseDenom: "uatom",
  });
  assert.deepEqual(parseDenomTrace({ denom_trace: { base_denom: "uatom" } }), {
    path: "",
    baseDenom: "uatom",
  });
});

test("parseDenomTrace accepts the ibc-go v9 denoms shape", () => {
  assert.deepEqual(
    parseDenomTrace({
      denom: {
        base: "uatom",
        trace: [
          { port_id: "transfer", channel_id: "channel-42" },
          { port_id: "transfer", channel_id: "channel-0" },
        ],
      },
    }),
    { path: "transfer/channel-42/transfer/channel-0", baseDenom: "uatom" },
  );
});

test("parseDenomTrace rejects malformed bodies", () => {
  for (const body of [null, undefined, 7, "uatom", [], {}, { denom_trace: null }]) {
    throws(() => parseDenomTrace(body), "malformed-response");
  }
  throws(() => parseDenomTrace({ denom_trace: { base_denom: "" } }), "malformed-response");
  throws(
    () => parseDenomTrace({ denom_trace: { path: 3, base_denom: "uatom" } }),
    "malformed-response",
  );
  throws(() => parseDenomTrace({ denom: { base: "uatom", trace: 5 } }), "malformed-response");
  throws(
    () => parseDenomTrace({ denom: { base: "uatom", trace: [{ port_id: "transfer" }] } }),
    "malformed-response",
  );
});

test("parseDenomTracesPage reads rows and pagination", () => {
  const page = parseDenomTracesPage({
    denom_traces: [
      { path: "transfer/channel-0", base_denom: "uatom" },
      { path: "", base_denom: "uosmo" },
    ],
    pagination: { next_key: "abc", total: "2" },
  });
  assert.equal(page.traces.length, 2);
  assert.equal(page.nextKey, "abc");
  assert.equal(page.total, "2");
  assert.equal(page.skipped, 0);
});

test("parseDenomTracesPage treats an empty next_key as the last page", () => {
  const page = parseDenomTracesPage({ denom_traces: [], pagination: { next_key: "" } });
  assert.equal(page.nextKey, null);
  assert.equal(page.total, null);
  const bare = parseDenomTracesPage({ denom_traces: [] });
  assert.equal(bare.nextKey, null);
});

test("parseDenomTracesPage skips bad rows instead of losing the page", () => {
  const page = parseDenomTracesPage({
    denom_traces: [
      { path: "transfer/channel-0", base_denom: "uatom" },
      null,
      "nonsense",
      { path: "transfer/channel-1" },
      { base_denom: "uosmo" },
    ],
  });
  assert.deepEqual(page.traces, [
    { path: "transfer/channel-0", baseDenom: "uatom" },
    { path: "", baseDenom: "uosmo" },
  ]);
  assert.equal(page.skipped, 3);
});

test("parseDenomTracesPage accepts the v9 denoms array", () => {
  const page = parseDenomTracesPage({
    denoms: [{ base: "uatom", trace: [{ port_id: "transfer", channel_id: "channel-0" }] }],
  });
  assert.deepEqual(page.traces, [{ path: "transfer/channel-0", baseDenom: "uatom" }]);
});

test("parseDenomTracesPage rejects a body with no rows array", () => {
  throws(() => parseDenomTracesPage({ pagination: {} }), "malformed-response");
  throws(() => parseDenomTracesPage([]), "malformed-response");
  throws(() => parseDenomTracesPage(null), "malformed-response");
});

/* -------------------------------------------------------------------------- *
 * resolveDenom
 * -------------------------------------------------------------------------- */

test("resolveDenom returns a native denom without touching the network", async () => {
  const { ctx, calls } = harness();
  const resolved = await resolveDenom(ctx, "cosmoshub-4", "uatom");
  assert.deepEqual(calls, []);
  assert.equal(resolved.isNative, true);
  assert.equal(resolved.baseDenom, "uatom");
  assert.equal(resolved.path, "");
  assert.deepEqual(resolved.hops, []);
  assert.equal(resolved.ibcHash, null);
  assert.equal(resolved.originChainId, "cosmoshub-4");
  assert.equal(resolved.originProvenance, "native");
});

test("resolveDenom parses a voucher and caches the read", async () => {
  const { ctx, calls, options } = harness({ routes: defaultRoutes() });
  const resolved = await resolveDenom(ctx, "osmosis-1", ATOM_ON_OSMOSIS);
  assert.deepEqual(calls, [
    `osmosis-1/ibc/apps/transfer/v1/denom_traces/${ATOM_ON_OSMOSIS.slice(4)}`,
  ]);
  assert.equal(resolved.isNative, false);
  assert.equal(resolved.baseDenom, "uatom");
  assert.equal(resolved.path, "transfer/channel-0");
  assert.deepEqual(resolved.hops, [{ port: "transfer", channelId: "channel-0" }]);
  assert.equal(resolved.ibcHash, ATOM_ON_OSMOSIS.slice(4));
  assert.equal(resolved.chainId, "osmosis-1");
  // Traces are immutable, so the read is cached.
  const first = options[0];
  assert.ok(first);
  assert.ok((first.cacheTtlMs ?? 0) > 0);
});

test("resolveDenom accepts a bare trace body", async () => {
  const { ctx } = harness({
    routes: Object.fromEntries([
      traceRoute("osmosis-1", ATOM_ON_OSMOSIS, {
        path: "transfer/channel-0",
        base_denom: "uatom",
      }),
    ]),
  });
  const resolved = await resolveDenom(ctx, "osmosis-1", ATOM_ON_OSMOSIS);
  assert.equal(resolved.baseDenom, "uatom");
});

test("resolveDenom rejects a trace that does not hash back to the denom asked for", async () => {
  const { ctx } = harness({
    routes: Object.fromEntries([
      // The endpoint answers with a different token entirely.
      traceRoute("osmosis-1", ATOM_ON_OSMOSIS, wrapped("transfer/channel-0", "ujuno")),
    ]),
  });
  const error = await rejects(
    () => resolveDenom(ctx, "osmosis-1", ATOM_ON_OSMOSIS),
    "malformed-response",
  );
  assert.match(error.message, /hashes to/);
});

test("resolveDenom falls back to the v9 /denoms path on 404", async () => {
  const hash = ATOM_ON_OSMOSIS.slice(4);
  const { ctx, calls } = harness({
    routes: {
      [`osmosis-1/ibc/apps/transfer/v1/denoms/${hash}`]: () => ({
        denom: { base: "uatom", trace: [{ port_id: "transfer", channel_id: "channel-0" }] },
      }),
    },
  });
  const resolved = await resolveDenom(ctx, "osmosis-1", ATOM_ON_OSMOSIS);
  assert.equal(resolved.baseDenom, "uatom");
  assert.deepEqual(calls, [
    `osmosis-1/ibc/apps/transfer/v1/denom_traces/${hash}`,
    `osmosis-1/ibc/apps/transfer/v1/denoms/${hash}`,
  ]);
});

test("resolveDenom rethrows the original error when both endpoints fail", async () => {
  const { ctx } = harness();
  const error = await rejects(
    () => resolveDenom(ctx, "osmosis-1", ATOM_ON_OSMOSIS),
    "lcd-unreachable",
  );
  assert.equal(error.httpStatus, 404);
  assert.match(error.message, /denom_traces/);
});

test("resolveDenom does not retry a non-404 failure on the v9 path", async () => {
  const hash = ATOM_ON_OSMOSIS.slice(4);
  const { ctx, calls } = harness({
    routes: {
      [`osmosis-1/ibc/apps/transfer/v1/denom_traces/${hash}`]: () => {
        throw new InterchainError("lcd-unreachable", "boom", { httpStatus: 503 });
      },
    },
  });
  await rejects(() => resolveDenom(ctx, "osmosis-1", ATOM_ON_OSMOSIS), "lcd-unreachable");
  assert.equal(calls.length, 1);
});

test("resolveDenom refuses an unknown chain and a malformed denom", async () => {
  const { ctx } = harness({ routes: defaultRoutes() });
  await rejects(() => resolveDenom(ctx, "nowhere-1", "uatom"), "unsupported-chain");
  await rejects(() => identifyDenoms(ctx, "nowhere-1", ["uatom"]), "unsupported-chain");
  await rejects(() => resolveDenom(ctx, "osmosis-1", "ibc/short"), "malformed-response");
  await rejects(() => resolveDenom(ctx, "osmosis-1", "  "), "malformed-response");
});

test("resolveDenom walks the channels to the origin chain when a lookup is wired", async () => {
  const { ctx } = harness({ routes: defaultRoutes(), counterparty: COUNTERPARTY });
  const resolved = await resolveDenom(ctx, "juno-1", ATOM_VIA_OSMOSIS_ON_JUNO);
  assert.deepEqual(resolved.hopChainIds, ["osmosis-1", "cosmoshub-4"]);
  assert.equal(resolved.originChainId, "cosmoshub-4");
  assert.equal(resolved.originProvenance, "channel-walk");
});

test("resolveDenom leaves the origin unknown without a lookup, and when one fails", async () => {
  const plain = harness({ routes: defaultRoutes() });
  const noLookup = await resolveDenom(plain.ctx, "osmosis-1", ATOM_ON_OSMOSIS);
  assert.equal(noLookup.originChainId, null);
  assert.deepEqual(noLookup.hopChainIds, [null]);
  assert.equal(noLookup.originProvenance, "unknown");

  const failing = harness({
    routes: defaultRoutes(),
    counterparty: async () => {
      throw new InterchainError("lcd-unreachable", "no connection data");
    },
  });
  const resolved = await resolveDenom(failing.ctx, "osmosis-1", ATOM_ON_OSMOSIS);
  assert.equal(resolved.originChainId, null);
});

test("resolveDenom propagates an aborted counterparty lookup", async () => {
  const { ctx } = harness({
    routes: defaultRoutes(),
    counterparty: async () => {
      throw new InterchainError("aborted", "cancelled");
    },
  });
  await rejects(() => resolveDenom(ctx, "osmosis-1", ATOM_ON_OSMOSIS), "aborted");
});

/* -------------------------------------------------------------------------- *
 * unwindPath
 * -------------------------------------------------------------------------- */

test("unwindPath is empty for a native denom", async () => {
  const { ctx } = harness();
  const resolved = await resolveDenom(ctx, "cosmoshub-4", "uatom");
  assert.deepEqual(await unwindPath(resolved), []);
});

test("unwindPath walks the trace left to right, naming the denom at every step", async () => {
  const { ctx } = harness({ routes: defaultRoutes(), counterparty: COUNTERPARTY });
  const resolved = await resolveDenom(ctx, "juno-1", ATOM_VIA_OSMOSIS_ON_JUNO);
  const steps = await unwindPath(resolved);
  assert.equal(steps.length, 2);

  const first = steps[0];
  assert.ok(first);
  // Hop 0 is the channel on the chain holding the token: sending out of exactly
  // this channel burns the voucher instead of wrapping it a third time.
  assert.equal(first.channelId, "channel-42");
  assert.equal(first.fromChainId, "juno-1");
  assert.equal(first.toChainId, "osmosis-1");
  assert.equal(first.denom, ATOM_VIA_OSMOSIS_ON_JUNO);
  assert.equal(first.nextDenom, ATOM_ON_OSMOSIS);
  assert.equal(first.nextPath, "transfer/channel-0");
  assert.equal(first.landsOnOrigin, false);

  const second = steps[1];
  assert.ok(second);
  assert.equal(second.channelId, "channel-0");
  assert.equal(second.fromChainId, "osmosis-1");
  assert.equal(second.toChainId, "cosmoshub-4");
  assert.equal(second.denom, ATOM_ON_OSMOSIS);
  assert.equal(second.nextDenom, "uatom");
  assert.equal(second.nextPath, "");
  assert.equal(second.landsOnOrigin, true);
});

test("unwindPath works on a plain ResolvedDenom with no chain ids", async () => {
  const bare: ResolvedDenom = {
    denom: ATOM_ON_OSMOSIS,
    baseDenom: "uatom",
    path: "transfer/channel-0",
    hops: [{ port: "transfer", channelId: "channel-0" }],
    originChainId: null,
    isNative: false,
    ibcHash: ATOM_ON_OSMOSIS.slice(4),
  };
  const steps = await unwindPath(bare);
  const only = steps[0];
  assert.ok(only);
  assert.equal(only.fromChainId, null);
  assert.equal(only.toChainId, null);
  assert.equal(only.nextDenom, "uatom");
});

/* -------------------------------------------------------------------------- *
 * recommendDenom
 * -------------------------------------------------------------------------- */

test("recommendDenom on the same chain moves nothing", async () => {
  const { ctx } = harness();
  const plan = await recommendDenom(ctx, "cosmoshub-4", "cosmoshub-4", "uatom");
  assert.equal(plan.strategy, "direct");
  assert.equal(plan.outputDenom, "uatom");
  assert.deepEqual(plan.unwind, []);
});

test("recommendDenom sends a native denom directly and names the voucher it becomes", async () => {
  const { ctx } = harness();
  const blind = await recommendDenom(ctx, "cosmoshub-4", "osmosis-1", "uatom");
  assert.equal(blind.strategy, "direct");
  assert.equal(blind.firstHop, null);
  // Without the receiving channel the arriving denom cannot be named.
  assert.equal(blind.outputDenom, null);
  assert.ok(blind.warnings.some((line) => line.includes("receiving channel")));

  const named = await recommendDenom(ctx, "cosmoshub-4", "osmosis-1", "uatom", {
    destinationReceiveChannelId: "channel-0",
  });
  assert.equal(named.outputDenom, ATOM_ON_OSMOSIS);
  assert.equal(named.originChainId, "cosmoshub-4");
  assert.deepEqual(named.warnings, []);
});

test("recommendDenom unwinds a voucher when the destination is its origin", async () => {
  const { ctx } = harness({ routes: defaultRoutes(), counterparty: COUNTERPARTY });
  const plan = await recommendDenom(ctx, "osmosis-1", "cosmoshub-4", ATOM_ON_OSMOSIS);
  assert.equal(plan.strategy, "unwind");
  // The user gets uatom back, not a fresh hash.
  assert.equal(plan.outputDenom, "uatom");
  assert.deepEqual(plan.firstHop, { port: "transfer", channelId: "channel-0" });
  assert.equal(plan.unwind.length, 1);
  assert.equal(plan.originChainId, "cosmoshub-4");
  assert.equal(plan.originProvenance, "channel-walk");
});

test("recommendDenom stops the unwind at an intermediate destination", async () => {
  const { ctx } = harness({ routes: defaultRoutes(), counterparty: COUNTERPARTY });
  const plan = await recommendDenom(ctx, "juno-1", "osmosis-1", ATOM_VIA_OSMOSIS_ON_JUNO);
  assert.equal(plan.strategy, "unwind");
  assert.equal(plan.unwind.length, 1);
  // Osmosis already knows this denom; it is the canonical ATOM there.
  assert.equal(plan.outputDenom, ATOM_ON_OSMOSIS);
  assert.deepEqual(plan.firstHop, { port: "transfer", channelId: "channel-42" });
});

test("recommendDenom unwinds all the way home when the destination is further on", async () => {
  const { ctx } = harness({ routes: defaultRoutes(), counterparty: COUNTERPARTY });
  const plan = await recommendDenom(ctx, "juno-1", "cosmoshub-4", ATOM_VIA_OSMOSIS_ON_JUNO);
  assert.equal(plan.strategy, "unwind");
  assert.equal(plan.unwind.length, 2);
  assert.equal(plan.outputDenom, "uatom");
});

test("recommendDenom unwinds before forwarding to an unrelated chain", async () => {
  const { ctx } = harness({ routes: defaultRoutes(), counterparty: COUNTERPARTY });
  const plan = await recommendDenom(ctx, "osmosis-1", "safrochain-1", ATOM_ON_OSMOSIS, {
    destinationReceiveChannelId: "channel-7",
  });
  assert.equal(plan.strategy, "unwind-then-forward");
  assert.equal(plan.originChainId, "cosmoshub-4");
  // Canonical ATOM on Safrochain: one hop from the Hub, not two through Osmosis.
  assert.equal(plan.outputDenom, vector("transfer/channel-7", "uatom"));
  assert.ok(plan.warnings.some((line) => line.includes("double-wrapped")));
  assert.equal(plan.unwind.length, 1);
});

test("recommendDenom guesses the origin from the registry, and says so", async () => {
  const { ctx } = harness({ routes: defaultRoutes() });
  const plan = await recommendDenom(ctx, "osmosis-1", "cosmoshub-4", ATOM_ON_OSMOSIS);
  assert.equal(plan.strategy, "unwind");
  assert.equal(plan.originChainId, "cosmoshub-4");
  assert.equal(plan.originProvenance, "registry-guess");
  assert.equal(plan.outputDenom, "uatom");
  assert.ok(plan.warnings.some((line) => line.includes("inferred from the registry")));
});

test("recommendDenom refuses to guess when the origin is unknowable", async () => {
  const { ctx } = harness({
    routes: Object.fromEntries([
      traceRoute("osmosis-1", vector("transfer/channel-0", "uusdc"), {
        denom_trace: { path: "transfer/channel-0", base_denom: "uusdc" },
      }),
    ]),
  });
  const plan = await recommendDenom(
    ctx,
    "osmosis-1",
    "juno-1",
    vector("transfer/channel-0", "uusdc"),
  );
  assert.equal(plan.strategy, "unknown");
  assert.equal(plan.originChainId, null);
  assert.equal(plan.outputDenom, null);
  assert.ok(plan.warnings.some((line) => line.includes("Could not determine")));
});

test("recommendDenom honours inferOriginFromRegistry: false", async () => {
  const { ctx } = harness({ routes: defaultRoutes(), inferOriginFromRegistry: false });
  const plan = await recommendDenom(ctx, "osmosis-1", "cosmoshub-4", ATOM_ON_OSMOSIS);
  assert.equal(plan.strategy, "unknown");
  assert.equal(plan.originProvenance, "unknown");
});

test("recommendDenom refuses an unknown destination chain", async () => {
  const { ctx } = harness({ routes: defaultRoutes() });
  await rejects(
    () => recommendDenom(ctx, "osmosis-1", "nowhere-1", "uosmo"),
    "unsupported-chain",
  );
});

test("originCandidates only matches an exact base denom", () => {
  const registry = registryOf();
  assert.deepEqual(
    originCandidates(registry, "uatom").map((row) => row.chainId),
    ["cosmoshub-4"],
  );
  assert.deepEqual(originCandidates(registry, "uusdc"), []);
});

/* -------------------------------------------------------------------------- *
 * Safrochain: the bech32 prefix has an underscore
 * -------------------------------------------------------------------------- */

test("a chain whose bech32 prefix is addr_safro is handled like any other", async () => {
  const safroOnOsmosis = vector("transfer/channel-999", "usafro");
  const { ctx } = harness({
    routes: Object.fromEntries([
      traceRoute("osmosis-1", safroOnOsmosis, wrapped("transfer/channel-999", "usafro")),
    ]),
    counterparty: async (chainId, _port, channelId) =>
      chainId === "osmosis-1" && channelId === "channel-999" ? "safrochain-1" : null,
  });

  // The prefix is registry metadata, never parsed here: `addr_safro` must not
  // be split on the underscore anywhere in the lookup path.
  assert.deepEqual(
    ctx.registry.byPrefix("addr_safro").map((row) => row.chainId),
    ["safrochain-1"],
  );
  assert.deepEqual(ctx.registry.byPrefix("addr"), []);

  const resolved = await resolveDenom(ctx, "osmosis-1", safroOnOsmosis);
  assert.equal(resolved.baseDenom, "usafro");
  assert.equal(resolved.originChainId, "safrochain-1");

  const home = await recommendDenom(ctx, "osmosis-1", "safrochain-1", safroOnOsmosis);
  assert.equal(home.strategy, "unwind");
  assert.equal(home.outputDenom, "usafro");

  const out = await recommendDenom(ctx, "safrochain-1", "osmosis-1", "usafro", {
    destinationReceiveChannelId: "channel-999",
  });
  assert.equal(out.strategy, "direct");
  assert.equal(out.outputDenom, safroOnOsmosis);
});

/* -------------------------------------------------------------------------- *
 * Sweeps
 * -------------------------------------------------------------------------- */

function tracePages(pages: readonly (readonly [readonly unknown[], string | null])[]): Handler {
  return (options) => {
    const key = options?.query?.["pagination.key"];
    const index = key === undefined ? 0 : Number(key);
    const page = pages[index];
    if (!page) throw new Error(`no stub page for key ${String(key)}`);
    return {
      denom_traces: page[0],
      pagination: { next_key: page[1] },
    };
  };
}

test("listDenomTraces walks pages until next_key runs out", async () => {
  const { ctx, calls } = harness({
    routes: {
      "osmosis-1/ibc/apps/transfer/v1/denom_traces": tracePages([
        [[{ path: "transfer/channel-0", base_denom: "uatom" }], "1"],
        [[{ path: "transfer/channel-42", base_denom: "ujuno" }], null],
      ]),
    },
  });
  const traces = await listDenomTraces(ctx, "osmosis-1");
  assert.deepEqual(traces, [
    { path: "transfer/channel-0", baseDenom: "uatom" },
    { path: "transfer/channel-42", baseDenom: "ujuno" },
  ]);
  assert.equal(calls.length, 2);
});

test("listDenomTraces stops at maxPages", async () => {
  const { ctx, calls } = harness({
    routes: {
      "osmosis-1/ibc/apps/transfer/v1/denom_traces": () => ({
        denom_traces: [{ path: "transfer/channel-0", base_denom: "uatom" }],
        pagination: { next_key: "0" },
      }),
    },
  });
  const traces = await listDenomTraces(ctx, "osmosis-1", { maxPages: 3 });
  assert.equal(calls.length, 3);
  assert.equal(traces.length, 3);
});

test("indexDenomTraces keys traces by the voucher they produce", async () => {
  const index = await indexDenomTraces([
    { path: "transfer/channel-0", baseDenom: "uatom" },
    { path: "", baseDenom: "" },
  ]);
  assert.equal(index.size, 1);
  assert.deepEqual(index.get(ATOM_ON_OSMOSIS), {
    path: "transfer/channel-0",
    baseDenom: "uatom",
  });
});

test("identifyDenoms resolves a small holding list one denom at a time", async () => {
  const { ctx, calls } = harness({ routes: defaultRoutes(), counterparty: COUNTERPARTY });
  const found = await identifyDenoms(ctx, "osmosis-1", [
    "uosmo",
    ATOM_ON_OSMOSIS,
    "uosmo",
    "",
  ]);
  assert.equal(found.size, 2);
  assert.equal(found.get("uosmo")?.isNative, true);
  assert.equal(found.get(ATOM_ON_OSMOSIS)?.baseDenom, "uatom");
  assert.equal(calls.length, 1);
});

test("identifyDenoms sweeps the trace list once when there are many unknowns", async () => {
  const unknowns = Array.from({ length: 4 }, (_, i) =>
    vector(`transfer/channel-${i}`, "uatom"),
  );
  const { ctx, calls } = harness({
    routes: {
      "osmosis-1/ibc/apps/transfer/v1/denom_traces": tracePages([
        [
          unknowns.map((_, i) => ({ path: `transfer/channel-${i}`, base_denom: "uatom" })),
          null,
        ],
      ]),
    },
  });
  const found = await identifyDenoms(ctx, "osmosis-1", unknowns, { bulkThreshold: 2 });
  assert.equal(found.size, 4);
  for (const denom of unknowns) {
    assert.equal(found.get(denom)?.baseDenom, "uatom");
  }
  // One list call, not one call per denom.
  assert.deepEqual(calls, ["osmosis-1/ibc/apps/transfer/v1/denom_traces"]);
});

test("identifyDenoms leaves rows it cannot resolve out of the map", async () => {
  const missing = vector("transfer/channel-77", "unknown");
  const { ctx } = harness({ routes: defaultRoutes() });
  const found = await identifyDenoms(ctx, "osmosis-1", [
    ATOM_ON_OSMOSIS,
    missing,
    "ibc/not-a-hash",
    "uosmo",
  ]);
  assert.equal(found.has(ATOM_ON_OSMOSIS), true);
  assert.equal(found.has("uosmo"), true);
  assert.equal(found.has(missing), false);
  assert.equal(found.has("ibc/not-a-hash"), false);
});

test("identifyDenoms stops at maxLookups", async () => {
  const { ctx, calls } = harness({ routes: defaultRoutes() });
  await identifyDenoms(
    ctx,
    "osmosis-1",
    [ATOM_ON_OSMOSIS, vector("transfer/channel-1", "uatom")],
    { maxLookups: 1 },
  );
  assert.equal(calls.length, 1);
});

test("identifyDenoms propagates aborted and reads-disabled", async () => {
  for (const code of ["aborted", "reads-disabled"] as const) {
    const { ctx } = harness({
      routes: {
        [`osmosis-1/ibc/apps/transfer/v1/denom_traces/${ATOM_ON_OSMOSIS.slice(4)}`]: () => {
          throw new InterchainError(code, "stop");
        },
      },
    });
    await rejects(() => identifyDenoms(ctx, "osmosis-1", [ATOM_ON_OSMOSIS]), code);
  }
});

/* -------------------------------------------------------------------------- *
 * Bound resolver
 * -------------------------------------------------------------------------- */

test("createDenomResolver binds the context", async () => {
  const { ctx } = harness({ routes: defaultRoutes(), counterparty: COUNTERPARTY });
  const resolver = createDenomResolver(ctx);
  const resolved = await resolver.resolveDenom("osmosis-1", ATOM_ON_OSMOSIS);
  assert.equal(resolved.baseDenom, "uatom");
  const plan = await resolver.recommendDenom("osmosis-1", "cosmoshub-4", ATOM_ON_OSMOSIS);
  assert.equal(plan.outputDenom, "uatom");
  const found = await resolver.identifyDenoms("osmosis-1", ["uosmo"]);
  assert.equal(found.size, 1);
});
