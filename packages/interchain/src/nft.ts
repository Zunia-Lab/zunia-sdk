/**
 * CW721 reads, NFT message building, and ICS721 cross-chain transfers.
 *
 * Four rules hold throughout this module:
 *
 * 1. It never signs. `build*Msg` returns a {@link BuiltMsg} that zunia-core
 *    encodes and signs; no key material comes near this file.
 * 2. It never calls `fetch`. Chain reads go through {@link LcdClient}; off-chain
 *    metadata reads go through a caller-supplied {@link NftMetadataFetcher}.
 * 3. It never resolves `token_uri` on its own. That URI usually points at a
 *    third-party host, so loading it tells that host which wallet holds which
 *    NFT, from which IP address. The caller has to opt in by handing in a
 *    fetcher and a gateway list; there is no default transport and no default
 *    gateway on purpose.
 * 4. Everything is gated on the chain declaring the `cosmwasm` feature. A chain
 *    without it gets `unsupported-chain`, not a confusing HTTP error.
 *
 * Query and execute shapes are copied from the cw-nfts `cw721` package as
 * recorded in the verified spec, never derived. Where a shape is *not* in the
 * spec — the ICS721 `IbcOutgoingMsg` timeout, the newer `collection_info`
 * extension object — it is parsed defensively and the comment says so.
 */

