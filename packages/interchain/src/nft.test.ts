/**
 * Offline tests for the NFT module.
 *
 * Nothing here touches the network: the {@link LcdClient} is a stub that decodes
 * the base64url query out of the path and answers from a table, and the metadata
 * fetcher is a plain function. Every assertion is on a shape we have to get
 * exactly right — the base64 nesting in `send_nft`, the ICS721 `IbcOutgoingMsg`,
 * the `addr_safro` prefix, and what each parser does with a broken body.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeBase64UrlUtf8, decodeBase64Utf8, encodeBase64Utf8 } from "./base64.js";
import {
  DEFAULT_ICS721_TIMEOUT_MINUTES,
  ICS721_VOUCHER_WARNING,
  NFT_DISCOVERY_LIMITATION,
  addressHasPrefix,
  applyNftMetadata,
  assertCosmWasmChain,
  buildExecuteContractMsg,
  buildIcs721TransferMsg,
  buildNftTransferMsg,
  buildSendNftMsg,
  buildTransferNftMsg,
  discoverNfts,
  fetchNftMetadata,
  getAllNftInfo,
  getCollectionInfo,
  getNftInfo,
  getNftToken,
  getNumTokens,
  getOwnerOf,
  ics721TransferWarnings,
  listAllOwnedTokenIds,
  listAllTokenIds,
  listOwnedTokenIds,
  parseNftMetadata,
  resolveTokenUri,
  smartQuery,
  smartQueryPath,
  supportsCosmWasm,
  supportsIcs721,
  unwrapSmartQueryData,
  type NftChainContext,
  type NftIndexer,
} from "./nft.js";
import {
  InterchainError,
  isInterchainError,
  type ChainInfoLike,
  type InterchainErrorCode,
  type JsonObject,
  type LcdClient,
  type NftTransferRequest,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const SAFRO: ChainInfoLike = {
  chainId: "safrochain-1",
  chainName: "Safrochain",
  // The whole point of the prefix tests: an underscore, which `[a-z]+1` rejects.
  bech32Prefix: "addr_safro",
  coinType: 118,
  coinDenom: "SAFRO",
  coinMinimalDenom: "usafro",
  coinDecimals: 6,
  feeDenom: "SAFRO",
  feeMinimalDenom: "usafro",
  feeDecimals: 6,
  features: ["cosmwasm"],
  rest: "https://lcd.safro.example",
};

const OSMOSIS: ChainInfoLike = {
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
  features: ["cosmwasm", "ibc-transfer"],
  rest: "https://lcd.osmosis.example",
};

const NO_WASM: ChainInfoLike = { ...SAFRO, chainId: "nowasm-1", features: ["stargate"] };
const NO_FEATURES: ChainInfoLike = { ...SAFRO, chainId: "unknown-1", features: undefined };

const OWNER = "addr_safro1owner00000000000000000000000000000";
const RECIPIENT = "addr_safro1recipient0000000000000000000000000";
const COLLECTION = "addr_safro1collection00000000000000000000000";
const BRIDGE = "addr_safro1bridge0000000000000000000000000000";
const OSMO_RECIPIENT = "osmo1recipient000000000000000000000000000000";

/* -------------------------------------------------------------------------- *
 * Stub LCD
 * -------------------------------------------------------------------------- */

interface StubCall {
  readonly contract: string;
  readonly query: JsonObject;
}

type StubHandler = (call: StubCall) => unknown;

interface Stub {
  readonly lcd: LcdClient;
  readonly calls: StubCall[];
}

const SMART_PATH = /^\/cosmwasm\/wasm\/v1\/contract\/([^/]+)\/smart\/(.+)$/;

/**
 * An {@link LcdClient} that decodes the smart-query path and answers from
 * `handler`. Returning a value wraps it in the `{ data: … }` envelope; throwing
 * propagates, so a handler can simulate an HTTP 400 from wasmd.
 */
function stubLcd(handler: StubHandler, chainId = SAFRO.chainId): Stub {
  const calls: StubCall[] = [];
  const lcd: LcdClient = {
    chainId,
    async getJson(path) {
      const match = SMART_PATH.exec(path);
      assert.ok(match, `unexpected path ${path}`);
      const contract = decodeURIComponent(match[1] ?? "");
      const query = JSON.parse(decodeBase64UrlUtf8(match[2] ?? "")) as JsonObject;
      const call: StubCall = { contract, query };
      calls.push(call);
      const result = handler(call);
      // A handler may hand back a pre-built envelope to test the unwrapper.
      if (isEnvelope(result)) return result;
      return { data: result };
    },
  };
  return { lcd, calls };
}

function isEnvelope(value: unknown): boolean {
  return typeof value === "object" && value !== null && "__raw" in value;
}

/** Wrap a body so the stub returns it verbatim instead of enveloping it. */
function raw(body: unknown): unknown {
  return { __raw: true, ...(typeof body === "object" && body !== null ? body : {}) };
}

function ctxOf(stub: Stub, chain: ChainInfoLike = SAFRO): NftChainContext {
  return { chain, lcd: stub.lcd };
}

/** Narrow a JSON value to an object, failing the test when it is not one. */
function obj(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  assert.fail(`expected an object, got ${String(value)}`);
}

/** The single top-level key of a decoded CosmWasm message. */
function actionOf(query: JsonObject): string {
  return Object.keys(query)[0] ?? "";
}

function expectThrows(fn: () => unknown, code: InterchainErrorCode): InterchainError {
  try {
    fn();
  } catch (error) {
    assert.ok(isInterchainError(error), `expected InterchainError, got ${String(error)}`);
    assert.equal(error.code, code, `message was: ${error.message}`);
    return error;
  }
  assert.fail(`expected ${code}, nothing thrown`);
}

