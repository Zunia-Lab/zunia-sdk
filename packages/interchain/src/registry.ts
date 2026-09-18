/**
 * Chain lookup, bech32 prefix handling, and the route (channel pair) cache.
 *
 * Three things that all need the host's chain list and none of which touch the
 * network:
 *
 * 1. {@link createChainRegistry} adapts a plain array of catalog rows to the
 *    {@link ChainRegistry} interface the feature modules take.
 * 2. The bech32 helpers answer "is this address on this chain?" and "which
 *    chains could this address belong to?".
 * 3. {@link createRouteRegistry} caches channel pairs that discovery found, in
 *    a form each client can persist in its own storage.
 *
 * Nothing here fetches, signs or broadcasts. The route registry in particular
 * is a cache of hints: a stored channel is never a licence to send. Callers
 * re-check the channel on chain before building a transfer, because a channel
 * that was open yesterday can be closed today and a closed channel eats the
 * packet.
 */

import {
  InterchainError,
  type ChainFeature,
  type ChainInfoLike,
  type ChainNetwork,
  type ChainRegistry,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Chain registry
 * -------------------------------------------------------------------------- */

/**
 * A {@link ChainRegistry} plus the conveniences only a concrete list can offer.
 *
 * The base interface is deliberately minimal because hosts may implement it
 * themselves; this handle is what {@link createChainRegistry} returns.
 */
export interface ChainRegistryHandle extends ChainRegistry {
  /** True when {@link ChainRegistry.get} would return a row. */
  has(chainId: string): boolean;
  /**
   * Chains that declare this network.
   *
   * A row with no `network` is in neither list. The shipped catalogs always set
   * it; a hand-added chain may not, and guessing "mainnet" for an unlabelled
   * chain would show testnet funds as if they were real.
   */
  listByNetwork(network: ChainNetwork): readonly ChainInfoLike[];
  /** Shorthand for `listByNetwork("mainnet")`. */
  mainnets(): readonly ChainInfoLike[];
  /** Shorthand for `listByNetwork("testnet")`. */
  testnets(): readonly ChainInfoLike[];
  /**
   * Whether a chain declares a capability.
   *
   * False for an unknown chain and for a chain whose registry row carries no
   * `features` array at all — see {@link featureSupport} when the difference
   * between "declares it cannot" and "never said" matters to the UI.
   */
  supports(chainId: string, feature: ChainFeature): boolean;
  /** Every distinct bech32 prefix in the registry, sorted. */
  prefixes(): readonly string[];
}

/**
 * Whether a chain declares a feature, keeping "never said" distinct from "no".
 *
 * The extension's catalog generator currently drops the registry `features`
 * array, so today almost every row answers `unknown`. A module that needs
 * `cosmwasm` must still refuse on `unknown` — a contract query against a chain
 * with no wasm module fails confusingly — but the UI can word it as "we do not
 * know yet" instead of "not supported".
 */
export type FeatureSupport = "yes" | "no" | "unknown";

const MAINNET: ChainNetwork = "mainnet";
const TESTNET: ChainNetwork = "testnet";

function normalizeFeature(feature: string): string {
  return feature.trim().toLowerCase();
}

/**
 * Whether `chain` declares `feature`.
 *
 * Comparison is case- and whitespace-insensitive: the feature vocabulary is
 * open, so a hand-added chain may well spell it `CosmWasm`.
 */
export function featureSupport(
  chain: ChainInfoLike | undefined,
  feature: ChainFeature,
): FeatureSupport {
  if (!chain) return "unknown";
  const declared = chain.features;
  if (!Array.isArray(declared)) return "unknown";
  const needle = normalizeFeature(feature);
  for (const value of declared) {
    if (typeof value === "string" && normalizeFeature(value) === needle) {
      return "yes";
    }
  }
  return "no";
}

/** True only when the chain positively declares the feature. */
export function chainHasFeature(
  chain: ChainInfoLike | undefined,
  feature: ChainFeature,
): boolean {
  return featureSupport(chain, feature) === "yes";
}

/**
 * Order chains within one bech32 prefix bucket: mainnet first, then by name.
 *
 * Several chains share a prefix (`osmo` covers osmosis-1 and osmo-test-5), and
 * when we can only guess, the mainnet is the better guess to show first.
 */
function comparePreferred(a: ChainInfoLike, b: ChainInfoLike): number {
  const rank = (chain: ChainInfoLike): number =>
    chain.network === MAINNET ? 0 : chain.network === TESTNET ? 2 : 1;
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  const byName = a.chainName.localeCompare(b.chainName);
  if (byName !== 0) return byName;
  return a.chainId.localeCompare(b.chainId);
}

/**
 * Adapt a list of catalog rows to {@link ChainRegistry}.
 *
 * The result is a snapshot: the indexes are built once, so adding a chain means
 * building a new registry. That matches every client — the extension rehydrates
 * user-added chains at context boot, the dashboard reads a JSON bundle, mobile
 * loads its list at startup — and keeps every lookup synchronous, which the
 * routing code depends on.
 *
 * Rows are keyed by `chainId`; when the same id appears twice the last one
 * wins, because the extension appends user-added chains after the generated
 * catalog and expects them to override it. The row keeps the position of its
 * first appearance in {@link ChainRegistry.list}.
 *
 * Rows with no usable `chainId` are dropped rather than throwing: the input is
 * often a JSON bundle, and one bad row should not take the wallet down.
 */
export function createChainRegistry(
  chains: Iterable<ChainInfoLike>,
): ChainRegistryHandle {
  const byId = new Map<string, ChainInfoLike>();
  for (const chain of chains) {
    if (typeof chain !== "object" || chain === null) continue;
    if (typeof chain.chainId !== "string") continue;
    const chainId = chain.chainId.trim();
    if (!chainId) continue;
    // Map.set on an existing key replaces the value and keeps the original
    // insertion position, which is exactly the "last wins, first position"
    // rule documented above.
    byId.set(chainId, chain);
  }

  const all: readonly ChainInfoLike[] = Object.freeze([...byId.values()]);

  const buckets = new Map<string, ChainInfoLike[]>();
  for (const chain of all) {
    if (typeof chain.bech32Prefix !== "string") continue;
    const prefix = chain.bech32Prefix.trim();
    if (!prefix) continue;
    const bucket = buckets.get(prefix);
    if (bucket) bucket.push(chain);
    else buckets.set(prefix, [chain]);
  }
  const byPrefix = new Map<string, readonly ChainInfoLike[]>();
  for (const [prefix, bucket] of buckets) {
    byPrefix.set(prefix, Object.freeze(bucket.sort(comparePreferred)));
  }

  const byNetwork = new Map<ChainNetwork, readonly ChainInfoLike[]>([
    [MAINNET, Object.freeze(all.filter((chain) => chain.network === MAINNET))],
    [TESTNET, Object.freeze(all.filter((chain) => chain.network === TESTNET))],
  ]);

  const prefixList: readonly string[] = Object.freeze([...byPrefix.keys()].sort());
  const empty: readonly ChainInfoLike[] = Object.freeze([]);

  function get(chainId: string): ChainInfoLike | undefined {
    if (typeof chainId !== "string") return undefined;
    return byId.get(chainId.trim());
  }

  return {
    get,
    has: (chainId) => get(chainId) !== undefined,
    list: () => all,
    byPrefix: (prefix) => {
      if (typeof prefix !== "string") return empty;
      // Exact match, never `startsWith`: `addr_safro` is a prefix of
      // `addr_safrovaloper`, and a validator address is not a payment address.
      return byPrefix.get(prefix.trim()) ?? empty;
    },
    listByNetwork: (network) => byNetwork.get(network) ?? empty,
    mainnets: () => byNetwork.get(MAINNET) ?? empty,
    testnets: () => byNetwork.get(TESTNET) ?? empty,
    supports: (chainId, feature) => chainHasFeature(get(chainId), feature),
    prefixes: () => prefixList,
  };
}

/* -------------------------------------------------------------------------- *
 * bech32
 * -------------------------------------------------------------------------- */

/** BIP-173 data alphabet. Excludes `1`, `b`, `i` and `o`. */
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** BIP-173 checksum generator polynomial. */
const BECH32_GENERATOR = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
] as const;