import {
  base64ToJson,
  decodeBase64Utf8,
  jsonToBase64,
  jsonToBase64Url,
} from "./base64.js";
import {
  InterchainError,
  isInterchainError,
  type BuiltMsg,
  type ChainInfoLike,
  type Coin,
  type JsonObject,
  type JsonValue,
  type LcdClient,
  type LcdRequestOptions,
  type NftAttribute,
  type NftCollection,
  type NftToken,
  type NftTransferRequest,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

const EXECUTE_CONTRACT_TYPE_URL = "/cosmwasm.wasm.v1.MsgExecuteContract";

/** The registry capability every function in this module requires. */
const COSMWASM_FEATURE = "cosmwasm";

/** Page size the spec's `tokens` example uses. */
export const DEFAULT_TOKEN_PAGE_LIMIT = 30;

/**
 * cw721 clamps `limit` internally, so asking for more just returns fewer and
 * makes the "is there another page?" test unreliable. Clamp on our side too.
 */
const MAX_TOKEN_PAGE_LIMIT = 100;

/** Safety stop for the paginating helpers, so a hostile contract cannot loop us. */
const DEFAULT_MAX_PAGES = 20;

/** Contracts probed per discovery run, unless the caller raises it. */
const DEFAULT_MAX_DISCOVERY_CONTRACTS = 25;

/** Token ids pulled per contract during discovery. */
const DEFAULT_MAX_DISCOVERY_TOKENS = 100;

/**
 * Default ICS721 packet timeout.
 *
 * TODO-VERIFY: cw-ics721's `IbcOutgoingMsg.timeout` is not optional as far as we can tell,
 * so a timeout is always emitted rather than omitted. Ten minutes matches the
 * PFM examples in the spec.
 */
export const DEFAULT_ICS721_TIMEOUT_MINUTES = 10;

/**
 * What the user has to be told before an ICS721 transfer.
 *
 * The destination chain does not receive "the NFT". It mints a debt-voucher
 * NFT backed by the original, which stays escrowed in the bridge contract on
 * the source chain. Marketplaces on the destination may not recognise it, and
 * the only way back is to send the voucher home, which burns it and releases
 * the original.
 */
export const ICS721_VOUCHER_WARNING =
  "The destination chain mints a voucher NFT backed by this one. " +
  "The original stays locked in the bridge contract until the voucher is sent back.";

/**
 * Why an NFT list can never be promised to be complete.
 *
 * Rendered as-is by the clients. CosmWasm has no chain-level "tokens by owner"
 * index: `tokens` is a per-contract query, so a wallet can only ask contracts
 * it already knows about. Saying this in the UI is better than showing an empty
 * list that looks authoritative.
 */
export const NFT_DISCOVERY_LIMITATION =
  "CosmWasm has no chain-wide index of NFTs by owner. This list only covers " +
  "contracts Zunia knows about; add a collection address to check another one.";

/* -------------------------------------------------------------------------- *
 * Small guards
 * -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty strings only: an empty `token_uri` is the same as none. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A non-negative integer, from either a JSON number or a decimal string.
 *
 * uint64 fields are stringified by some LCD gateways and left as numbers by
 * others, and `num_tokens` is the one place we need the value as a number.
 */
function asUint(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** A uint64 kept as a decimal string, so nothing is lost above 2^53. */
function asDecimalString(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

function malformed(chainId: string, what: string, cause?: unknown): InterchainError {
  return new InterchainError("malformed-response", `${chainId}: ${what}`, {
    chainId,
    cause,
  });
}

/** The action name of a CosmWasm message, i.e. its single top-level key. */
function messageAction(message: JsonObject): string {
  return Object.keys(message)[0] ?? "unknown";
}

/* -------------------------------------------------------------------------- *
 * Capability gate
 * -------------------------------------------------------------------------- */

/** How to treat a chain whose registry entry carries no feature list. */
export interface CosmWasmGateOptions {
  /**
   * Treat a chain with no `features` array as CosmWasm-capable.
   *
   * Off by default: absent is not the same as declared, and guessing wrong
   * means firing wasm queries at a chain that cannot answer them. The escape
   * hatch exists because the extension's catalog generator currently drops
   * `features` — a host in that state can opt in knowingly while the generator
   * is fixed.
   */
  readonly allowUnknownFeatures?: boolean;
}

/** True when this chain can serve CW721 queries and executes. */
export function supportsCosmWasm(
  chain: ChainInfoLike,
  options: CosmWasmGateOptions = {},
): boolean {
  const features = chain.features;
  if (features === undefined) return options.allowUnknownFeatures === true;
  return features.includes(COSMWASM_FEATURE);
}

/**
 * Throw unless the chain declares `cosmwasm`.
 *
 * @throws {@link InterchainError} `unsupported-chain`. Not retryable: the chain
 *   needs the feature flag, or the NFT surface needs to be hidden for it.
 */
export function assertCosmWasmChain(
  chain: ChainInfoLike,
  options: CosmWasmGateOptions = {},
): void {
  if (supportsCosmWasm(chain, options)) return;
  const reason =
    chain.features === undefined
      ? "publishes no feature list"
      : `does not declare the "${COSMWASM_FEATURE}" feature`;
  throw new InterchainError(
    "unsupported-chain",
    `${chain.chainId} ${reason}; CW721 is unavailable`,
    { chainId: chain.chainId },
  );
}

/* -------------------------------------------------------------------------- *
 * Addresses
 * -------------------------------------------------------------------------- */

/**
 * True when `address` is a bech32 string under `prefix`.
 *
 * Deliberately a string comparison against `prefix + "1"` rather than a
 * `^[a-z]+1` regex. Safrochain's prefix is `addr_safro`, with an underscore,
 * which a character-class regex rejects; bech32 itself allows any printable
 * ASCII in the human-readable part and separates it with the *last* `1`, so
 * matching the configured prefix plus the separator is both correct and
 * tolerant. No checksum verification here — that belongs in zunia-core, which
 * owns bech32.
 */
export function addressHasPrefix(address: string, prefix: string): boolean {
  if (!address || !prefix) return false;
  return address.startsWith(`${prefix}1`) && address.length > prefix.length + 1;
}

/**
 * Reject an address that is not on `chain`.
 *
 * Sending an NFT to a well-formed address with the wrong prefix loses it, and
 * the mistake is invisible on review, so the check is not optional.
 */
function assertChainAddress(
  chain: ChainInfoLike,
  address: string,
  label: string,
): void {
  if (addressHasPrefix(address, chain.bech32Prefix)) return;
  throw new InterchainError(
    "contract-error",
    `${label} "${address}" is not a ${chain.chainName} address (expected prefix "${chain.bech32Prefix}")`,
    { chainId: chain.chainId },
  );
}

/* -------------------------------------------------------------------------- *
 * Smart queries
 * -------------------------------------------------------------------------- */

/** A chain plus the client that reads it. Every CW721 read takes one. */
export interface NftChainContext {
  readonly chain: ChainInfoLike;
  readonly lcd: LcdClient;
}

/** Per-call options for a CW721 read. */
export interface NftQueryOptions extends LcdRequestOptions, CosmWasmGateOptions {}

/**
 * The LCD path for a CosmWasm smart query.
 *
 * `GET /cosmwasm/wasm/v1/contract/{addr}/smart/{base64url(json)}`. Exported
 * because it is the one piece worth asserting on directly in a test, and
 * because a failing query is much easier to debug when the path can be printed.
 */
export function smartQueryPath(contract: string, query: JsonObject): string {
  const address = contract.trim();
  if (!address) {
    throw new InterchainError(
      "contract-error",
      "Smart query needs a contract address",
    );
  }
  // The address is caller data and lands in a URL path; encode it rather than
  // trusting that it is bech32. A no-op for real addresses.
  return `/cosmwasm/wasm/v1/contract/${encodeURIComponent(address)}/smart/${jsonToBase64Url(query)}`;
}

/**
 * Unwrap the `{ "data": … }` envelope a smart query comes back in.
 *
 * wasmd marshals the contract's reply as raw JSON, so `data` is normally an
 * object. Older nodes and some gateway proxies base64 the bytes instead, so a
 * string is decoded rather than rejected — and if that decode fails, the string
 * is returned as-is, because a contract is allowed to answer with a bare JSON
 * string.
 *
 * @throws {@link InterchainError} `malformed-response` when there is no `data`.
 */
export function unwrapSmartQueryData(body: unknown, chainId: string): unknown {
  if (!isRecord(body) || !("data" in body)) {
    throw malformed(chainId, "smart query response has no data field");
  }
  const data = body.data;
  if (data === null || data === undefined) {
    throw malformed(chainId, "smart query returned empty data");
  }
  if (typeof data === "string") {
    try {
      return base64ToJson(data);
    } catch {
      return data;
    }
  }
  return data;
}

/**
 * Run one CosmWasm smart query and return the contract's reply.
 *
 * No capability gate here — this is the generic primitive, and the CW721
 * wrappers below apply {@link assertCosmWasmChain} before calling it. The chain
 * id comes from `lcd.chainId` rather than a separate parameter, so the two can
 * never disagree.
 *
 * @returns The contract's reply as `unknown`. Narrow it yourself.
 * @throws {@link InterchainError} `contract-error` when the contract rejected
 *   the query, `malformed-response` when the envelope is wrong, or whatever
 *   {@link LcdClient.getJson} throws.
 */
export async function smartQuery(
  lcd: LcdClient,
  contract: string,
  query: JsonObject,
  options: LcdRequestOptions = {},
): Promise<unknown> {
  const path = smartQueryPath(contract, query);
  let body: unknown;
  try {
    body = await lcd.getJson(path, options);
  } catch (error) {
    throw asContractError(error, lcd.chainId, contract, query);
  }
  return unwrapSmartQueryData(body, lcd.chainId);
}

/**
 * Reclassify an LCD failure that is really the contract saying no.
 *
 * wasmd answers an unparseable or unsupported query with HTTP 400 carrying the
 * serde error. `lcd.ts` treats a 400 as fatal and reports `lcd-unreachable`,
 * which would tell the user the network is down when the truth is that this
 * contract does not implement this query. The body text does not survive
 * `lcd.ts`, so the message names the query instead.
 */
function asContractError(
  error: unknown,
  chainId: string,
  contract: string,
  query: JsonObject,
): unknown {
  if (!isInterchainError(error)) return error;
  if (error.code === "aborted" || error.code === "reads-disabled") return error;
  if (error.httpStatus === 400) {
    return new InterchainError(
      "contract-error",
      `${chainId}: ${contract} rejected "${messageAction(query)}" (HTTP 400)`,
      { chainId, httpStatus: 400, cause: error },
    );
  }
  return error;
}

/**
 * True when a failure means "this contract does not answer that query", so a
 * caller may reasonably try a different spelling.
 *
 * A cancelled call and a disabled-reads gate are never retried under another
 * name: the first is the user's decision, the second is a settings prompt.
 * HTTP 500 is included because a few LCD gateways report contract panics that
 * way, which is why the fallback is only ever used to pick between two known
 * query spellings and not to paper over a broken node.
 */
function isQueryUnsupported(error: unknown): boolean {
  if (!isInterchainError(error)) return false;
  if (error.code === "aborted" || error.code === "reads-disabled") return false;
  if (error.code === "contract-error" || error.code === "malformed-response") {
    return true;
  }
  return error.httpStatus === 400 || error.httpStatus === 500;
}

/** Gate, then query. Every CW721 read funnels through here. */
async function cw721Query(
  ctx: NftChainContext,
  contract: string,
  query: JsonObject,
  options: NftQueryOptions,
): Promise<unknown> {
  assertCosmWasmChain(ctx.chain, options);
  return smartQuery(ctx.lcd, contract, query, options);
}

/* -------------------------------------------------------------------------- *
 * Reads: token ids
 * -------------------------------------------------------------------------- */

/** One page of token ids. */
export interface NftTokenIdPage {
  readonly tokenIds: readonly string[];
  /**
   * Pass as `startAfter` to get the next page, or `null` when the contract
   * returned a short page, which means this was the last one.
   */
  readonly nextStartAfter: string | null;
}

/** Options for a single page of token ids. */
export interface NftTokenIdPageOptions extends NftQueryOptions {
  /** Exclusive lower bound; the last id of the previous page. */
  readonly startAfter?: string;
  /** Page size. Clamped to 1…100, because cw721 clamps it anyway. */
  readonly limit?: number;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_TOKEN_PAGE_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_TOKEN_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_TOKEN_PAGE_LIMIT, Math.trunc(limit)));
}

/**
 * Narrow a `{"tokens": [...]}` reply.
 *
 * `tokens` and `all_tokens` share this response shape.
 */
function parseTokenIds(raw: unknown, chainId: string): string[] {
  if (!isRecord(raw)) throw malformed(chainId, "token list is not an object");
  const list = raw.tokens;
  if (!Array.isArray(list)) throw malformed(chainId, "token list has no tokens array");
  const out: string[] = [];
  for (const entry of list) {
    // Numeric token ids are stringified by some contracts and not by others.
    if (typeof entry === "string") out.push(entry);
    else if (typeof entry === "number" && Number.isFinite(entry)) out.push(String(entry));
    // Anything else is not a token id; dropping it beats poisoning the list.
  }
  return out;
}

function pageFrom(tokenIds: string[], limit: number): NftTokenIdPage {
  const last = tokenIds[tokenIds.length - 1];
  return {
    tokenIds,
    nextStartAfter: tokenIds.length >= limit && last !== undefined ? last : null,
  };
}

/**
 * One page of `{"tokens": {"owner", "start_after", "limit"}}`.
 *
 * `start_after` is omitted rather than sent as `null` when there is no cursor;
 * cw721 takes an `Option<String>` so the two are equivalent, and omitting keeps
 * the base64url path shorter.
 */
export async function listOwnedTokenIds(
  ctx: NftChainContext,
  contract: string,
  owner: string,
  options: NftTokenIdPageOptions = {},
): Promise<NftTokenIdPage> {
  const limit = clampLimit(options.limit);
  const query: JsonObject = {
    tokens: {
      owner,
      start_after: options.startAfter,
      limit,
    },
  };
  const raw = await cw721Query(ctx, contract, query, options);
  return pageFrom(parseTokenIds(raw, ctx.lcd.chainId), limit);
}

/** One page of `{"all_tokens": {"start_after", "limit"}}`. */
export async function listAllTokenIds(
  ctx: NftChainContext,
  contract: string,
  options: NftTokenIdPageOptions = {},
): Promise<NftTokenIdPage> {
  const limit = clampLimit(options.limit);
  const query: JsonObject = {
    all_tokens: {
      start_after: options.startAfter,
      limit,
    },
  };
  const raw = await cw721Query(ctx, contract, query, options);
  return pageFrom(parseTokenIds(raw, ctx.lcd.chainId), limit);
}

/** Every token id an owner holds in one collection, subject to a cap. */
export interface NftTokenIdList {
  readonly tokenIds: readonly string[];
  /** True when the cap was hit and more ids exist. Show it; do not hide it. */
  readonly truncated: boolean;
}

/** Options for the paginating helper. */
export interface NftTokenIdListOptions extends NftQueryOptions {
  readonly limit?: number;
  /** Stop after this many ids. Default 100. */
  readonly maxTokens?: number;
  /** Stop after this many requests. Default 20. */
  readonly maxPages?: number;
}

/**
 * Walk `tokens` until the contract runs out, the cap is hit, or the page budget
 * is spent.
 *
 * The page budget is not paranoia: `start_after` is contract-controlled, and a
 * contract that keeps returning full pages of the same id would otherwise loop
 * forever against a public LCD.
 */
export async function listAllOwnedTokenIds(
  ctx: NftChainContext,
  contract: string,
  owner: string,
  options: NftTokenIdListOptions = {},
): Promise<NftTokenIdList> {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_DISCOVERY_TOKENS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const seen = new Set<string>();
  const out: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const result = await listOwnedTokenIds(ctx, contract, owner, {
      ...options,
      startAfter: cursor,
    });
    for (const id of result.tokenIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= maxTokens) return { tokenIds: out, truncated: true };
    }
    if (result.nextStartAfter === null) return { tokenIds: out, truncated: false };
    if (result.nextStartAfter === cursor) {
      // The cursor did not move: the contract is not paginating. Stop rather
      // than spin.
      return { tokenIds: out, truncated: true };
    }
    cursor = result.nextStartAfter;
  }
  return { tokenIds: out, truncated: true };
}