async function expectRejects(
  promise: Promise<unknown>,
  code: InterchainErrorCode,
): Promise<InterchainError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isInterchainError(error), `expected InterchainError, got ${String(error)}`);
    assert.equal(error.code, code, `message was: ${error.message}`);
    return error;
  }
  assert.fail(`expected ${code}, nothing thrown`);
}

/** The ExecuteMsg carried in a built `MsgExecuteContract`. */
function executeMsgOf(value: JsonObject): JsonObject {
  const encoded = value.msg;
  assert.equal(typeof encoded, "string");
  return JSON.parse(decodeBase64Utf8(encoded as string)) as JsonObject;
}

/* -------------------------------------------------------------------------- *
 * Capability gate
 * -------------------------------------------------------------------------- */

test("cosmwasm gate: declared, missing, and unknown feature lists", () => {
  assert.equal(supportsCosmWasm(SAFRO), true);
  assert.equal(supportsCosmWasm(NO_WASM), false);
  // Absent is not the same as declared, and defaults to refusing.
  assert.equal(supportsCosmWasm(NO_FEATURES), false);
  assert.equal(supportsCosmWasm(NO_FEATURES, { allowUnknownFeatures: true }), true);
  assert.equal(supportsCosmWasm(NO_WASM, { allowUnknownFeatures: true }), false);

  const error = expectThrows(() => assertCosmWasmChain(NO_WASM), "unsupported-chain");
  assert.match(error.message, /cosmwasm/);
  assert.equal(error.chainId, "nowasm-1");
  expectThrows(() => assertCosmWasmChain(NO_FEATURES), "unsupported-chain");
  assert.doesNotThrow(() => assertCosmWasmChain(SAFRO));
});

/* -------------------------------------------------------------------------- *
 * bech32 prefixes
 * -------------------------------------------------------------------------- */

test("addressHasPrefix handles the underscore in addr_safro", () => {
  assert.equal(addressHasPrefix(OWNER, "addr_safro"), true);
  assert.equal(addressHasPrefix(OSMO_RECIPIENT, "osmo"), true);

  // Wrong chain.
  assert.equal(addressHasPrefix(OSMO_RECIPIENT, "addr_safro"), false);
  assert.equal(addressHasPrefix(OWNER, "osmo"), false);

  // Not a partial match on the segment before the underscore.
  assert.equal(addressHasPrefix(OWNER, "addr"), false);
  assert.equal(addressHasPrefix("addr1abc", "addr_safro"), false);

  // Separator and payload both required.
  assert.equal(addressHasPrefix("addr_safro", "addr_safro"), false);
  assert.equal(addressHasPrefix("addr_safro1", "addr_safro"), false);
  assert.equal(addressHasPrefix("", "addr_safro"), false);
  assert.equal(addressHasPrefix(OWNER, ""), false);
});

test("message builders reject an address from another chain", () => {
  const wrongRecipient = expectThrows(
    () =>
      buildTransferNftMsg(SAFRO, {
        sender: OWNER,
        collectionAddress: COLLECTION,
        tokenId: "1",
        recipient: OSMO_RECIPIENT,
      }),
    "contract-error",
  );
  assert.match(wrongRecipient.message, /addr_safro/);

  expectThrows(
    () =>
      buildTransferNftMsg(SAFRO, {
        sender: OSMO_RECIPIENT,
        collectionAddress: COLLECTION,
        tokenId: "1",
        recipient: RECIPIENT,
      }),
    "contract-error",
  );
});

/* -------------------------------------------------------------------------- *
 * Smart queries
 * -------------------------------------------------------------------------- */

test("smartQueryPath encodes the query as unpadded base64url", () => {
  const path = smartQueryPath(COLLECTION, { num_tokens: {} });
  const match = SMART_PATH.exec(path);
  assert.ok(match);
  assert.equal(match[1], COLLECTION);
  assert.ok(!(match[2] ?? "").includes("="), "base64url in a path must not be padded");
  assert.equal(decodeBase64UrlUtf8(match[2] ?? ""), '{"num_tokens":{}}');
});

test("smartQueryPath refuses an empty contract and escapes a hostile one", () => {
  expectThrows(() => smartQueryPath("   ", { num_tokens: {} }), "contract-error");
  const path = smartQueryPath("evil/../../foo", { num_tokens: {} });
  assert.ok(!path.includes("../"), path);
});

test("unwrapSmartQueryData accepts inline JSON, base64 bytes, and a bare string", () => {
  assert.deepEqual(unwrapSmartQueryData({ data: { count: 1 } }, "c-1"), { count: 1 });
  assert.deepEqual(
    unwrapSmartQueryData({ data: encodeBase64Utf8('{"count":2}') }, "c-1"),
    { count: 2 },
  );
  // A contract may legitimately answer with a bare string; it must survive the
  // base64 attempt rather than becoming an error.
  assert.equal(unwrapSmartQueryData({ data: "hello" }, "c-1"), "hello");
});

test("unwrapSmartQueryData rejects a body with no usable data", () => {
  for (const body of [null, 42, "text", [], {}, { data: null }, { result: {} }]) {
    expectThrows(() => unwrapSmartQueryData(body, "c-1"), "malformed-response");
  }
});

test("smartQuery reclassifies an HTTP 400 as a contract error", async () => {
  const stub = stubLcd(() => {
    throw new InterchainError("lcd-unreachable", "HTTP 400", {
      chainId: SAFRO.chainId,
      httpStatus: 400,
    });
  });
  const error = await expectRejects(
    smartQuery(stub.lcd, COLLECTION, { num_tokens: {} }),
    "contract-error",
  );
  assert.match(error.message, /num_tokens/);
});

test("smartQuery leaves cancellation and the reads gate alone", async () => {
  for (const code of ["aborted", "reads-disabled"] as const) {
    const stub = stubLcd(() => {
      throw new InterchainError(code, "stop");
    });
    await expectRejects(smartQuery(stub.lcd, COLLECTION, { num_tokens: {} }), code);
  }
});

/* -------------------------------------------------------------------------- *
 * Token id lists
 * -------------------------------------------------------------------------- */