/** BIP-173 caps the human-readable part at 83 characters. */
const MAX_HRP_LENGTH = 83;
/** Six data characters carry the checksum; anything shorter cannot be valid. */
const CHECKSUM_LENGTH = 6;

const CHARSET_INDEX = /* @__PURE__ */ (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < BECH32_CHARSET.length; i++) {
    table[BECH32_CHARSET.charCodeAt(i)] = i;
  }
  return table;
})();

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if (((top >>> i) & 1) !== 0) chk ^= BECH32_GENERATOR[i] ?? 0;
    }
  }
  return chk >>> 0;
}

/** Legal human-readable part: 1-83 printable ASCII characters. */
function isLegalHrp(hrp: string): boolean {
  if (hrp.length === 0 || hrp.length > MAX_HRP_LENGTH) return false;
  for (let i = 0; i < hrp.length; i++) {
    const code = hrp.charCodeAt(i);
    // 33-126 inclusive. Underscore (0x5f) is in range, which is why
    // Safrochain's `addr_safro` is a legal prefix even though it looks wrong.
    if (code < 33 || code > 126) return false;
  }
  return true;
}

/**
 * Split an address into `[hrp, dataChars]` without verifying the checksum.
 *
 * Returns `null` for anything that is not shaped like bech32. Mixed case is
 * rejected outright (BIP-173 forbids it); an all-uppercase address is lowered,
 * because the two spellings are the same address.
 */
