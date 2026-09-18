/**
 * Package-boundary tests.
 *
 * Two jobs, both of which the per-module tests cannot do.
 *
 * 1. The barrel: every name `index.ts` re-exports must actually resolve. A
 *    module rename that leaves a stale line here typechecks locally and fails
 *    at the consumer's `import`.
 * 2. The five invariants that lose funds when they break, checked through the
 *    public API and *across* modules rather than inside one. Each is asserted
 *    somewhere in a module test too; the point here is that the composition
 *    still holds — `route.ts` builds its memos with `memo.ts`, and `route.ts`
 *    hashes denoms with `denom.ts`, so a change to either must not quietly
 *    change what the planner emits.
 *
 * Offline: the only `LcdClientFactory` in this file throws.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as api from "./index.js";
import {
  buildForwardMemoJson,
  buildWasmHookMemoJson,
  buildXcsSwapMemoJson,
  createChannelDirectory,
  ibcDenomHash,
  ibcDenomHashHex,
  ibcHashFromDenom,
  isIbcDenom,
  isWasmHookReceiverValid,
  joinTracePath,
  parseTracePath,
  planRoute,
  PFM_INTERMEDIATE_RECEIVER,
  unwindPath,
  wasmHookReceiver,
  type ChainCapabilities,
  type ChannelLink,
  type RouteDenomResolver,
  type RoutePlanCandidate,
  type RoutePlannerDeps,
} from "./index.js";
import type {
  ChainInfoLike,
  ChainRegistry,
  LcdClientFactory,
  ResolvedDenom,
  RouteRequest,
} from "./index.js";

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

/** Real denoms, so the hash arithmetic is checked against the actual network. */
const ATOM_ON_OSMOSIS =
  "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";

const OSMOSIS_XCS = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";
/** Safrochain's prefix has an underscore; nothing here may split it. */
const SAFRO_ADDRESS = "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

function chain(chainId: string, overrides: Partial<ChainInfoLike> = {}): ChainInfoLike {
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
  chain("safrochain-1", {
    chainName: "Safrochain",
    bech32Prefix: "addr_safro",
    coinMinimalDenom: "usafro",
    feeMinimalDenom: "usafro",
    features: ["cosmwasm"],
  }),
  chain("cosmoshub-4", {
    chainName: "Cosmos Hub",
    bech32Prefix: "cosmos",
    coinMinimalDenom: "uatom",
    feeMinimalDenom: "uatom",
  }),
  chain("osmosis-1", {
    chainName: "Osmosis",
    bech32Prefix: "osmo",
    coinMinimalDenom: "uosmo",
    feeMinimalDenom: "uosmo",
    features: ["cosmwasm"],
  }),
  chain("juno-1", {
    chainName: "Juno",
    bech32Prefix: "juno",
    coinMinimalDenom: "ujuno",
    feeMinimalDenom: "ujuno",
    features: ["cosmwasm"],
  }),
];

const registry: ChainRegistry = {
  get: (chainId) => CHAINS.find((row) => row.chainId === chainId),
  list: () => CHAINS,
  byPrefix: (prefix) => CHAINS.filter((row) => row.bech32Prefix === prefix),
};