test("listOwnedTokenIds sends the spec's tokens query and reports a cursor", async () => {
  const stub = stubLcd(() => ({ tokens: ["1", "2", "3"] }));
  const page = await listOwnedTokenIds(ctxOf(stub), COLLECTION, OWNER, { limit: 3 });

  assert.deepEqual(stub.calls[0]?.query, {
    tokens: { owner: OWNER, limit: 3 },
  });
  assert.deepEqual(page.tokenIds, ["1", "2", "3"]);
  // A full page means there may be another.
  assert.equal(page.nextStartAfter, "3");
});

test("listOwnedTokenIds omits start_after until there is a cursor", async () => {
  const stub = stubLcd(() => ({ tokens: ["9"] }));
  await listOwnedTokenIds(ctxOf(stub), COLLECTION, OWNER, {
    limit: 3,
    startAfter: "8",
  });
  assert.deepEqual(stub.calls[0]?.query, {
    tokens: { owner: OWNER, start_after: "8", limit: 3 },
  });
});

test("listOwnedTokenIds clamps the page size", async () => {
  const stub = stubLcd(() => ({ tokens: [] }));
  await listOwnedTokenIds(ctxOf(stub), COLLECTION, OWNER, { limit: 5_000 });
  await listOwnedTokenIds(ctxOf(stub), COLLECTION, OWNER, { limit: 0 });
  await listOwnedTokenIds(ctxOf(stub), COLLECTION, OWNER, {});

  const limits = stub.calls.map((call) => obj(call.query.tokens).limit);
  assert.deepEqual(limits, [100, 1, 30]);
});

test("listOwnedTokenIds drops non-string entries and rejects a broken body", async () => {
  const mixed = stubLcd(() => ({ tokens: ["a", 7, null, { id: "x" }, "b"] }));
  const page = await listOwnedTokenIds(ctxOf(mixed), COLLECTION, OWNER);
  assert.deepEqual(page.tokenIds, ["a", "7", "b"]);

  for (const body of [{}, { tokens: "1" }, { tokens: null }, [], "nope"]) {
    const stub = stubLcd(() => body);
    await expectRejects(
      listOwnedTokenIds(ctxOf(stub), COLLECTION, OWNER),
      "malformed-response",
    );
  }
});

test("listAllTokenIds uses all_tokens, not tokens", async () => {
  const stub = stubLcd(() => ({ tokens: ["1"] }));
  await listAllTokenIds(ctxOf(stub), COLLECTION, { limit: 2 });
  assert.deepEqual(stub.calls[0]?.query, { all_tokens: { limit: 2 } });
});

test("listAllOwnedTokenIds pages until the contract runs out", async () => {
  const pages = [["1", "2"], ["3", "4"], ["5"]];
  let index = 0;
  const stub = stubLcd(() => ({ tokens: pages[index++] ?? [] }));

  const result = await listAllOwnedTokenIds(ctxOf(stub), COLLECTION, OWNER, { limit: 2 });
  assert.deepEqual(result.tokenIds, ["1", "2", "3", "4", "5"]);
  assert.equal(result.truncated, false);
  assert.equal(stub.calls.length, 3);
});

test("listAllOwnedTokenIds stops at the cap and says so", async () => {
  let next = 0;
  const stub = stubLcd(() => ({
    tokens: [String(++next), String(++next), String(++next)],
  }));
  const result = await listAllOwnedTokenIds(ctxOf(stub), COLLECTION, OWNER, {
    limit: 3,
    maxTokens: 5,
  });
  assert.deepEqual(result.tokenIds, ["1", "2", "3", "4", "5"]);
  assert.equal(result.truncated, true);
});

test("listAllOwnedTokenIds refuses to loop on a contract that repeats a page", async () => {
  // A full page of the same ids means the cursor never advances. Without the
  // guard this runs until the page budget, hammering a public LCD.
  const stub = stubLcd(() => ({ tokens: ["same", "same"] }));
  const result = await listAllOwnedTokenIds(ctxOf(stub), COLLECTION, OWNER, {
    limit: 2,
    maxTokens: 50,
  });
  assert.deepEqual(result.tokenIds, ["same"]);
  assert.equal(result.truncated, true);
  assert.equal(stub.calls.length, 2);
});

/* -------------------------------------------------------------------------- *
 * Token detail
 * -------------------------------------------------------------------------- */

test("getNftInfo parses token_uri and the on-chain extension", async () => {
  const stub = stubLcd(() => ({
    token_uri: "ipfs://QmHash/1.json",
    extension: {
      name: "Zebra #1",
      description: "on chain",
      image: "ipfs://QmImage",
      animation_url: "ipfs://QmAnim",
      external_url: "https://example.test",
      attributes: [{ trait_type: "Coat", value: "Striped", display_type: "string" }],
    },
  }));

  const info = await getNftInfo(ctxOf(stub), COLLECTION, "1");
  assert.deepEqual(stub.calls[0]?.query, { nft_info: { token_id: "1" } });
  assert.equal(info.tokenUri, "ipfs://QmHash/1.json");
  assert.equal(info.metadata.name, "Zebra #1");
  assert.equal(info.metadata.externalUrl, "https://example.test");
  assert.deepEqual(info.metadata.attributes, [
    { traitType: "Coat", value: "Striped", displayType: "string" },
  ]);
});

test("getNftInfo tolerates a token with no metadata at all", async () => {
  const stub = stubLcd(() => ({ token_uri: null, extension: null }));
  const info = await getNftInfo(ctxOf(stub), COLLECTION, "1");
  assert.equal(info.tokenUri, null);
  assert.equal(info.metadata.name, null);
  assert.deepEqual(info.metadata.attributes, []);
});

test("getNftInfo rejects a non-object reply", async () => {
  for (const body of ["nope", 5, []]) {
    const stub = stubLcd(() => body);
    await expectRejects(getNftInfo(ctxOf(stub), COLLECTION, "1"), "malformed-response");
  }
});