function splitBech32(address: string): [string, string] | null {
  const raw = address.trim();
  if (!raw) return null;
  if (/[a-z]/.test(raw) && /[A-Z]/.test(raw)) return null;
  const value = raw.toLowerCase();

  // The separator is the last `1`: `1` is not in the data alphabet, so any
  // later `1` would mean the data part is malformed anyway.
  const separator = value.lastIndexOf("1");
  if (separator < 1) return null;
  const hrp = value.slice(0, separator);
  const data = value.slice(separator + 1);
  if (!isLegalHrp(hrp)) return null;
  if (data.length < CHECKSUM_LENGTH) return null;
  return [hrp, data];
}

/**
 * The bech32 prefix of an address, or `null` when it is not bech32-shaped.
 *
 * Structural only — it does not verify the checksum — because this feeds UI
 * hints ("looks like an Osmosis address") where a cheap answer on a
 * half-corrupted string is more useful than none. Use
 * {@link isValidBech32Address} before acting on an address.
 */
export function bech32PrefixOf(address: string): string | null {
  const parts = splitBech32(address);
  return parts === null ? null : parts[0];
}

/**
 * Full BIP-173 validation: structure plus checksum.
 *
 * What this does not check is the payload length. A Cosmos account address
 * carries 20 bytes and a contract address 32, but that rule belongs to the
 * kernel: zunia-core's `decode_bech32` enforces it before anything is signed,
 * and this package never signs. Re-implementing it here would give us a second
 * place to be wrong.
 *
 * Bech32m (checksum constant `0x2bc830a3`) is deliberately not accepted: no
 * Cosmos chain uses it for addresses, and accepting it would let a
 * segwit-v1-style string pass as a Cosmos address.
 */
export function isValidBech32Address(address: string): boolean {
  const parts = splitBech32(address);
  if (parts === null) return false;
  const [hrp, data] = parts;

  const values: number[] = [];
  for (let i = 0; i < hrp.length; i++) values.push(hrp.charCodeAt(i) >>> 5);
  values.push(0);
  for (let i = 0; i < hrp.length; i++) values.push(hrp.charCodeAt(i) & 31);
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    const index = code < 128 ? (CHARSET_INDEX[code] ?? -1) : -1;
    if (index < 0) return false;
    values.push(index);
  }
  return polymod(values) === 1;
}

/** Why an address failed {@link checkAddress}. `ok` means it did not. */
export type AddressProblem =
  | "ok"
  | "empty"
  | "malformed"
  | "bad-checksum"
  | "wrong-prefix";