/* -------------------------------------------------------------------------- *
 * Reads: token detail
 * -------------------------------------------------------------------------- */

/**
 * `{"nft_info": {...}}` — the on-chain half of a token.
 *
 * `extension` is whatever the contract chose to store; cw721-metadata-onchain
 * puts the standard metadata object there, others put `null`.
 */
export interface NftInfoResponse {
  readonly tokenUri: string | null;
  /** Parsed from `extension`. All-null when the contract stores nothing. */
  readonly metadata: NftMetadata;
}

/** One entry of `owner_of.approvals`. */
export interface NftApproval {
  readonly spender: string;
  /** `expires.at_height`, as a decimal string. */
  readonly expiresAtHeight: string | null;
  /** `expires.at_time`, in nanoseconds, as a decimal string. */
  readonly expiresAtTimeNanos: string | null;
  /** True only for an explicit `{"never":{}}`. */
  readonly neverExpires: boolean;
}

/** `{"owner_of": {...}}`. */
export interface NftOwnership {
  readonly owner: string;
  readonly approvals: readonly NftApproval[];
}

/** `{"all_nft_info": {...}}`: ownership and info in one round trip. */
export interface NftAllInfoResponse {
  readonly access: NftOwnership;
  readonly info: NftInfoResponse;
}

/**
 * Parse a cw_utils `Expiration`.
 *
 * The variant shapes (`at_height`, `at_time`, `never`) are not in the verified
 * spec, so an unrecognised variant yields nulls instead of an error: an
 * approval we cannot describe is not a reason to fail an ownership read.
 */
function parseApproval(raw: unknown): NftApproval | null {
  if (!isRecord(raw)) return null;
  const spender = asString(raw.spender);
  if (spender === null) return null;
  const expires = isRecord(raw.expires) ? raw.expires : null;
  return {
    spender,
    expiresAtHeight: expires ? asDecimalString(expires.at_height) : null,
    expiresAtTimeNanos: expires ? asDecimalString(expires.at_time) : null,
    neverExpires: expires !== null && isRecord(expires.never),
  };
}

function parseOwnership(raw: unknown, chainId: string): NftOwnership {
  if (!isRecord(raw)) throw malformed(chainId, "owner_of is not an object");
  const owner = asString(raw.owner);
  if (owner === null) throw malformed(chainId, "owner_of has no owner");
  const approvals: NftApproval[] = [];
  if (Array.isArray(raw.approvals)) {
    for (const entry of raw.approvals) {
      const parsed = parseApproval(entry);
      if (parsed !== null) approvals.push(parsed);
    }
  }
  return { owner, approvals };
}

function parseNftInfo(raw: unknown, chainId: string): NftInfoResponse {
  if (!isRecord(raw)) throw malformed(chainId, "nft_info is not an object");
  return {
    tokenUri: asString(raw.token_uri),
    metadata: parseNftMetadata(raw.extension),
  };
}

/** `{"nft_info": {"token_id": …}}`. */
export async function getNftInfo(
  ctx: NftChainContext,
  contract: string,
  tokenId: string,
  options: NftQueryOptions = {},
): Promise<NftInfoResponse> {
  const raw = await cw721Query(ctx, contract, { nft_info: { token_id: tokenId } }, options);
  return parseNftInfo(raw, ctx.lcd.chainId);
}