test("getOwnerOf parses approvals and their expirations", async () => {
  const stub = stubLcd(() => ({
    owner: OWNER,
    approvals: [
      { spender: RECIPIENT, expires: { at_height: 1234 } },
      { spender: COLLECTION, expires: { at_time: "1700000000000000000" } },
      { spender: BRIDGE, expires: { never: {} } },
      { spender: BRIDGE, expires: { some_future_variant: {} } },
      { expires: { never: {} } },
      "garbage",
    ],
  }));

  const ownership = await getOwnerOf(ctxOf(stub), COLLECTION, "1", {
    includeExpired: true,
  });
  assert.deepEqual(stub.calls[0]?.query, {
    owner_of: { token_id: "1", include_expired: true },
  });
  assert.equal(ownership.owner, OWNER);
  assert.equal(ownership.approvals.length, 4);
  assert.equal(ownership.approvals[0]?.expiresAtHeight, "1234");
  assert.equal(ownership.approvals[1]?.expiresAtTimeNanos, "1700000000000000000");
  assert.equal(ownership.approvals[2]?.neverExpires, true);
  // An unknown expiration variant is described as "we do not know", not dropped.
  assert.equal(ownership.approvals[3]?.neverExpires, false);
  assert.equal(ownership.approvals[3]?.expiresAtHeight, null);
});

test("getOwnerOf omits include_expired when the caller did not ask", async () => {
  const stub = stubLcd(() => ({ owner: OWNER, approvals: [] }));
  await getOwnerOf(ctxOf(stub), COLLECTION, "1");
  assert.deepEqual(stub.calls[0]?.query, { owner_of: { token_id: "1" } });
});

test("getOwnerOf rejects a reply with no owner", async () => {
  for (const body of [{}, { owner: "" }, { owner: 7 }, null]) {
    const stub = stubLcd(() => body);
    await expectRejects(getOwnerOf(ctxOf(stub), COLLECTION, "1"), "malformed-response");
  }
});

test("getAllNftInfo splits access from info", async () => {
  const stub = stubLcd(() => ({
    access: { owner: OWNER, approvals: [] },
    info: { token_uri: "https://meta.test/1", extension: { name: "One" } },
  }));
  const all = await getAllNftInfo(ctxOf(stub), COLLECTION, "1");
  assert.deepEqual(stub.calls[0]?.query, { all_nft_info: { token_id: "1" } });
  assert.equal(all.access.owner, OWNER);
  assert.equal(all.info.tokenUri, "https://meta.test/1");
  assert.equal(all.info.metadata.name, "One");
});

test("getAllNftInfo rejects a half-formed reply", async () => {
  for (const body of [{ access: { owner: OWNER } }, { info: {} }, { access: {}, info: {} }]) {
    const stub = stubLcd(() => body);
    await expectRejects(
      getAllNftInfo(ctxOf(stub), COLLECTION, "1"),
      "malformed-response",
    );
  }
});

test("getNumTokens accepts a number or a stringified uint", async () => {
  const asNumber = stubLcd(() => ({ count: 42 }));
  assert.equal(await getNumTokens(ctxOf(asNumber), COLLECTION), 42);

  const asText = stubLcd(() => ({ count: "42" }));
  assert.equal(await getNumTokens(ctxOf(asText), COLLECTION), 42);

  for (const body of [{}, { count: -1 }, { count: "x" }, { count: 1.5 }, null]) {
    const stub = stubLcd(() => body);
    await expectRejects(getNumTokens(ctxOf(stub), COLLECTION), "malformed-response");
  }
});

test("getNftToken builds an NftToken without touching token_uri", async () => {
  const stub = stubLcd(() => ({
    access: { owner: OWNER, approvals: [] },
    info: {
      token_uri: "ipfs://QmHash/1.json",
      extension: { name: "Zebra", image: "ipfs://QmImage" },
    },
  }));
  const token = await getNftToken(ctxOf(stub), COLLECTION, "7");
  assert.equal(stub.calls.length, 1, "one round trip, not two");
  assert.deepEqual(token, {
    tokenId: "7",
    name: "Zebra",
    description: null,
    imageUri: "ipfs://QmImage",
    animationUri: null,
    attributes: [],
    collectionAddress: COLLECTION,
    chainId: SAFRO.chainId,
    owner: OWNER,
    tokenUri: "ipfs://QmHash/1.json",
  });
});

/* -------------------------------------------------------------------------- *
 * Collection info
 * -------------------------------------------------------------------------- */

test("getCollectionInfo prefers collection_info", async () => {
  const stub = stubLcd((call) =>
    actionOf(call.query) === "num_tokens"
      ? { count: 3 }
      : { name: "Zebras", symbol: "ZEB", extension: { description: "d", creator: OWNER } },
  );

  const collection = await getCollectionInfo(ctxOf(stub), COLLECTION);
  assert.equal(actionOf(stub.calls[0]?.query ?? {}), "collection_info");
  assert.deepEqual(collection, {
    chainId: SAFRO.chainId,
    contractAddress: COLLECTION,
    name: "Zebras",
    symbol: "ZEB",
    description: "d",
    imageUri: null,
    tokenCount: 3,
    creator: OWNER,
  });
});

test("getCollectionInfo falls back to contract_info on older contracts", async () => {
  const stub = stubLcd((call) => {
    const action = actionOf(call.query);
    if (action === "collection_info") {
      throw new InterchainError("lcd-unreachable", "HTTP 400", { httpStatus: 400 });
    }
    if (action === "num_tokens") return { count: 1 };
    return { name: "Old", symbol: "OLD" };
  });

  const collection = await getCollectionInfo(ctxOf(stub), COLLECTION);
  assert.deepEqual(
    stub.calls.map((call) => actionOf(call.query)),
    ["collection_info", "contract_info", "num_tokens"],
  );
  assert.equal(collection.name, "Old");
  assert.equal(collection.description, null);
});