/**
 * The result of checking an address against a chain.
 *
 * Structured rather than a message string: unlike the channel checks this
 * package inherits, there is no existing user-facing wording to preserve here,
 * and inventing copy in the engine would make it un-localisable.
 */
export interface AddressCheck {
  readonly ok: boolean;
  readonly problem: AddressProblem;
  /** The prefix we read, or `null` when the address is not bech32-shaped. */
  readonly prefix: string | null;
  /** The prefix the chain expects. */
  readonly expectedPrefix: string;
}

/**
 * Check an address against one chain: bech32 validity plus an exact prefix
 * match.
 *
 * The prefix comparison is `===` on the whole human-readable part. A
 * `startsWith` test would accept `addr_safrovaloper1...` for Safrochain, and a
 * transfer to a validator operator address is unrecoverable.
 */
export function checkAddress(
  address: string,
  chain: ChainInfoLike,
): AddressCheck {
  const expectedPrefix = chain.bech32Prefix;
  const trimmed = typeof address === "string" ? address.trim() : "";
  if (!trimmed) {
    return { ok: false, problem: "empty", prefix: null, expectedPrefix };
  }
  const prefix = bech32PrefixOf(trimmed);
  if (prefix === null) {
    return { ok: false, problem: "malformed", prefix: null, expectedPrefix };
  }
  if (!isValidBech32Address(trimmed)) {
    return { ok: false, problem: "bad-checksum", prefix, expectedPrefix };
  }
  if (prefix !== expectedPrefix) {
    return { ok: false, problem: "wrong-prefix", prefix, expectedPrefix };
  }
  return { ok: true, problem: "ok", prefix, expectedPrefix };
}

/** True when `address` is a valid bech32 address carrying `chain`'s prefix. */
export function isAddressForChain(
  address: string,
  chain: ChainInfoLike,
): boolean {
  return checkAddress(address, chain).ok;
}

/**
 * Chains an address could belong to.
 *
 * Always a list, never a single guess: prefixes are not unique (`osmo` covers
 * osmosis-1 and osmo-test-5, `cosmos` covers the hub and several forks), and a
 * wallet that silently picked one would send to the wrong network. Ordering is
 * the registry's; {@link createChainRegistry} puts mainnets first.
 *
 * The checksum is not required, so this still answers for a mistyped address,
 * which is the case where the user most needs to be told what they pasted.
 * Returns `[]` when the address is not bech32-shaped or no chain uses the
 * prefix.
 */
export function inferChainsFromAddress(
  address: string,
  registry: ChainRegistry,
): readonly ChainInfoLike[] {
  const prefix = bech32PrefixOf(address);
  if (prefix === null) return [];
  return registry.byPrefix(prefix);
}

/* -------------------------------------------------------------------------- *
 * Route registry
 * -------------------------------------------------------------------------- */

/**
 * Where a cached channel pair came from.
 *
 * - `manual` — the user typed it. Outranks everything and is never pruned:
 *   deleting something a user entered by hand is never the right default.
 * - `discovered` — read off chain by channel discovery. Prunable, because it is
 *   a cache of a state that changes.
 * - `seed` — a compiled-in hint (see {@link SEED_CHANNEL_ROUTES}). Ranked last
 *   and always re-verified before use.
 */
export type ChannelRouteSource = "discovered" | "manual" | "seed";

/**
 * One directed channel pair between two chains.
 *
 * Directed: `channelId` lives on `sourceChainId` and `counterpartyChannelId` on
 * `destChainId`, so the reverse direction is a separate record. Transfer-port
 * (ICS20) channels only — an ICS721 channel is identified by its bridge
 * contract as well as its port, and needs its own mapping rather than an
 * overloaded field here.
 */
export interface ChannelRoute {
  readonly sourceChainId: string;
  readonly destChainId: string;
  /** Channel on the source chain, canonical `channel-N`. */
  readonly channelId: string;
  /** Channel on the destination chain; `""` when the pair is not known yet. */
  readonly counterpartyChannelId: string;
  /**
   * `Date.now()` of the last successful on-chain check. `0` means never
   * verified, which is what every {@link SEED_CHANNEL_ROUTES} entry carries.
   */
  readonly verifiedAt: number;
  readonly source: ChannelRouteSource;
}