/** `{"owner_of": {"token_id": …, "include_expired": …}}`. */
export async function getOwnerOf(
  ctx: NftChainContext,
  contract: string,
  tokenId: string,
  options: NftQueryOptions & { readonly includeExpired?: boolean } = {},
): Promise<NftOwnership> {
  const query: JsonObject = {
    owner_of: {
      token_id: tokenId,
      include_expired: options.includeExpired,
    },
  };
  const raw = await cw721Query(ctx, contract, query, options);
  return parseOwnership(raw, ctx.lcd.chainId);
}

/** `{"all_nft_info": {"token_id": …}}`. One call instead of two. */
export async function getAllNftInfo(
  ctx: NftChainContext,
  contract: string,
  tokenId: string,
  options: NftQueryOptions & { readonly includeExpired?: boolean } = {},
): Promise<NftAllInfoResponse> {
  const query: JsonObject = {
    all_nft_info: {
      token_id: tokenId,
      include_expired: options.includeExpired,
    },
  };
  const raw = await cw721Query(ctx, contract, query, options);
  if (!isRecord(raw)) throw malformed(ctx.lcd.chainId, "all_nft_info is not an object");
  return {
    access: parseOwnership(raw.access, ctx.lcd.chainId),
    info: parseNftInfo(raw.info, ctx.lcd.chainId),
  };
}

/**
 * `{"num_tokens": {}}`.
 *
 * @throws {@link InterchainError} `malformed-response` when the reply has no
 *   usable `count`. Callers that only want a nice-to-have number should catch.
 */
export async function getNumTokens(
  ctx: NftChainContext,
  contract: string,
  options: NftQueryOptions = {},
): Promise<number> {
  const raw = await cw721Query(ctx, contract, { num_tokens: {} }, options);
  const count = isRecord(raw) ? asUint(raw.count) : null;
  if (count === null) throw malformed(ctx.lcd.chainId, "num_tokens has no count");
  return count;
}

/**
 * Build a {@link NftToken} from one `all_nft_info` call.
 *
 * Metadata comes from the on-chain `extension` only. `tokenUri` is returned
 * untouched; resolving it is a separate, opt-in step because it leaves the
 * chain. See {@link fetchNftMetadata}.
 */
export async function getNftToken(
  ctx: NftChainContext,
  contract: string,
  tokenId: string,
  options: NftQueryOptions = {},
): Promise<NftToken> {
  const all = await getAllNftInfo(ctx, contract, tokenId, options);
  const meta = all.info.metadata;
  return {
    tokenId,
    name: meta.name,
    description: meta.description,
    imageUri: meta.image,
    animationUri: meta.animationUrl,
    attributes: meta.attributes,
    collectionAddress: contract,
    chainId: ctx.chain.chainId,
    owner: all.access.owner,
    tokenUri: all.info.tokenUri,
  };
}

/* -------------------------------------------------------------------------- *
 * Reads: collection
 * -------------------------------------------------------------------------- */

/** Options for {@link getCollectionInfo}. */
export interface CollectionInfoOptions extends NftQueryOptions {
  /**
   * Also query `num_tokens`. Default true; a failure leaves `tokenCount` null
   * rather than failing the whole read.
   */
  readonly includeTokenCount?: boolean;
}

/**
 * Collection metadata, trying both query spellings.
 *
 * cw721 v0.19 answers `collection_info`; everything older answers
 * `contract_info`, and Stargaze's sg721 answers `collection_info` with a
 * different payload again. There is no way to tell from the outside which one a
 * contract implements, so both are tried in that order and the first that
 * answers wins.
 *
 * Only `name` and `symbol` are in the verified spec. `description`, `image` and
 * `creator` are read from the top level *and* from an `extension` object,
 * because the newer response nests them; both are best-effort and null when
 * absent.
 *
 * @throws {@link InterchainError} `contract-error` when neither spelling works.
 */
export async function getCollectionInfo(
  ctx: NftChainContext,
  contract: string,
  options: CollectionInfoOptions = {},
): Promise<NftCollection> {
  assertCosmWasmChain(ctx.chain, options);

  const spellings: readonly JsonObject[] = [
    { collection_info: {} },
    { contract_info: {} },
  ];

  let raw: unknown;
  let answered = false;
  let lastError: unknown;
  for (const query of spellings) {
    try {
      raw = await smartQuery(ctx.lcd, contract, query, options);
      answered = true;
      break;
    } catch (error) {
      if (!isQueryUnsupported(error)) throw error;
      lastError = error;
    }
  }
  if (!answered) {
    throw new InterchainError(
      "contract-error",
      `${ctx.chain.chainId}: ${contract} answered neither collection_info nor contract_info`,
      { chainId: ctx.chain.chainId, cause: lastError },
    );
  }

  let tokenCount: number | null = null;
  if (options.includeTokenCount !== false) {
    try {
      tokenCount = await getNumTokens(ctx, contract, options);
    } catch (error) {
      // Documented as null when the contract does not answer it. A cancelled
      // call is the user's decision and must not be swallowed.
      if (isInterchainError(error) && error.code === "aborted") throw error;
      tokenCount = null;
    }
  }

  return parseCollectionInfo(raw, ctx.chain.chainId, contract, tokenCount);
}

function parseCollectionInfo(
  raw: unknown,
  chainId: string,
  contract: string,
  tokenCount: number | null,
): NftCollection {
  if (!isRecord(raw)) throw malformed(chainId, "collection info is not an object");
  const extension = isRecord(raw.extension) ? raw.extension : {};
  const pick = (...keys: readonly string[]): string | null => {
    for (const key of keys) {
      const hit = asString(raw[key]) ?? asString(extension[key]);
      if (hit !== null) return hit;
    }
    return null;
  };
  return {
    chainId,
    contractAddress: contract,
    name: pick("name"),
    symbol: pick("symbol"),
    description: pick("description"),
    imageUri: pick("image", "image_url", "image_uri"),
    tokenCount,
    creator: pick("creator"),
  };
}

/* -------------------------------------------------------------------------- *
 * Metadata
 * -------------------------------------------------------------------------- */

/**
 * The standard NFT metadata document.
 *
 * Same shape whether it came from the on-chain `extension` or from a fetched
 * `token_uri`. Every field is optional upstream, so every field is nullable
 * here; nothing is invented to fill a gap.
 */
export interface NftMetadata {
  readonly name: string | null;
  readonly description: string | null;
  /** `image`. May itself be an `ipfs://` URI. */
  readonly image: string | null;
  /** `animation_url`. */
  readonly animationUrl: string | null;
  /**
   * `external_url`. Not in the verified spec, but part of the same
   * cw721-metadata-onchain struct; null whenever it is absent.
   */
  readonly externalUrl: string | null;
  readonly attributes: readonly NftAttribute[];
}

const EMPTY_METADATA: NftMetadata = {
  name: null,
  description: null,
  image: null,
  animationUrl: null,
  externalUrl: null,
  attributes: [],
};

/**
 * Coerce one attribute value to a string.
 *
 * The extension is free-form: numbers, booleans and nested objects all occur.
 * Coercing keeps the trait visible in the UI, which is better than silently
 * dropping a trait because its value was a number.
 */
function attributeValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

function parseAttributes(raw: unknown): NftAttribute[] {
  if (!Array.isArray(raw)) return [];
  const out: NftAttribute[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const value = attributeValue(entry.value);
    if (value === null) continue;
    out.push({
      // A trait with no `trait_type` still carries a value worth showing.
      traitType: asString(entry.trait_type) ?? "",
      value,
      displayType: asString(entry.display_type),
    });
  }
  return out;
}