test("getCollectionInfo reports contract-error when neither spelling works", async () => {
  const stub = stubLcd(() => {
    throw new InterchainError("lcd-unreachable", "HTTP 400", { httpStatus: 400 });
  });
  const error = await expectRejects(
    getCollectionInfo(ctxOf(stub), COLLECTION),
    "contract-error",
  );
  assert.match(error.message, /neither collection_info nor contract_info/);
});

test("getCollectionInfo does not swallow a genuinely unreachable node", async () => {
  const stub = stubLcd(() => {
    throw new InterchainError("lcd-unreachable", "timed out");
  });
  await expectRejects(getCollectionInfo(ctxOf(stub), COLLECTION), "lcd-unreachable");
});

test("getCollectionInfo leaves tokenCount null when num_tokens fails", async () => {
  const stub = stubLcd((call) => {
    if (actionOf(call.query) === "num_tokens") {
      throw new InterchainError("lcd-unreachable", "HTTP 400", { httpStatus: 400 });
    }
    return { name: "Zebras", symbol: "ZEB" };
  });
  const collection = await getCollectionInfo(ctxOf(stub), COLLECTION);
  assert.equal(collection.tokenCount, null);
});

test("getCollectionInfo can skip the extra num_tokens round trip", async () => {
  const stub = stubLcd(() => ({ name: "Zebras", symbol: "ZEB" }));
  const collection = await getCollectionInfo(ctxOf(stub), COLLECTION, {
    includeTokenCount: false,
  });
  assert.equal(stub.calls.length, 1);
  assert.equal(collection.tokenCount, null);
});

test("getCollectionInfo rejects a non-object payload", async () => {
  const stub = stubLcd((call) =>
    actionOf(call.query) === "num_tokens" ? { count: 0 } : raw({ data: 5 }),
  );
  await expectRejects(getCollectionInfo(ctxOf(stub), COLLECTION), "malformed-response");
});

/* -------------------------------------------------------------------------- *
 * Metadata parsing
 * -------------------------------------------------------------------------- */

test("parseNftMetadata never throws on junk", () => {
  for (const body of [null, undefined, 5, "text", [], true]) {
    const parsed = parseNftMetadata(body);
    assert.equal(parsed.name, null);
    assert.deepEqual(parsed.attributes, []);
  }
});

test("parseNftMetadata coerces attribute values instead of dropping traits", () => {
  const parsed = parseNftMetadata({
    name: "",
    attributes: [
      { trait_type: "Level", value: 7 },
      { trait_type: "Shiny", value: true },
      { trait_type: "Missing", value: null },
      { value: "no trait type" },
      { trait_type: "Nested", value: { a: 1 } },
      "not an object",
      { trait_type: "NoValue" },
    ],
  });
  // An empty string is the same as absent for a display name.
  assert.equal(parsed.name, null);
  assert.deepEqual(parsed.attributes, [
    { traitType: "Level", value: "7", displayType: null },
    { traitType: "Shiny", value: "true", displayType: null },
    { traitType: "Missing", value: "", displayType: null },
    { traitType: "", value: "no trait type", displayType: null },
    { traitType: "Nested", value: '{"a":1}', displayType: null },
    { traitType: "NoValue", value: "", displayType: null },
  ]);
});

test("parseNftMetadata ignores a non-array attributes field", () => {
  assert.deepEqual(parseNftMetadata({ attributes: { a: 1 } }).attributes, []);
  assert.deepEqual(parseNftMetadata({ attributes: "none" }).attributes, []);
});

test("applyNftMetadata fills gaps without overwriting on-chain values", () => {
  const token = {
    tokenId: "1",
    name: "On chain",
    description: null,
    imageUri: null,
    animationUri: null,
    attributes: [],
    collectionAddress: COLLECTION,
    chainId: SAFRO.chainId,
    owner: OWNER,
    tokenUri: "ipfs://Qm",
  };
  const merged = applyNftMetadata(token, {
    name: "Off chain",
    description: "from the host",
    image: "https://img.test/1.png",
    animationUrl: null,
    externalUrl: null,
    attributes: [{ traitType: "Coat", value: "Striped", displayType: null }],
  });
  assert.equal(merged.name, "On chain");
  assert.equal(merged.description, "from the host");
  assert.equal(merged.imageUri, "https://img.test/1.png");
  assert.equal(merged.attributes.length, 1);
});

/* -------------------------------------------------------------------------- *
 * token_uri resolution
 * -------------------------------------------------------------------------- */

test("resolveTokenUri maps ipfs:// onto every configured gateway", () => {
  const resolved = resolveTokenUri("ipfs://QmHash/meta/1.json", {
    ipfsGateways: ["https://a.test/ipfs/", "https://b.test/ipfs"],
  });
  assert.equal(resolved.kind, "http");
  assert.deepEqual(resolved.urls, [
    "https://a.test/ipfs/QmHash/meta/1.json",
    "https://b.test/ipfs/QmHash/meta/1.json",
  ]);
});

test("resolveTokenUri strips a duplicated ipfs/ segment", () => {
  const resolved = resolveTokenUri("ipfs://ipfs/QmHash/1.json", {
    ipfsGateways: ["https://a.test/ipfs/"],
  });
  assert.deepEqual(resolved.urls, ["https://a.test/ipfs/QmHash/1.json"]);
});

test("resolveTokenUri treats a bare CID as IPFS", () => {
  const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const resolved = resolveTokenUri(cid, { ipfsGateways: ["https://a.test/ipfs"] });
  assert.deepEqual(resolved.urls, [`https://a.test/ipfs/${cid}`]);
});

test("resolveTokenUri refuses ipfs with no gateway configured", () => {
  const resolved = resolveTokenUri("ipfs://QmHash", {});
  assert.equal(resolved.kind, "unsupported");
  assert.match(resolved.reason ?? "", /gateway/i);
});