/** Narrowing filter for {@link RouteRegistry.list}. */
export interface RouteFilter {
  readonly sourceChainId?: string;
  readonly destChainId?: string;
  readonly source?: ChannelRouteSource;
}

/**
 * The persisted form of a {@link RouteRegistry}.
 *
 * Plain JSON on purpose: the extension writes it to `browser.storage`, the
 * dashboard to `localStorage`, mobile to shared preferences, and the Dart
 * mirror parses the same object.
 */
export interface RouteRegistrySnapshot {
  /** Bumped when the row shape changes; older snapshots are then dropped. */
  readonly version: 1;
  readonly routes: readonly ChannelRoute[];
}

/** Construction options for {@link createRouteRegistry}. */
export interface RouteRegistryOptions {
  /** Clock, injected so tests can age entries without waiting. */
  readonly now?: () => number;
}

/**
 * A persistable cache of discovered channel pairs.
 *
 * Deliberately not a router: it answers "which channel did we last see between
 * these two chains?", and the caller re-verifies the answer on chain before
 * building a transfer.
 */
export interface RouteRegistry {
  /** Number of stored routes. */
  readonly size: number;
  /**
   * Store a route, merging with any existing record for the same
   * source/dest/channel triple.
   *
   * @returns the stored record, which may differ from the argument: a merge
   *   keeps the stronger {@link ChannelRoute.source} and the newer
   *   `verifiedAt`.
   * @throws {@link InterchainError} `invalid-request` when the route is
   *   unusable (blank chain ids, a source equal to the destination, or a
   *   channel id that is not `channel-N`). Parse untrusted input with
   *   {@link parseChannelRoute}, which returns `null` instead, or use
   *   {@link putMany}, which skips.
   */
  put(route: ChannelRoute): ChannelRoute;
  /** {@link put} for many routes, skipping unusable ones. Returns how many were stored. */
  putMany(routes: Iterable<ChannelRoute>): number;
  /** The best known route for a direction, or `undefined`. */
  get(sourceChainId: string, destChainId: string): ChannelRoute | undefined;
  /** Every known route for a direction, best first. */
  getAll(sourceChainId: string, destChainId: string): readonly ChannelRoute[];
  /** Every stored route, optionally filtered. Order is stable. */
  list(filter?: RouteFilter): readonly ChannelRoute[];
  /** Drop one record. Returns whether anything was removed. */
  remove(sourceChainId: string, destChainId: string, channelId: string): boolean;
  /**
   * Drop stale `discovered` records.
   *
   * `manual` records are never pruned — the user entered them. `seed` records
   * are not pruned either: they are compile-time constants that cost nothing to
   * keep and would reappear on the next boot, so expiring them only churns
   * storage.
   *
   * @returns the records that were removed.
   * @throws {@link InterchainError} `invalid-request` when `maxAgeMs` is
   *   negative or not finite.
   */
  prune(maxAgeMs: number): readonly ChannelRoute[];
  /** Forget everything. */
  clear(): void;
  /** The persistable snapshot. Named so `JSON.stringify(registry)` works. */
  toJSON(): RouteRegistrySnapshot;
}

/** Rank by trustworthiness. Higher wins. */
const SOURCE_RANK: Readonly<Record<ChannelRouteSource, number>> = {
  manual: 2,
  discovered: 1,
  seed: 0,
};

const CHANNEL_ID_PATTERN = /^channel-\d+$/;

/**
 * Key separator for the source/dest/channel triple.
 *
 * NUL rather than a punctuation character: chain ids come from a JSON registry
 * and a user-added chain could carry almost anything, so a separator that
 * cannot appear in one keeps two different triples from colliding on a key.
 */
const KEY_SEPARATOR = "\u0000";

/**
 * How long a discovered channel stays trusted before it is re-checked.
 *
 * A day: channels change rarely, but re-discovery means walking every channel
 * on the chain, which is several LCD pages, so we do not want it per send.
 */