/**
 * Parse a metadata document from anywhere: the on-chain `extension`, a fetched
 * `token_uri` body, or a `data:` URI payload.
 *
 * Never throws. Anything that is not an object becomes {@link EMPTY_METADATA},
 * because a broken metadata document must not take a token off the screen.
 */
export function parseNftMetadata(raw: unknown): NftMetadata {
  if (!isRecord(raw)) return EMPTY_METADATA;
  return {
    name: asString(raw.name),
    description: asString(raw.description),
    image: asString(raw.image),
    animationUrl: asString(raw.animation_url),
    externalUrl: asString(raw.external_url),
    attributes: parseAttributes(raw.attributes),
  };
}

/**
 * Fill the null fields of a token from a metadata document.
 *
 * On-chain values win: the `extension` is signed into chain state, a fetched
 * document is whatever a host served this second.
 */
export function applyNftMetadata(token: NftToken, metadata: NftMetadata): NftToken {
  return {
    ...token,
    name: token.name ?? metadata.name,
    description: token.description ?? metadata.description,
    imageUri: token.imageUri ?? metadata.image,
    animationUri: token.animationUri ?? metadata.animationUrl,
    attributes: token.attributes.length > 0 ? token.attributes : metadata.attributes,
  };
}

/** Where a `token_uri` can be read from, after resolution. */
export interface ResolveTokenUriOptions {
  /**
   * IPFS gateway bases, tried in order, e.g. `["https://ipfs.io/ipfs/"]`.
   *
   * Required for `ipfs://` to resolve at all. There is no default: a hardcoded
   * gateway would send every user's NFT holdings to one operator, and hosts
   * differ on which gateway they trust.
   */
  readonly ipfsGateways?: readonly string[];
  /** Arweave gateway bases for `ar://`, same rules. */
  readonly arweaveGateways?: readonly string[];
  /**
   * Allow plain `http://`. Off by default: it is cleartext and downgradeable,
   * and a wallet should not quietly make one.
   */
  readonly allowInsecureHttp?: boolean;
}

/** The outcome of resolving a `token_uri`. */
export interface ResolvedTokenUri {
  /**
   * - `http` — {@link urls} can be fetched, in order.
   * - `inline` — {@link inline} already holds the document; nothing leaves the device.
   * - `unsupported` — nothing can be done; {@link reason} says why.
   */
  readonly kind: "http" | "inline" | "unsupported";
  readonly urls: readonly string[];
  /** Decoded `data:` payload. */
  readonly inline: string | null;
  /** Developer-facing explanation when {@link kind} is `unsupported`. */
  readonly reason: string | null;
}

function joinGateway(base: string, suffix: string): string {
  const left = base.endsWith("/") ? base.slice(0, -1) : base;
  // encodeURI, not encodeURIComponent: the suffix is `CID/path/1.json` and the
  // slashes have to survive.
  return `${left}/${encodeURI(suffix)}`;
}

/**
 * Decode a `data:` URI.
 *
 * `data:[<mediatype>][;base64],<data>`. Returns null when the URI is malformed
 * rather than throwing: a bad `token_uri` is the contract's problem, not a
 * reason to fail the read.
 */
function decodeDataUri(uri: string): string | null {
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  const header = uri.slice("data:".length, comma);
  const payload = uri.slice(comma + 1);
  try {
    if (/;\s*base64\s*$/i.test(header)) return decodeBase64Utf8(payload);
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/**
 * Turn a `token_uri` into something that can be read.
 *
 * Handles `ipfs://`, `ipns://`, `ar://`, `https://`, `http://` (opt-in) and
 * TODO-VERIFY: a bare CIDv0/CIDv1 with no scheme is treated as IPFS — a heuristic,
 * not a spec rule, but several contracts store exactly that and the alternative
 * is showing the user nothing.
 *
 * This function performs no I/O.
 */
export function resolveTokenUri(
  uri: string,
  options: ResolveTokenUriOptions = {},
): ResolvedTokenUri {
  const trimmed = uri.trim();
  if (!trimmed) {
    return { kind: "unsupported", urls: [], inline: null, reason: "Empty token_uri" };
  }

  if (trimmed.startsWith("data:")) {
    const inline = decodeDataUri(trimmed);
    if (inline === null) {
      return {
        kind: "unsupported",
        urls: [],
        inline: null,
        reason: "Malformed data: URI",
      };
    }
    return { kind: "inline", urls: [], inline, reason: null };
  }

  if (trimmed.startsWith("https://")) {
    return { kind: "http", urls: [trimmed], inline: null, reason: null };
  }

  if (trimmed.startsWith("http://")) {
    if (options.allowInsecureHttp !== true) {
      return {
        kind: "unsupported",
        urls: [],
        inline: null,
        reason: "Plain http:// is disabled",
      };
    }
    return { kind: "http", urls: [trimmed], inline: null, reason: null };
  }

  const ipfsPath = ipfsSuffix(trimmed);
  if (ipfsPath !== null) {
    const gateways = options.ipfsGateways ?? [];
    if (gateways.length === 0) {
      return {
        kind: "unsupported",
        urls: [],
        inline: null,
        reason: "No IPFS gateway configured",
      };
    }
    return {
      kind: "http",
      urls: gateways.map((base) => joinGateway(base, ipfsPath)),
      inline: null,
      reason: null,
    };
  }

  if (trimmed.startsWith("ar://")) {
    const gateways = options.arweaveGateways ?? [];
    const suffix = trimmed.slice("ar://".length);
    if (gateways.length === 0 || !suffix) {
      return {
        kind: "unsupported",
        urls: [],
        inline: null,
        reason: "No Arweave gateway configured",
      };
    }
    return {
      kind: "http",
      urls: gateways.map((base) => joinGateway(base, suffix)),
      inline: null,
      reason: null,
    };
  }

  return {
    kind: "unsupported",
    urls: [],
    inline: null,
    reason: `Unsupported token_uri scheme: ${trimmed.slice(0, 24)}`,
  };
}

/** CIDv0 (`Qm…`, base58) or CIDv1 (`b…`, base32 lowercase). */
const BARE_CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})(\/.*)?$/;

/**
 * The `<cid>/<path>` part of an IPFS reference, or null when it is not one.
 *
 * `ipfs://ipfs/Qm…` occurs in the wild alongside `ipfs://Qm…`; the duplicated
 * segment is stripped so the gateway does not get `/ipfs/ipfs/Qm…`.
 */
function ipfsSuffix(uri: string): string | null {
  if (uri.startsWith("ipfs://")) {
    const rest = uri.slice("ipfs://".length);
    const stripped = rest.startsWith("ipfs/") ? rest.slice("ipfs/".length) : rest;
    return stripped.length > 0 ? stripped : null;
  }
  if (uri.startsWith("ipns://")) {
    const rest = uri.slice("ipns://".length);
    return rest.length > 0 ? `ipns/${rest}` : null;
  }
  return BARE_CID.test(uri) ? uri : null;
}