test("resolveTokenUri allows https and blocks http unless asked", () => {
  assert.deepEqual(resolveTokenUri("https://meta.test/1").urls, ["https://meta.test/1"]);

  const blocked = resolveTokenUri("http://meta.test/1");
  assert.equal(blocked.kind, "unsupported");
  assert.match(blocked.reason ?? "", /http/);

  const allowed = resolveTokenUri("http://meta.test/1", { allowInsecureHttp: true });
  assert.deepEqual(allowed.urls, ["http://meta.test/1"]);
});

test("resolveTokenUri decodes data: URIs locally", () => {
  const json = '{"name":"Inline"}';
  const b64 = resolveTokenUri(`data:application/json;base64,${encodeBase64Utf8(json)}`);
  assert.equal(b64.kind, "inline");
  assert.equal(b64.inline, json);

  const plain = resolveTokenUri(`data:application/json,${encodeURIComponent(json)}`);
  assert.equal(plain.kind, "inline");
  assert.equal(plain.inline, json);

  const broken = resolveTokenUri("data:application/json;base64,!!!!");
  assert.equal(broken.kind, "unsupported");
});

test("resolveTokenUri rejects empty and unknown schemes", () => {
  assert.equal(resolveTokenUri("   ").kind, "unsupported");
  assert.equal(resolveTokenUri("ftp://meta.test/1").kind, "unsupported");
  assert.equal(resolveTokenUri("ar://tx", {}).kind, "unsupported");
  assert.deepEqual(
    resolveTokenUri("ar://tx", { arweaveGateways: ["https://ar.test"] }).urls,
    ["https://ar.test/tx"],
  );
});

/* -------------------------------------------------------------------------- *
 * Metadata fetching (privacy opt-in)
 * -------------------------------------------------------------------------- */

test("fetchNftMetadata reads a data: URI with no fetcher and no network", async () => {
  const uri = `data:application/json;base64,${encodeBase64Utf8('{"name":"Inline"}')}`;
  const result = await fetchNftMetadata(uri);
  assert.equal(result.source, "inline");
  assert.equal(result.url, null);
  assert.equal(result.metadata.name, "Inline");
});

test("fetchNftMetadata refuses a remote read when no fetcher was supplied", async () => {
  // The privacy gate: without a transport there is nothing to leak through.
  const error = await expectRejects(
    fetchNftMetadata("https://meta.test/1"),
    "reads-disabled",
  );
  assert.match(error.message, /fetcher/);
});

test("fetchNftMetadata tries each gateway in order", async () => {
  const seen: string[] = [];
  const result = await fetchNftMetadata("ipfs://QmHash/1.json", {
    ipfsGateways: ["https://a.test/ipfs", "https://b.test/ipfs"],
    fetch: async (url) => {
      seen.push(url);
      if (url.startsWith("https://a.test")) throw new Error("502");
      return { name: "Second gateway" };
    },
  });
  assert.deepEqual(seen, [
    "https://a.test/ipfs/QmHash/1.json",
    "https://b.test/ipfs/QmHash/1.json",
  ]);
  assert.equal(result.source, "remote");
  assert.equal(result.url, "https://b.test/ipfs/QmHash/1.json");
  assert.equal(result.metadata.name, "Second gateway");
});

test("fetchNftMetadata reports lcd-unreachable when every gateway fails", async () => {
  await expectRejects(
    fetchNftMetadata("ipfs://QmHash", {
      ipfsGateways: ["https://a.test/ipfs"],
      fetch: async () => {
        throw new Error("nope");
      },
    }),
    "lcd-unreachable",
  );
});

test("fetchNftMetadata surfaces an unresolvable token_uri as malformed", async () => {
  await expectRejects(fetchNftMetadata("ftp://meta.test/1"), "malformed-response");
  await expectRejects(fetchNftMetadata("data:application/json;base64,!!!"), "malformed-response");
});

test("fetchNftMetadata does not fail on a body that is not a metadata document", async () => {
  const result = await fetchNftMetadata("https://meta.test/1", {
    fetch: async () => "just a string",
  });
  assert.equal(result.metadata.name, null);
  assert.deepEqual(result.metadata.attributes, []);
});

test("fetchNftMetadata stops immediately when the caller aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await expectRejects(
    fetchNftMetadata("https://meta.test/1", {
      signal: controller.signal,
      fetch: async () => {
        assert.fail("must not fetch after abort");
      },
    }),
    "aborted",
  );
});

/* -------------------------------------------------------------------------- *
 * Discovery
 * -------------------------------------------------------------------------- */

const A = "addr_safro1aaa0000000000000000000000000000000000";
const B = "addr_safro1bbb0000000000000000000000000000000000";
const C = "addr_safro1ccc0000000000000000000000000000000000";

test("discoverNfts scans a known contract list and admits it is partial", async () => {
  const stub = stubLcd((call) => ({ tokens: call.contract === A ? ["1", "2"] : [] }));
  const result = await discoverNfts(ctxOf(stub), OWNER, { knownContracts: [A, B] });

  assert.equal(result.holdings.length, 1);
  assert.equal(result.holdings[0]?.contractAddress, A);
  assert.equal(result.holdings[0]?.source, "known");
  assert.deepEqual(result.holdings[0]?.tokenIds, ["1", "2"]);
  assert.equal(result.complete, false);
  assert.equal(result.limitation, NFT_DISCOVERY_LIMITATION);
  assert.deepEqual(result.issues, []);
});

test("discoverNfts marks a run complete only when an indexer answered", async () => {
  const indexer: NftIndexer = {
    name: "test-indexer",
    listContracts: async () => [A],
  };
  const stub = stubLcd(() => ({ tokens: ["1"] }));
  const result = await discoverNfts(ctxOf(stub), OWNER, { indexer });

  assert.equal(result.complete, true);
  assert.equal(result.limitation, null);
  assert.deepEqual(result.sources, ["indexer"]);
});