export const DEFAULT_ROUTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Canonicalise a channel id the way all three clients already do, and reject
 * anything that is not a channel id.
 *
 * Kept private: the channels module owns the exported `normalizeChannelId`, and
 * two exports of the same name would collide in the package index. Unlike that
 * one, this returns `""` for an unrecognised form — storing `"my-channel"` in
 * the cache only buys a failed transfer later.
 */
function toChannelId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim().toLowerCase();
  if (!value) return "";
  if (CHANNEL_ID_PATTERN.test(value)) return value;
  if (/^\d+$/.test(value)) return `channel-${value}`;
  return "";
}

function toChainId(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function toSource(raw: unknown): ChannelRouteSource {
  if (raw === "manual" || raw === "discovered" || raw === "seed") return raw;
  // Anything else (an older snapshot, a hand-edited storage entry) is treated
  // as discovered: the weakest source that is still prunable, so a corrupted
  // value can never masquerade as something the user entered.
  return "discovered";
}

function toVerifiedAt(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

function routeKey(
  sourceChainId: string,
  destChainId: string,
  channelId: string,
): string {
  return [sourceChainId, destChainId, channelId].join(KEY_SEPARATOR);
}

/**
 * Normalise a route, or `null` when it cannot be used.
 *
 * Tolerant by design: it takes `unknown` so a snapshot read back from storage,
 * possibly written by an older build, can be filtered row by row instead of
 * failing as a whole and losing every cached channel.
 */
export function parseChannelRoute(value: unknown): ChannelRoute | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;

  const sourceChainId = toChainId(row.sourceChainId);
  const destChainId = toChainId(row.destChainId);
  const channelId = toChannelId(row.channelId);
  if (!sourceChainId || !destChainId || !channelId) return null;
  // A route to itself is not a route; storing one would make the router offer
  // an IBC hop for a local send.
  if (sourceChainId === destChainId) return null;

  return {
    sourceChainId,
    destChainId,
    channelId,
    // The counterparty channel is genuinely optional: discovery reads it from
    // the channel's `counterparty` object, which some LCDs leave blank.
    counterpartyChannelId: toChannelId(row.counterpartyChannelId),
    verifiedAt: toVerifiedAt(row.verifiedAt),
    source: toSource(row.source),
  };
}

/** Best first: strongest source, then most recently verified, then channel id. */
function compareRoutes(a: ChannelRoute, b: ChannelRoute): number {
  const byRank = SOURCE_RANK[b.source] - SOURCE_RANK[a.source];
  if (byRank !== 0) return byRank;
  if (a.verifiedAt !== b.verifiedAt) return b.verifiedAt - a.verifiedAt;
  return a.channelId.localeCompare(b.channelId, undefined, { numeric: true });
}

/**
 * Merge an incoming route with what is already stored for the same triple.
 *
 * The stronger source wins, so re-discovering a channel the user entered by
 * hand keeps it `manual` and therefore un-prunable, while still refreshing
 * `verifiedAt`. A blank counterparty never overwrites a known one.
 */
function mergeRoutes(
  existing: ChannelRoute | undefined,
  incoming: ChannelRoute,
): ChannelRoute {
  if (!existing) return incoming;
  return {
    sourceChainId: incoming.sourceChainId,
    destChainId: incoming.destChainId,
    channelId: incoming.channelId,
    counterpartyChannelId:
      incoming.counterpartyChannelId || existing.counterpartyChannelId,
    verifiedAt: Math.max(existing.verifiedAt, incoming.verifiedAt),
    source:
      SOURCE_RANK[existing.source] >= SOURCE_RANK[incoming.source]
        ? existing.source
        : incoming.source,
  };
}

/**
 * Create a route cache, optionally pre-filled.
 *
 * Pass {@link SEED_CHANNEL_ROUTES} to start from the compiled-in hints, or a
 * snapshot's `routes` to restore what was persisted:
 *
 * ```ts
 * const routes = createRouteRegistry([...SEED_CHANNEL_ROUTES, ...restored]);
 * ```
 *
 * Invalid rows in `initial` are dropped, not thrown on, for the same reason
 * {@link parseChannelRoute} is tolerant.
 */
export function createRouteRegistry(
  initial: Iterable<ChannelRoute> = [],
  options: RouteRegistryOptions = {},
): RouteRegistry {
  const now = options.now ?? ((): number => Date.now());
  const rows = new Map<string, ChannelRoute>();

  function store(route: ChannelRoute): ChannelRoute {
    const key = routeKey(route.sourceChainId, route.destChainId, route.channelId);
    const merged = mergeRoutes(rows.get(key), route);
    rows.set(key, merged);
    return merged;
  }

  for (const candidate of initial) {
    const parsed = parseChannelRoute(candidate);
    if (parsed) store(parsed);
  }

  function forDirection(
    sourceChainId: string,
    destChainId: string,
  ): ChannelRoute[] {
    const source = toChainId(sourceChainId);
    const dest = toChainId(destChainId);
    if (!source || !dest) return [];
    const out: ChannelRoute[] = [];
    for (const route of rows.values()) {
      if (route.sourceChainId === source && route.destChainId === dest) {
        out.push(route);
      }
    }
    return out.sort(compareRoutes);
  }

  function sorted(filter?: RouteFilter): ChannelRoute[] {
    const out: ChannelRoute[] = [];
    for (const route of rows.values()) {
      if (filter?.sourceChainId && route.sourceChainId !== filter.sourceChainId) {
        continue;
      }
      if (filter?.destChainId && route.destChainId !== filter.destChainId) {
        continue;
      }
      if (filter?.source && route.source !== filter.source) continue;
      out.push(route);
    }
    // Grouped by direction, best route first inside each group, so a snapshot
    // is stable across writes and a storage diff stays readable.
    return out.sort((a, b) => {
      const bySource = a.sourceChainId.localeCompare(b.sourceChainId);
      if (bySource !== 0) return bySource;
      const byDest = a.destChainId.localeCompare(b.destChainId);
      if (byDest !== 0) return byDest;
      return compareRoutes(a, b);
    });
  }

  return {
    get size(): number {
      return rows.size;
    },

    put(route: ChannelRoute): ChannelRoute {
      const parsed = parseChannelRoute(route);
      if (!parsed) {
        throw new InterchainError(
          "invalid-request",
          "Invalid channel route: need distinct source and destination chain ids and a channel-N id",
        );
      }
      return store(parsed);
    },

    putMany(routes: Iterable<ChannelRoute>): number {
      let stored = 0;
      for (const route of routes) {
        const parsed = parseChannelRoute(route);
        if (!parsed) continue;
        store(parsed);
        stored++;
      }
      return stored;
    },

    get(sourceChainId: string, destChainId: string): ChannelRoute | undefined {
      return forDirection(sourceChainId, destChainId)[0];
    },

    getAll(
      sourceChainId: string,
      destChainId: string,
    ): readonly ChannelRoute[] {
      return forDirection(sourceChainId, destChainId);
    },

    list(filter?: RouteFilter): readonly ChannelRoute[] {
      return sorted(filter);
    },

    remove(
      sourceChainId: string,
      destChainId: string,
      channelId: string,
    ): boolean {
      const source = toChainId(sourceChainId);
      const dest = toChainId(destChainId);
      const channel = toChannelId(channelId);
      if (!source || !dest || !channel) return false;
      return rows.delete(routeKey(source, dest, channel));
    },

    prune(maxAgeMs: number): readonly ChannelRoute[] {
      if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
        throw new InterchainError(
          "invalid-request",
          "prune(maxAgeMs) needs a non-negative finite number",
        );
      }
      const cutoff = now() - maxAgeMs;
      const removed: ChannelRoute[] = [];
      // Deleting from a Map while iterating it is defined behaviour: entries
      // already visited stay visited and the rest are unaffected.
      for (const [key, route] of rows) {
        if (route.source !== "discovered") continue;
        if (route.verifiedAt > cutoff) continue;
        rows.delete(key);
        removed.push(route);
      }
      return removed;
    },

    clear(): void {
      rows.clear();
    },

    toJSON(): RouteRegistrySnapshot {
      return { version: 1, routes: sorted() };
    },
  };
}