/**
 * Reads one URL and returns the parsed JSON body.
 *
 * Supplied by the host, never defaulted to the global `fetch`. That is the
 * opt-in: with no fetcher there is no transport, so metadata cannot leak by
 * accident. The implementation owns the timeout, the redirect policy and the
 * response size limit — a metadata host is untrusted and can serve a gigabyte.
 */
export type NftMetadataFetcher = (
  url: string,
  init: { readonly signal?: AbortSignal },
) => Promise<unknown>;

/** Options for {@link fetchNftMetadata}. */
export interface NftMetadataOptions extends ResolveTokenUriOptions {
  /**
   * The transport. Omit it and only `data:` URIs resolve; anything remote
   * throws `reads-disabled`, which the UI turns into "load metadata?" rather
   * than an error.
   */
  readonly fetch?: NftMetadataFetcher;
  readonly signal?: AbortSignal;
}

/** Where a metadata document came from. */
export interface NftMetadataResult {
  readonly metadata: NftMetadata;
  /** `inline` means nothing left the device. */
  readonly source: "inline" | "remote";
  /** The URL that answered, or null for an inline document. */
  readonly url: string | null;
}

/**
 * Resolve and read a `token_uri`.
 *
 * Privacy: for anything other than a `data:` URI this contacts a third party
 * chosen by the NFT's minter. That host learns the reader's IP and which token
 * they are looking at, and an IPFS gateway learns it for every token in a
 * collection at once. Nothing here happens without the caller passing
 * {@link NftMetadataOptions.fetch}, and hosts should ask the user first.
 *
 * @throws {@link InterchainError} `reads-disabled` when a remote read is needed
 *   and no fetcher was supplied, `unsupported-chain` never, `malformed-response`
 *   when the document is not JSON, `lcd-unreachable` when every candidate URL
 *   failed, `aborted` when the caller cancelled.
 */
export async function fetchNftMetadata(
  tokenUri: string,
  options: NftMetadataOptions = {},
): Promise<NftMetadataResult> {
  const resolved = resolveTokenUri(tokenUri, options);

  if (resolved.kind === "unsupported") {
    throw new InterchainError(
      "malformed-response",
      `Cannot resolve token_uri: ${resolved.reason ?? "unsupported"}`,
    );
  }

  if (resolved.kind === "inline") {
    const text = resolved.inline ?? "";
    try {
      return {
        metadata: parseNftMetadata(JSON.parse(text) as unknown),
        source: "inline",
        url: null,
      };
    } catch (cause) {
      throw new InterchainError(
        "malformed-response",
        "Inline token_uri payload is not JSON",
        { cause },
      );
    }
  }

  const read = options.fetch;
  if (read === undefined) {
    throw new InterchainError(
      "reads-disabled",
      "Off-chain NFT metadata was not loaded: no metadata fetcher was supplied",
    );
  }

  let lastError: unknown;
  for (const url of resolved.urls) {
    if (options.signal?.aborted === true) {
      throw new InterchainError("aborted", "Metadata read cancelled");
    }
    try {
      const body = await read(url, { signal: options.signal });
      return { metadata: parseNftMetadata(body), source: "remote", url };
    } catch (error) {
      if (isInterchainError(error) && error.code === "aborted") throw error;
      lastError = error;
    }
  }

  // `lcd-unreachable` is reused deliberately: the UI copy for it ("can't reach
  // the network, try again") is exactly right here, and adding an NFT-only
  // error code would mean a code with no distinct next action.
  throw new InterchainError(
    "lcd-unreachable",
    `No metadata host answered for ${tokenUri}`,
    { endpoint: resolved.urls[0], cause: lastError },
  );
}

/* -------------------------------------------------------------------------- *
 * Discovery
 * -------------------------------------------------------------------------- */

/**
 * How a contract address got into a discovery run.
 *
 * Surfaced so the UI can say "you added this one" versus "we shipped this one",
 * which matters when a list looks wrong.
 */
export type NftDiscoverySource = "known" | "indexer" | "user";

/**
 * A chain-specific NFT indexer, supplied by the host.
 *
 * The only way to get a genuinely complete list. Implementations talk to
 * whatever that chain has — a Stargaze-style GraphQL API, a subquery node, an
 * in-house service — and this package neither knows nor cares which. It is an
 * interface rather than a URL because those services share no protocol.
 */
export interface NftIndexer {
  /** For logs and for the "source: …" line in the UI. */
  readonly name: string;
  /** CW721 contract addresses on `chainId` where `owner` holds something. */
  listContracts(
    chainId: string,
    owner: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]>;
}

/** One collection an owner holds something in. */
export interface NftHolding {
  readonly contractAddress: string;
  readonly source: NftDiscoverySource;
  readonly tokenIds: readonly string[];
  /** True when the per-contract cap cut the list short. */
  readonly truncated: boolean;
}

/** A contract or indexer that could not be read. Shown, not swallowed. */
export interface NftDiscoveryIssue {
  /** Null for an indexer-level failure. */
  readonly contractAddress: string | null;
  readonly message: string;
}

/** Inputs for {@link discoverNfts}. */
export interface NftDiscoveryOptions extends NftQueryOptions {
  /** Contracts the host ships for this chain. */
  readonly knownContracts?: readonly string[];
  /** Contracts the user typed in. Always probed, even past the cap. */
  readonly userContracts?: readonly string[];
  /** A real index, when the chain has one. */
  readonly indexer?: NftIndexer;
  /** Contracts probed in one run. Default 25. */
  readonly maxContracts?: number;
  /** Token ids pulled per contract. Default 100. */
  readonly maxTokensPerContract?: number;
}