test("discoverNfts records an indexer failure instead of hiding it", async () => {
  const indexer: NftIndexer = {
    name: "test-indexer",
    listContracts: async () => {
      throw new Error("503 from the index");
    },
  };
  const stub = stubLcd(() => ({ tokens: ["1"] }));
  const result = await discoverNfts(ctxOf(stub), OWNER, { indexer, knownContracts: [A] });

  assert.equal(result.complete, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.contractAddress, null);
  assert.match(result.issues[0]?.message ?? "", /test-indexer.*503/);
  // The known-contract path still ran.
  assert.equal(result.holdings.length, 1);
});

test("discoverNfts records a per-contract failure and keeps going", async () => {
  const stub = stubLcd((call) => {
    if (call.contract === A) {
      throw new InterchainError("contract-error", "not a cw721");
    }
    return { tokens: ["9"] };
  });
  const result = await discoverNfts(ctxOf(stub), OWNER, { knownContracts: [A, B] });

  assert.equal(result.holdings.length, 1);
  assert.equal(result.holdings[0]?.contractAddress, B);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.contractAddress, A);
});

test("discoverNfts always probes a user-supplied contract, cap or not", async () => {
  const stub = stubLcd((call) => ({ tokens: call.contract === C ? ["1"] : [] }));
  const result = await discoverNfts(ctxOf(stub), OWNER, {
    knownContracts: [A, B],
    userContracts: [C],
    maxContracts: 1,
  });

  const probed = stub.calls.map((call) => call.contract);
  assert.deepEqual(probed, [A, C]);
  assert.equal(result.holdings[0]?.source, "user");
});

test("discoverNfts labels a contract the user re-added as theirs", async () => {
  const stub = stubLcd(() => ({ tokens: ["1"] }));
  const result = await discoverNfts(ctxOf(stub), OWNER, {
    knownContracts: [A],
    userContracts: [A],
  });
  assert.equal(stub.calls.length, 1, "the same address must not be probed twice");
  assert.equal(result.holdings[0]?.source, "user");
});

test("discoverNfts refuses a chain without cosmwasm", async () => {
  const stub = stubLcd(() => ({ tokens: [] }));
  await expectRejects(
    discoverNfts(ctxOf(stub, NO_WASM), OWNER, { knownContracts: [A] }),
    "unsupported-chain",
  );
  assert.equal(stub.calls.length, 0, "the gate must run before any request");
});

/* -------------------------------------------------------------------------- *
 * Message building
 * -------------------------------------------------------------------------- */

test("buildExecuteContractMsg matches zunia-core's ExecuteContract fields", () => {
  const built = buildExecuteContractMsg({
    sender: OWNER,
    contract: COLLECTION,
    msg: { do_thing: {} },
    funds: [{ denom: "usafro", amount: "10" }],
  });
  assert.equal(built.typeUrl, "/cosmwasm.wasm.v1.MsgExecuteContract");
  assert.deepEqual(Object.keys(built.value).sort(), [
    "contract",
    "funds",
    "msg",
    "sender",
  ]);
  assert.equal(built.value.sender, OWNER);
  assert.equal(built.value.contract, COLLECTION);
  assert.deepEqual(built.value.funds, [{ denom: "usafro", amount: "10" }]);
  // proto-JSON encodes a bytes field as standard base64, which is what
  // Msg::ExecuteContract { msg: Vec<u8> } decodes back into.
  assert.equal(built.value.msg, encodeBase64Utf8('{"do_thing":{}}'));
});

test("buildExecuteContractMsg always emits funds, even empty", () => {
  const built = buildExecuteContractMsg({
    sender: OWNER,
    contract: COLLECTION,
    msg: { do_thing: {} },
  });
  assert.deepEqual(built.value.funds, []);
});

test("buildTransferNftMsg produces the spec's transfer_nft", () => {
  const built = buildTransferNftMsg(SAFRO, {
    sender: OWNER,
    collectionAddress: COLLECTION,
    tokenId: "42",
    recipient: RECIPIENT,
  });
  assert.equal(built.value.contract, COLLECTION, "executed against the collection");
  assert.deepEqual(executeMsgOf(built.value), {
    transfer_nft: { recipient: RECIPIENT, token_id: "42" },
  });
});

test("buildTransferNftMsg refuses a chain without cosmwasm and an empty token id", () => {
  expectThrows(
    () =>
      buildTransferNftMsg(NO_WASM, {
        sender: OWNER,
        collectionAddress: COLLECTION,
        tokenId: "1",
        recipient: RECIPIENT,
      }),
    "unsupported-chain",
  );
  expectThrows(
    () =>
      buildTransferNftMsg(SAFRO, {
        sender: OWNER,
        collectionAddress: COLLECTION,
        tokenId: "",
        recipient: RECIPIENT,
      }),
    "contract-error",
  );
});

test("buildSendNftMsg nests base64 twice, exactly once each", () => {
  const built = buildSendNftMsg(SAFRO, {
    sender: OWNER,
    collectionAddress: COLLECTION,
    tokenId: "7",
    contract: BRIDGE,
    msg: { hello: "world" },
  });

  const sendNft = obj(executeMsgOf(built.value).send_nft);
  assert.equal(sendNft.contract, BRIDGE);
  assert.equal(sendNft.token_id, "7");
  // The inner msg is a cosmwasm Binary: base64 of the JSON, nothing else.
  assert.equal(sendNft.msg, encodeBase64Utf8('{"hello":"world"}'));
  assert.deepEqual(JSON.parse(decodeBase64Utf8(String(sendNft.msg))), { hello: "world" });
});

/* -------------------------------------------------------------------------- *
 * ICS721
 * -------------------------------------------------------------------------- */