/**
 * Rebuild a registry from something read out of storage.
 *
 * Accepts a {@link RouteRegistrySnapshot}, a bare array of routes, or the JSON
 * string of either — each client persists slightly differently and none of them
 * should have to remember which. Unrecognised input yields an empty registry
 * rather than an error: a wallet that cannot parse its channel cache should
 * rediscover, not refuse to start.
 *
 * A snapshot whose `version` is not `1` is discarded, because the row shape it
 * was written with is unknown to this build.
 */
export function deserializeRouteRegistry(
  value: unknown,
  options: RouteRegistryOptions = {},
): RouteRegistry {
  let source: unknown = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      return createRouteRegistry([], options);
    }
  }

  let rows: unknown = source;
  if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    const snapshot = source as Record<string, unknown>;
    if (snapshot.version !== 1) return createRouteRegistry([], options);
    rows = snapshot.routes;
  }
  if (!Array.isArray(rows)) return createRouteRegistry([], options);

  const parsed: ChannelRoute[] = [];
  for (const row of rows) {
    const route = parseChannelRoute(row);
    if (route) parsed.push(route);
  }
  return createRouteRegistry(parsed, options);
}

/**
 * Whether a route was verified recently enough to be believed.
 *
 * A route that was never verified (`verifiedAt === 0`, every seed) is never
 * fresh.
 */