/** What a discovery run found, and what it could not promise. */
export interface NftDiscoveryResult {
  readonly chainId: string;
  readonly owner: string;
  readonly holdings: readonly NftHolding[];
  /** Which of the three paths contributed. */
  readonly sources: readonly NftDiscoverySource[];
  /**
   * True only when an indexer answered without error. Contract-list scanning
   * can never be complete, and a UI that hides that is lying to the user.
   */
  readonly complete: boolean;
  /** {@link NFT_DISCOVERY_LIMITATION}, unless {@link complete}. */
  readonly limitation: string | null;
  readonly issues: readonly NftDiscoveryIssue[];
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function errorMessage(error: unknown): string {
  if (isInterchainError(error)) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Find the NFTs an owner holds on one chain.
 *
 * There are exactly three ways to do this and all three are exposed, because
 * none of them is sufficient on its own:
 *
 * - `knownContracts` — a curated list the host ships. Cheap, always partial.
 * - `indexer` — a chain-specific service. Complete where one exists, which is
 *   for a minority of chains.
 * - `userContracts` — an address the user pasted. The escape hatch that makes
 *   the other two survivable.
 *
 * The reason the caller has to supply all of this is that CosmWasm has no
 * chain-level "tokens by owner" query: `tokens` is per contract, so without a
 * contract address there is nothing to ask. {@link NftDiscoveryResult.complete}
 * and {@link NftDiscoveryResult.limitation} carry that fact to the UI instead of
 * hiding it behind an empty list.
 *
 * Contracts are probed one at a time on purpose: these are public LCD nodes,
 * and a burst of parallel wasm queries is the fastest way to get rate-limited.
 */
export async function discoverNfts(
  ctx: NftChainContext,
  owner: string,
  options: NftDiscoveryOptions = {},
): Promise<NftDiscoveryResult> {
  assertCosmWasmChain(ctx.chain, options);

  const chainId = ctx.chain.chainId;
  const issues: NftDiscoveryIssue[] = [];
  const sources = new Set<NftDiscoverySource>();
  const origin = new Map<string, NftDiscoverySource>();

  let indexed = false;
  if (options.indexer) {
    try {
      const rows = await options.indexer.listContracts(chainId, owner, options.signal);
      for (const address of dedupe(rows)) origin.set(address, "indexer");
      indexed = true;
      sources.add("indexer");
    } catch (error) {
      if (isInterchainError(error) && error.code === "aborted") throw error;
      issues.push({
        contractAddress: null,
        message: `${options.indexer.name}: ${errorMessage(error)}`,
      });
    }
  }

  for (const address of dedupe(options.knownContracts ?? [])) {
    if (!origin.has(address)) origin.set(address, "known");
  }
  // User-supplied last so it wins the label: if the user typed an address we
  // already ship, the UI should still say they asked for it.
  const userContracts = dedupe(options.userContracts ?? []);
  for (const address of userContracts) origin.set(address, "user");

  const maxContracts = options.maxContracts ?? DEFAULT_MAX_DISCOVERY_CONTRACTS;
  const candidates: string[] = [];
  for (const [address, source] of origin) {
    // The user's own addresses are never dropped by the cap: they typed them
    // and expect an answer about that specific contract.
    if (source === "user" || candidates.length < maxContracts) {
      candidates.push(address);
    }
  }

  const holdings: NftHolding[] = [];
  for (const address of candidates) {
    try {
      const list = await listAllOwnedTokenIds(ctx, address, owner, {
        ...options,
        maxTokens: options.maxTokensPerContract ?? DEFAULT_MAX_DISCOVERY_TOKENS,
      });
      if (list.tokenIds.length === 0) continue;
      const source = origin.get(address) ?? "known";
      sources.add(source);
      holdings.push({
        contractAddress: address,
        source,
        tokenIds: list.tokenIds,
        truncated: list.truncated,
      });
    } catch (error) {
      if (isInterchainError(error) && error.code === "aborted") throw error;
      issues.push({ contractAddress: address, message: errorMessage(error) });
    }
  }

  const complete = indexed && issues.length === 0;
  return {
    chainId,
    owner,
    holdings,
    sources: [...sources],
    complete,
    limitation: complete ? null : NFT_DISCOVERY_LIMITATION,
    issues,
  };
}

/* -------------------------------------------------------------------------- *
 * Message building
 * -------------------------------------------------------------------------- */

/** Fields of a `cosmwasm.wasm.v1.MsgExecuteContract`. */
export interface ExecuteContractParams {
  readonly sender: string;
  readonly contract: string;
  /** The ExecuteMsg. Base64-encoded into the message's `msg` field. */
  readonly msg: JsonObject;
  /** Funds sent with the call. Omit for CW721, which takes none. */
  readonly funds?: readonly Coin[];
}

/**
 * Build a `MsgExecuteContract` for zunia-core.
 *
 * The single place this package decides the wire shape, so there is one thing
 * to change if the kernel binding changes.
 *
 * TODO-VERIFY: `msg` is standard base64 of the UTF-8 JSON bytes. That is proto-JSON's
 * encoding for a `bytes` field, and it round-trips exactly into
 * `Msg::ExecuteContract { msg: Vec<u8> }` in `zunia-core/crates/cosmos/src/msg.rs`,
 * which stores the ExecuteMsg as raw JSON bytes and re-parses them for Amino.
 * Passing the object unencoded would produce something neither encoder accepts.
 *
 * `funds` is always present, even empty, because proto3 repeated fields default
 * to `[]` and an absent key reads as "unset" to some decoders.
 *
 * This builds a payload. It does not sign it.
 */
export function buildExecuteContractMsg(params: ExecuteContractParams): BuiltMsg {
  const funds: JsonValue = (params.funds ?? []).map(
    (coin): JsonObject => ({ denom: coin.denom, amount: coin.amount }),
  );
  return {
    typeUrl: EXECUTE_CONTRACT_TYPE_URL,
    value: {
      sender: params.sender,
      contract: params.contract,
      msg: jsonToBase64(params.msg),
      funds,
    },
  };
}

/** A same-chain CW721 `transfer_nft`. */
export interface TransferNftParams {
  readonly sender: string;
  /** The CW721 contract. */
  readonly collectionAddress: string;
  readonly tokenId: string;
  /** New owner, on the same chain. */
  readonly recipient: string;
}

/**
 * `{"transfer_nft": {"recipient": …, "token_id": …}}`.
 *
 * Same-chain only. The recipient is checked against the chain's bech32 prefix
 * because a CW721 transfer to a valid-looking address on the wrong chain is
 * unrecoverable.
 *
 * @throws {@link InterchainError} `unsupported-chain` without `cosmwasm`,
 *   `contract-error` on an empty token id or an address on the wrong chain.
 */
export function buildTransferNftMsg(
  chain: ChainInfoLike,
  params: TransferNftParams,
  options: CosmWasmGateOptions = {},
): BuiltMsg {
  assertCosmWasmChain(chain, options);
  assertChainAddress(chain, params.sender, "Sender");
  assertChainAddress(chain, params.collectionAddress, "Collection address");
  assertChainAddress(chain, params.recipient, "Recipient");
  assertTokenId(chain, params.tokenId);

  return buildExecuteContractMsg({
    sender: params.sender,
    contract: params.collectionAddress,
    msg: {
      transfer_nft: {
        recipient: params.recipient,
        token_id: params.tokenId,
      },
    },
  });
}

/** A CW721 `send_nft`: transfer plus a call on the receiving contract. */
export interface SendNftParams {
  readonly sender: string;
  readonly collectionAddress: string;
  readonly tokenId: string;
  /** The receiving *contract*, which must implement `ReceiveNft`. */
  readonly contract: string;
  /** Handed to the receiving contract. Base64-encoded into `msg`. */
  readonly msg: JsonValue;
}

/**
 * `{"send_nft": {"contract": …, "token_id": …, "msg": "<base64>"}}`.
 *
 * Two levels of base64: the CW721 `msg` field is a `Binary`, so the inner
 * payload is base64-encoded JSON, and then the whole `send_nft` object is
 * base64-encoded again as the `MsgExecuteContract.msg` bytes. Getting either
 * level wrong produces a message the contract rejects at execution, after the
 * user has already signed.
 *
 * @throws {@link InterchainError} `unsupported-chain`, or `contract-error` for
 *   a bad address or empty token id.
 */
export function buildSendNftMsg(
  chain: ChainInfoLike,
  params: SendNftParams,
  options: CosmWasmGateOptions = {},
): BuiltMsg {
  assertCosmWasmChain(chain, options);
  assertChainAddress(chain, params.sender, "Sender");
  assertChainAddress(chain, params.collectionAddress, "Collection address");
  assertChainAddress(chain, params.contract, "Receiving contract");
  assertTokenId(chain, params.tokenId);

  return buildExecuteContractMsg({
    sender: params.sender,
    contract: params.collectionAddress,
    msg: {
      send_nft: {
        contract: params.contract,
        token_id: params.tokenId,
        msg: jsonToBase64(params.msg),
      },
    },
  });
}

function assertTokenId(chain: ChainInfoLike, tokenId: string): void {
  if (tokenId.length > 0) return;
  throw new InterchainError("contract-error", "Token id is required", {
    chainId: chain.chainId,
  });
}

/* -------------------------------------------------------------------------- *
 * ICS721
 * -------------------------------------------------------------------------- */

/** Extra knobs for {@link buildIcs721TransferMsg}. */
export interface Ics721TransferOptions extends CosmWasmGateOptions {
  /**
   * Destination chain, when the host knows it. Used only to check the
   * receiver's bech32 prefix — an ICS721 receiver lives on the *other* chain,
   * so it must not be checked against the source prefix.
   */
  readonly destChain?: ChainInfoLike;
  /**
   * Override the whole `timeout` object.
   *
   * The verified spec only guarantees `receiver` and `channel_id` inside
   * `IbcOutgoingMsg`. The default below follows `cosmwasm_std::IbcTimeout`
   * (`{"timestamp": "<nanoseconds>"}`), which is what cw-ics721 appears to
   * take, but a deployment could differ; this is the escape hatch that avoids
   * needing a new release to find out.
   */
  readonly timeout?: JsonValue;
  /** Injected for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * True when an ICS721 transfer can be built for this request.
 *
 * There is no registry feature for ICS721, so the capability *is* the host's
 * configuration: a bridge contract deployed on this chain and a channel to the
 * destination. Neither may be hardcoded — both are per-deployment data.
 */
export function supportsIcs721(
  chain: ChainInfoLike,
  request: NftTransferRequest,
  options: CosmWasmGateOptions = {},
): boolean {
  if (!supportsCosmWasm(chain, options)) return false;
  return Boolean(request.bridgeContract) && Boolean(request.channelId);
}

/**
 * What the user must be shown before signing an ICS721 transfer.
 *
 * Returned rather than thrown: none of these stop the transfer, they change
 * what the user is agreeing to.
 */
export function ics721TransferWarnings(
  request: NftTransferRequest,
): readonly string[] {
  const warnings: string[] = [ICS721_VOUCHER_WARNING];
  if (request.destChainId === undefined) {
    warnings.push("Destination chain is unknown; the receiver address was not checked.");
  }
  if (request.timeoutMinutes === undefined) {
    warnings.push(
      `Using the default ${DEFAULT_ICS721_TIMEOUT_MINUTES}-minute packet timeout.`,
    );
  }
  return warnings;
}

/**
 * Nanosecond timeout timestamp, `minutes` from now.
 *
 * BigInt because nanoseconds since the epoch passed 2^53 in 1970 + ~104 days;
 * a `number` here would silently lose precision and produce a timeout the chain
 * reads as a different instant.
 */
function timeoutTimestampNanos(minutes: number, now: () => number): string {
  const millis = Math.floor(now()) + Math.round(minutes * 60_000);
  return (BigInt(millis) * 1_000_000n).toString();
}

/**
 * Build the ICS721 cross-chain NFT transfer.
 *
 * This is a CW721 `send_nft` on the collection, targeting the cw-ics721 bridge
 * contract, whose `msg` is a base64 `IbcOutgoingMsg` carrying `receiver` and
 * `channel_id`. The NFT is escrowed by the bridge on this chain; the
 * destination mints a voucher. See {@link ICS721_VOUCHER_WARNING} — hosts should
 * show it before the signing prompt, not after.
 *
 * Only `receiver` and `channel_id` are confirmed by the verified spec. `timeout`
 * is modelled on `cosmwasm_std::IbcTimeout` and always sent, because the field
 * does not appear to be optional in cw-ics721; `memo` is sent only when given,
 * because it does appear to be. Both can be overridden.
 *
 * @throws {@link InterchainError} `unsupported-chain` when the chain lacks
 *   `cosmwasm` or the host configured no bridge/channel, `contract-error` for a
 *   bad address or token id.
 */
export function buildIcs721TransferMsg(
  chain: ChainInfoLike,
  request: NftTransferRequest,
  options: Ics721TransferOptions = {},
): BuiltMsg {
  assertCosmWasmChain(chain, options);

  if (request.chainId !== chain.chainId) {
    throw new InterchainError(
      "unsupported-chain",
      `Request is for ${request.chainId} but the chain given is ${chain.chainId}`,
      { chainId: chain.chainId },
    );
  }
  const bridgeContract = request.bridgeContract;
  if (!bridgeContract) {
    throw new InterchainError(
      "unsupported-chain",
      `No cw-ics721 bridge contract configured for ${chain.chainId}`,
      { chainId: chain.chainId },
    );
  }
  const channelId = request.channelId;
  if (!channelId) {
    throw new InterchainError(
      "unsupported-chain",
      `No ICS721 channel given for ${chain.chainId} → ${request.destChainId ?? "destination"}`,
      { chainId: chain.chainId },
    );
  }
  if (!request.recipient) {
    throw new InterchainError("contract-error", "Recipient is required", {
      chainId: chain.chainId,
    });
  }
  // The receiver is on the destination chain, so it is checked against that
  // chain's prefix when the host knows it, and left alone when it does not.
  if (options.destChain) {
    assertChainAddress(options.destChain, request.recipient, "Recipient");
  }

  const now = options.now ?? (() => Date.now());
  const timeout: JsonValue =
    options.timeout ??
    ({
      timestamp: timeoutTimestampNanos(
        request.timeoutMinutes ?? DEFAULT_ICS721_TIMEOUT_MINUTES,
        now,
      ),
    } satisfies JsonObject);

  const outgoing: JsonObject = {
    receiver: request.recipient,
    channel_id: channelId,
    timeout,
    // Omitted, not null, when absent: cw-ics721 takes an Option<String> and an
    // omitted key deserialises to None.
    memo: request.memo,
  };

  return buildSendNftMsg(
    chain,
    {
      sender: request.sender,
      collectionAddress: request.collectionAddress,
      tokenId: request.tokenId,
      contract: bridgeContract,
      msg: outgoing,
    },
    options,
  );
}

/**
 * Build the right message for an {@link NftTransferRequest}.
 *
 * Same chain (no `destChainId`, or one equal to `chainId`) is a `transfer_nft`;
 * anything else is ICS721. Callers that want the cross-chain warnings should
 * call {@link ics721TransferWarnings} as well — a `BuiltMsg` has nowhere to put
 * them.
 */
export function buildNftTransferMsg(
  chain: ChainInfoLike,
  request: NftTransferRequest,
  options: Ics721TransferOptions = {},
): BuiltMsg {
  const crossChain =
    request.destChainId !== undefined && request.destChainId !== request.chainId;
  if (!crossChain) {
    return buildTransferNftMsg(
      chain,
      {
        sender: request.sender,
        collectionAddress: request.collectionAddress,
        tokenId: request.tokenId,
        recipient: request.recipient,
      },
      options,
    );
  }
  return buildIcs721TransferMsg(chain, request, options);
}