function ics721Request(overrides: Partial<NftTransferRequest> = {}): NftTransferRequest {
  return {
    chainId: SAFRO.chainId,
    collectionAddress: COLLECTION,
    tokenId: "7",
    sender: OWNER,
    recipient: OSMO_RECIPIENT,
    destChainId: OSMOSIS.chainId,
    channelId: "channel-12",
    bridgeContract: BRIDGE,
    ...overrides,
  };
}

/** The decoded IbcOutgoingMsg inside a built ICS721 transfer. */
function outgoingMsgOf(value: JsonObject): Record<string, unknown> {
  const sendNft = obj(executeMsgOf(value).send_nft);
  return JSON.parse(decodeBase64Utf8(String(sendNft.msg))) as Record<string, unknown>;
}

test("buildIcs721TransferMsg sends the NFT to the bridge with receiver and channel_id", () => {
  const now = 1_700_000_000_000;
  const built = buildIcs721TransferMsg(SAFRO, ics721Request({ timeoutMinutes: 5 }), {
    destChain: OSMOSIS,
    now: () => now,
  });

  const sendNft = obj(executeMsgOf(built.value).send_nft);
  assert.equal(built.value.contract, COLLECTION, "executed on the collection");
  assert.equal(sendNft.contract, BRIDGE, "targeting the ics721 bridge");

  const outgoing = outgoingMsgOf(built.value);
  assert.equal(outgoing.receiver, OSMO_RECIPIENT);
  assert.equal(outgoing.channel_id, "channel-12");
  // Nanoseconds, computed with BigInt so nothing is lost above 2^53.
  assert.deepEqual(outgoing.timeout, { timestamp: "1700000300000000000" });
  assert.equal("memo" in outgoing, false, "an absent memo is omitted, not null");
});

test("buildIcs721TransferMsg defaults the timeout rather than omitting it", () => {
  const now = 1_700_000_000_000;
  const outgoing = outgoingMsgOf(
    buildIcs721TransferMsg(SAFRO, ics721Request(), { now: () => now }).value,
  );
  const expected = String(
    BigInt(now + DEFAULT_ICS721_TIMEOUT_MINUTES * 60_000) * 1_000_000n,
  );
  assert.deepEqual(outgoing.timeout, { timestamp: expected });
});

test("buildIcs721TransferMsg passes a memo through and accepts a timeout override", () => {
  const outgoing = outgoingMsgOf(
    buildIcs721TransferMsg(SAFRO, ics721Request({ memo: "hello" }), {
      timeout: { block: { revision: 1, height: 100 } },
    }).value,
  );
  assert.equal(outgoing.memo, "hello");
  assert.deepEqual(outgoing.timeout, { block: { revision: 1, height: 100 } });
});

test("buildIcs721TransferMsg needs a bridge, a channel and a matching chain", () => {
  expectThrows(
    () => buildIcs721TransferMsg(SAFRO, ics721Request({ bridgeContract: undefined })),
    "unsupported-chain",
  );
  expectThrows(
    () => buildIcs721TransferMsg(SAFRO, ics721Request({ channelId: undefined })),
    "unsupported-chain",
  );
  expectThrows(
    () => buildIcs721TransferMsg(SAFRO, ics721Request({ chainId: "other-1" })),
    "unsupported-chain",
  );
  expectThrows(
    () => buildIcs721TransferMsg(NO_WASM, ics721Request({ chainId: NO_WASM.chainId })),
    "unsupported-chain",
  );
  expectThrows(
    () => buildIcs721TransferMsg(SAFRO, ics721Request({ recipient: "" })),
    "contract-error",
  );
});

test("buildIcs721TransferMsg checks the receiver against the destination, not the source", () => {
  // An osmo1 receiver is correct here and must not be rejected by the source
  // chain's prefix.
  assert.doesNotThrow(() =>
    buildIcs721TransferMsg(SAFRO, ics721Request(), { destChain: OSMOSIS }),
  );
  expectThrows(
    () =>
      buildIcs721TransferMsg(SAFRO, ics721Request({ recipient: RECIPIENT }), {
        destChain: OSMOSIS,
      }),
    "contract-error",
  );
});

test("supportsIcs721 is the host's configuration, not a registry feature", () => {
  assert.equal(supportsIcs721(SAFRO, ics721Request()), true);
  assert.equal(supportsIcs721(SAFRO, ics721Request({ bridgeContract: undefined })), false);
  assert.equal(supportsIcs721(SAFRO, ics721Request({ channelId: undefined })), false);
  assert.equal(supportsIcs721(NO_WASM, ics721Request()), false);
});

test("ics721TransferWarnings always leads with the voucher warning", () => {
  const warnings = ics721TransferWarnings(ics721Request({ timeoutMinutes: 5 }));
  assert.equal(warnings[0], ICS721_VOUCHER_WARNING);
  assert.equal(warnings.length, 1);

  const vague = ics721TransferWarnings(
    ics721Request({ destChainId: undefined, timeoutMinutes: undefined }),
  );
  assert.equal(vague.length, 3);
  assert.match(vague.join(" "), /receiver address was not checked/);
});

test("buildNftTransferMsg picks transfer_nft or ICS721 from destChainId", () => {
  const sameChain = buildNftTransferMsg(SAFRO, {
    chainId: SAFRO.chainId,
    collectionAddress: COLLECTION,
    tokenId: "1",
    sender: OWNER,
    recipient: RECIPIENT,
  });
  assert.ok("transfer_nft" in executeMsgOf(sameChain.value));

  const sameChainExplicit = buildNftTransferMsg(SAFRO, {
    chainId: SAFRO.chainId,
    destChainId: SAFRO.chainId,
    collectionAddress: COLLECTION,
    tokenId: "1",
    sender: OWNER,
    recipient: RECIPIENT,
  });
  assert.ok("transfer_nft" in executeMsgOf(sameChainExplicit.value));

  const crossChain = buildNftTransferMsg(SAFRO, ics721Request(), { destChain: OSMOSIS });
  assert.ok("send_nft" in executeMsgOf(crossChain.value));
});