export function isRouteFresh(
  route: ChannelRoute,
  maxAgeMs: number = DEFAULT_ROUTE_MAX_AGE_MS,
  now: number = Date.now(),
): boolean {
  if (route.verifiedAt <= 0) return false;
  return now - route.verifiedAt <= maxAgeMs;
}

/**
 * Whether the caller must re-check this route on chain before using it.
 *
 * True for every seed, whatever its timestamp: a compiled-in hint has never
 * been confirmed against the chain this wallet is actually talking to.
 */
export function routeNeedsVerification(
  route: ChannelRoute,
  maxAgeMs: number = DEFAULT_ROUTE_MAX_AGE_MS,
  now: number = Date.now(),
): boolean {
  if (route.source === "seed") return true;
  return !isRouteFresh(route, maxAgeMs, now);
}

/**
 * Well-known channels, used only as a starting hint.
 *
 * Every entry carries `verifiedAt: 0` and `source: "seed"`, so
 * {@link routeNeedsVerification} always returns true for them: the router looks
 * the channel up on chain before it builds anything. The table exists to skip a
 * full channel walk on the first send, not to be trusted.
 *
 * The bar for a row is that the pair can be stated from a primary source.
 *
 * TODO-VERIFY: add rows here only with a citation. `no seed claims a Safrochain
 * channel` in the tests fails if one is added without one.
 *
 * Deliberately left out:
 *
 * - Safrochain to Osmosis, and Osmosis to Safrochain. Safrochain publishes no
 *   IBC channel data in this workspace's registry fork (zunia-chain-registry
 *   carries chain metadata only), and no channel number for it could be
 *   confirmed. Guessing one would point a transfer at a channel that may not
 *   exist or may lead somewhere else, so there is no Safrochain seed at all.
 *   Discovery finds it at runtime.
 * - Every other pair (Osmosis/Juno, Osmosis/Axelar, Noble routes and the rest)
 *   for the same reason: not verified here, so not shipped.
 *
 * Hosts that have verified their own pairs should pass them in alongside these:
 * `createRouteRegistry([...SEED_CHANNEL_ROUTES, ...myRoutes])`.
 */
export const SEED_CHANNEL_ROUTES: readonly ChannelRoute[] = Object.freeze([
  // The canonical Cosmos Hub / Osmosis transfer pair, and the one channel
  // number the three clients already show as the placeholder in their channel
  // inputs ("channel-141").
  Object.freeze({
    sourceChainId: "cosmoshub-4",
    destChainId: "osmosis-1",
    channelId: "channel-141",
    counterpartyChannelId: "channel-0",
    verifiedAt: 0,
    source: "seed",
  } as const),
  Object.freeze({
    sourceChainId: "osmosis-1",
    destChainId: "cosmoshub-4",
    channelId: "channel-0",
    counterpartyChannelId: "channel-141",
    verifiedAt: 0,
    source: "seed",
  } as const),
]);