const LINKS: readonly ChannelLink[] = [
  {
    sourceChainId: "safrochain-1",
    destChainId: "osmosis-1",
    channelId: "channel-0",
    counterpartyChannelId: "channel-9999",
    source: "verified",
    state: "open",
  },
  {
    sourceChainId: "osmosis-1",
    destChainId: "cosmoshub-4",
    channelId: "channel-0",
    counterpartyChannelId: "channel-141",
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
];

const CAPABILITIES: Readonly<Record<string, ChainCapabilities>> = {
  "osmosis-1": { pfm: true, ibcHooks: true, cosmwasm: true },
  "cosmoshub-4": { pfm: true, ibcHooks: false, cosmwasm: false },
  "juno-1": { pfm: true, ibcHooks: false, cosmwasm: true },
};

/** Fails loudly if the planner ever tries to read the network itself. */
const lcd: LcdClientFactory = () => {
  throw new Error("planRoute must not touch the network");
};

function deps(overrides: Partial<RoutePlannerDeps> = {}): RoutePlannerDeps {
  return {
    registry,
    channels: createChannelDirectory(LINKS),
    lcd,
    capabilities: (chainId) => CAPABILITIES[chainId],
    venues: [{ chainId: "osmosis-1", contractAddress: OSMOSIS_XCS }],
    ...overrides,
  };
}

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

function objectAt(value: unknown, key: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", `${key}: parent is not an object`);
  const row = (value as Record<string, unknown>)[key];
  assert.ok(row !== null && typeof row === "object", `${key} is missing`);
  return row as Record<string, unknown>;
}

function memoOf(candidate: RoutePlanCandidate): Record<string, unknown> {
  const parsed: unknown = JSON.parse(candidate.plan.memo);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- *
 * The barrel
 * -------------------------------------------------------------------------- */

test("every runtime export in the barrel resolves", () => {
  const names = Object.keys(api).sort();
  // A stale re-export is a build error, not a runtime one, so this mostly
  // guards against a name being exported as `undefined` by an accidental
  // circular import at module-init time.
  for (const name of names) {
    assert.notEqual(
      (api as Record<string, unknown>)[name],
      undefined,
      `${name} is exported but undefined — likely an import cycle`,
    );
  }
  // Spot-check one value from each module so a whole block going missing fails
  // here rather than at a consumer.
  for (const name of [
    "InterchainError",
    "TRANSFER_PORT",
    "createLcdClient",
    "createLcdPostClient",
    "encodeBase64",
    "createChainRegistry",
    "createIbcChannelService",
    "createDenomResolver",
    "buildForwardMemo",
    "planRoute",
    "quoteOsmosisSwap",
    "buildNftTransferMsg",
    "trackRoute",
    "buildUnsignedTxRequest",
  ]) {
    assert.ok(names.includes(name), `${name} is not exported from index.ts`);
  }
});

test("the barrel exports one name per concept", () => {
  const names = Object.keys(api);
  assert.equal(new Set(names).size, names.length);
  // `TRANSFER_PORT` and the transaction memo ceiling each had two public names
  // with the same value at one point. One name, one definition.
  assert.equal(api.TRANSFER_PORT, "transfer");
  assert.equal(api.TX_MEMO_MAX_BYTES, 256);
  assert.ok(!("DEFAULT_TRANSFER_PORT" in api));
  assert.ok(!("MEMO_MAX_BYTES" in api));
});

/* -------------------------------------------------------------------------- *
 * Invariant 1 — the wasm memo has exactly `contract` and `msg`
 * -------------------------------------------------------------------------- */

test("every wasm memo this package can build has exactly contract and msg", async () => {
  const direct = buildWasmHookMemoJson(OSMOSIS_XCS, { ping: {} });
  assert.deepEqual(Object.keys(objectAt(direct, "wasm")), ["contract", "msg"]);

  const swap = buildXcsSwapMemoJson({
    contract: OSMOSIS_XCS,
    outputDenom: "uosmo",
    receiver: "osmo1recipient",
    slippage: { kind: "twap", slippagePercentage: "20", windowSeconds: 10 },
    onFailedDelivery: { kind: "do_nothing" },
  });
  assert.deepEqual(Object.keys(objectAt(swap, "wasm")), ["contract", "msg"]);

  // And the same rule holds for a memo the planner produced, which is the path
  // no module test covers on its own.
  const planned = await planRoute(
    request({ destChainId: "juno-1", outputDenom: "ujuno", allowSwap: true }),
    deps(),
  );
  const swapPlan = planned.candidates.find((c) => c.strategy === "ibc-swap");
  assert.ok(swapPlan, "expected a cross-chain swap candidate");
  const wasm = objectAt(memoOf(swapPlan), "wasm");
  assert.deepEqual(Object.keys(wasm), ["contract", "msg"]);
  assert.equal(wasm["contract"], OSMOSIS_XCS);
  assert.deepEqual(Object.keys(objectAt(wasm, "msg")), ["osmosis_swap"]);
});

/* -------------------------------------------------------------------------- *
 * Invariant 2 — only the last forward hop carries a real address
 * -------------------------------------------------------------------------- */

/** Walk a nested `forward` memo and collect each hop's receiver in order. */
function forwardReceivers(memo: unknown): string[] {
  const out: string[] = [];
  let node: unknown = memo;
  while (node !== null && typeof node === "object") {
    const forward = (node as Record<string, unknown>)["forward"];
    if (forward === null || typeof forward !== "object") break;
    const row = forward as Record<string, unknown>;
    const receiver = row["receiver"];
    assert.equal(typeof receiver, "string");
    out.push(receiver as string);
    node = row["next"];
  }
  return out;
}

test("PFM intermediate hops carry the pfm sentinel and only the last the recipient", () => {
  const memo = buildForwardMemoJson(
    [{ channelId: "channel-0" }, { channelId: "channel-141" }, { channelId: "channel-207" }],
    SAFRO_ADDRESS,
  );
  assert.deepEqual(forwardReceivers(memo), [
    PFM_INTERMEDIATE_RECEIVER,
    PFM_INTERMEDIATE_RECEIVER,
    SAFRO_ADDRESS,
  ]);
  assert.equal(PFM_INTERMEDIATE_RECEIVER, "pfm");
});

test("a planned multi-hop transfer names the recipient exactly once", async () => {
  const result = await planRoute(
    request({ destChainId: "juno-1", recipient: "juno1recipient" }),
    deps(),
  );
  const plan = result.best;
  assert.ok(plan, "expected a route");
  assert.ok(plan.plan.hops.length >= 3, "expected a forwarded route");

  const receivers = forwardReceivers(memoOf(plan));
  assert.equal(receivers.length, plan.plan.hops.length - 1);
  assert.equal(receivers.at(-1), "juno1recipient");
  for (const receiver of receivers.slice(0, -1)) {
    assert.equal(receiver, PFM_INTERMEDIATE_RECEIVER);
  }
  // The recipient must not appear anywhere but the final hop.
  assert.equal(plan.plan.memo.split("juno1recipient").length - 1, 1);
});

/* -------------------------------------------------------------------------- *
 * Invariant 3 — the ICS20 receiver of a wasm-hook transfer
 * -------------------------------------------------------------------------- */

test('an ibc-hooks transfer addresses the packet to "" or the contract', async () => {
  assert.equal(wasmHookReceiver(OSMOSIS_XCS), OSMOSIS_XCS);
  assert.equal(isWasmHookReceiverValid("", OSMOSIS_XCS), true);
  assert.equal(isWasmHookReceiverValid(OSMOSIS_XCS, OSMOSIS_XCS), true);
  assert.equal(isWasmHookReceiverValid("osmo1recipient", OSMOSIS_XCS), false);

  // A swap on the chain the first hop lands on: the signed transfer goes
  // straight to the contract, so its receiver is the contract itself.
  const direct = await planRoute(
    request({
      destChainId: "osmosis-1",
      inputDenom: "usafro",
      outputDenom: "uosmo",
      allowSwap: true,
    }),
    deps(),
  );
  const swap = direct.candidates.find((c) => c.strategy === "ibc-swap");
  assert.ok(swap, "expected a swap candidate");
  assert.equal(isWasmHookReceiverValid(swap.receiver, OSMOSIS_XCS), true);

  // With a hop before the venue the signed packet is addressed to the
  // intermediate chain, and the contract becomes the receiver of the *forward*
  // that lands on Osmosis.
  const viaHub = await planRoute(
    request({
      sourceChainId: "cosmoshub-4",
      destChainId: "juno-1",
      inputDenom: "uatom",
      outputDenom: "ujuno",
      sender: "cosmos1sender",
      recipient: "juno1recipient",
      allowSwap: true,
    }),
    deps(),
  );
  const hopped = viaHub.candidates.find(
    (c) => c.strategy === "ibc-swap" && c.plan.hops.length > 2,
  );
  if (hopped) {
    const receivers = forwardReceivers(memoOf(hopped));
    if (receivers.length > 0) {
      assert.equal(isWasmHookReceiverValid(receivers.at(-1) ?? "", OSMOSIS_XCS), true);
    }
  }
});

/* -------------------------------------------------------------------------- *
 * Invariant 4 — unwinding walks the trace path in the right order
 * -------------------------------------------------------------------------- */

test("unwinding follows the trace path left to right, outermost hop first", async () => {
  // A token that went Hub -> Osmosis -> Juno. On Juno the path reads
  // "transfer/channel-0/transfer/channel-141": ICS20 prepends on receipt, so
  // the leftmost pair is the *last* hop it made and the first one to undo.
  const path = "transfer/channel-0/transfer/channel-141";
  const hops = parseTracePath(path);
  assert.deepEqual(
    hops.map((hop) => hop.channelId),
    ["channel-0", "channel-141"],
  );
  assert.equal(joinTracePath(hops), path);

  const wrapped: ResolvedDenom = {
    denom: `ibc/${await ibcDenomHashHex(path, "uatom")}`,
    baseDenom: "uatom",
    path,
    hops,
    originChainId: "cosmoshub-4",
    isNative: false,
    ibcHash: await ibcDenomHashHex(path, "uatom"),
  };

  const steps = await unwindPath(wrapped);
  assert.deepEqual(
    steps.map((step) => step.channelId),
    ["channel-0", "channel-141"],
    "the first step must burn over the outermost hop, not the innermost",
  );
  // Each step strips one pair from the left and the last lands on the base denom.
  assert.equal(steps[0]?.nextPath, "transfer/channel-141");
  assert.equal(steps.at(-1)?.nextPath, "");
  assert.equal(steps.at(-1)?.nextDenom, "uatom");
  assert.equal(steps.at(-1)?.landsOnOrigin, true);
});

/* -------------------------------------------------------------------------- *
 * Invariant 5 — ibc/HASH round-trips
 * -------------------------------------------------------------------------- */

test("an ibc/HASH denom round-trips through the hash computation", async () => {
  const denom = await ibcDenomHash("transfer/channel-0", "uatom");
  assert.equal(denom, ATOM_ON_OSMOSIS);
  assert.equal(isIbcDenom(denom), true);

  const hash = ibcHashFromDenom(denom);
  assert.equal(hash, ATOM_ON_OSMOSIS.slice("ibc/".length));
  assert.equal(await ibcDenomHashHex("transfer/channel-0", "uatom"), hash);

  // Re-hashing the parsed-then-rejoined path must give the same denom, or the
  // wallet would show a token nobody holds.
  const rejoined = joinTracePath(parseTracePath("transfer/channel-0"));
  assert.equal(await ibcDenomHash(rejoined, "uatom"), denom);
});

test("the planner's ibc/HASH agrees with denom.ts", async () => {
  const trace: ResolvedDenom = {
    denom: "uatom",
    baseDenom: "uatom",
    path: "",
    hops: [],
    originChainId: "cosmoshub-4",
    isNative: true,
    ibcHash: null,
  };
  const resolve: RouteDenomResolver = async () => trace;
  const result = await planRoute(
    request({
      sourceChainId: "cosmoshub-4",
      destChainId: "osmosis-1",
      inputDenom: "uatom",
      sender: "cosmos1sender",
      recipient: "osmo1recipient",
    }),
    deps({ resolveDenom: resolve }),
  );
  const plan = result.best;
  assert.ok(plan);
  // Hub -> Osmosis over the Hub's channel-141, whose Osmosis end is channel-0.
  // The planner must name the denom denom.ts would compute for that path.
  assert.equal(
    plan.plan.outputDenom,
    await ibcDenomHash("transfer/channel-0", "uatom"),
  );
  assert.equal(plan.plan.outputDenom, ATOM_ON_OSMOSIS);
});
