/**
 * Route planning: what a hosted routing API would do, done locally.
 *
 * A route is a single ICS20 transfer the user signs on the source chain, plus a
 * memo that makes every remaining hop happen without another signature. This
 * module decides which channels that transfer uses and what goes in the memo.
 * It produces {@link RoutePlan} data and stops: nothing here encodes a message,
 * derives an address, signs, or broadcasts. Signing stays in zunia-core.
 *
 * The planner is pure with respect to the network. It walks a channel graph the
 * host supplies ({@link ChannelDirectory}) and a {@link ChainRegistry}; the only
 * thing it may await is the injected {@link RouteDenomResolver}, which the host wires
 * to `denom.ts`. That keeps the whole module testable offline and keeps every
 * real network read inside `LcdClient`, where the timeouts and retries live.
 *
 * Two things it deliberately refuses to do:
 *
 * 1. Invent numbers. A route through a pool has no output amount until someone
 *    quotes the pool, so swap candidates carry `quote: null` and
 *    `requiresQuote: true`. Price impact and output amounts belong to `swap.ts`.
 * 2. Hide a broken graph. Channel discovery fails on chains with slow or
 *    partial LCDs. Every hop accepts a manual override, and an override alone
 *    is enough to build a plan even when the directory knows nothing.
 */

import {
  ibcDenomHashHex,
  type DenomResolver as TraceDenomResolver,
} from "./denom.js";
import {
  buildForwardMemoJson,
  buildXcsSwapMemoJson,
  DEFAULT_PFM_RETRIES,
  PFM_INTERMEDIATE_RECEIVER,
  type ForwardHop,
  type XcsFailedDelivery,
  type XcsSlippage,
} from "./memo.js";
import {
  DEFAULT_SLIPPAGE_PERCENT,
  DEFAULT_TWAP_WINDOW_SECONDS,
} from "./swap.js";
import {
  InterchainError,
  TRANSFER_PORT,
  type ChainInfoLike,
  type ChainRegistry,
  type DenomHop,
  type IbcChannelState,
  type JsonObject,
  type JsonValue,
  type LcdClientFactory,
  type LcdRequestOptions,
  type ResolvedDenom,
  type RouteHop,
  type RoutePlan,
  type RouteRequest,
  type SwapQuote,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

/** Hop budget when the caller does not set {@link RouteRequest.maxHops}. */
export const DEFAULT_MAX_HOPS = 3;

/**
 * Hard ceiling on hops, whatever the caller asks for.
 *
 * Each hop is another relayer that has to be alive and another packet that can
 * time out. Past five the expected success rate is not worth offering.
 */
export const MAX_HOPS_CAP = 5;

const DEFAULT_MAX_PATHS = 12;
const DEFAULT_MAX_LINKS_PER_PAIR = 3;
const DEFAULT_MAX_CANDIDATES = 8;
const DEFAULT_TIMEOUT_MINUTES = 10;


/**
 * Score penalty for sending a wrapped token onward instead of unwinding it.
 *
 * Larger than the cost of a hop on purpose. Forwarding `ibc/…ATOM` from Osmosis
 * to Juno works, and leaves the recipient holding a double-wrapped denom that
 * no UI can name and that no pool will trade. Going back through the origin
 * chain costs an extra hop and is almost always the right answer, so the
 * penalty has to outrank one hop while still losing to three.
 */
const MISSED_UNWIND_PENALTY = 120;

/* -------------------------------------------------------------------------- *
 * The channel graph
 * -------------------------------------------------------------------------- */

/**
 * Where a channel came from, which is how much we trust it.
 *
 * - `verified` — confirmed open against the chain's own LCD this session, or
 *   curated and checked by us.
 * - `seed` — shipped in a bundled table. Correct when it was written; channels
 *   do get closed and replaced.
 * - `manual` — the user typed it. Ranked first, because it is an explicit
 *   instruction, and warned about, because nobody checked it.
 */
export type ChannelLinkSource = "verified" | "seed" | "manual";

/**
 * One directed transfer channel: leaving {@link sourceChainId}, arriving on
 * {@link destChainId}.
 *
 * Direction matters. `channel-0` on Osmosis and `channel-0` on the Hub are
 * unrelated, so a link is never reused backwards unless
 * {@link counterpartyChannelId} says what the other end is called.
 */
export interface ChannelLink {
  readonly sourceChainId: string;
  readonly destChainId: string;
  /** Channel id on {@link sourceChainId}, e.g. `channel-141`. */
  readonly channelId: string;
  /** Port on {@link sourceChainId}. Defaults to `transfer`. */
  readonly port?: string;
  /**
   * Channel id on {@link destChainId}. Optional, but without it the planner
   * cannot compute the denom the recipient ends up holding, because the
   * receiving chain prefixes the trace with its own channel.
   */
  readonly counterpartyChannelId?: string;
  /** Port on {@link destChainId}. Defaults to `transfer`. */
  readonly counterpartyPortId?: string;
  /** Provenance. Defaults to `seed`. */
  readonly source?: ChannelLinkSource;
  /** Handshake state, when known. Defaults to `unknown`; `closed` is skipped. */
  readonly state?: IbcChannelState;
  /** True when this link was derived by reversing another. */
  readonly derived?: boolean;
}

/**
 * The host's view of which chains are connected.
 *
 * Only one method, so a host can implement it over a bundled table, over
 * channel discovery results, or over both. The planner calls it repeatedly
 * during the search and never mutates what it gets back.
 */
export interface ChannelDirectory {
  /** Every known channel leaving `chainId`. May be empty. */
  from(chainId: string): readonly ChannelLink[];
}

/** Options for {@link createChannelDirectory}. */
export interface CreateChannelDirectoryOptions {
  /**
   * Derive the reverse of every link that names its counterparty channel.
   * Default true: a channel end pair is symmetric, and tables are usually
   * written one way round only.
   */
  readonly deriveReverse?: boolean;
}

function linkKey(link: ChannelLink): string {
  return [
    link.sourceChainId,
    link.destChainId,
    link.port ?? TRANSFER_PORT,
    link.channelId,
  ].join("|");
}

function reverseLink(link: ChannelLink): ChannelLink | null {
  const counterparty = link.counterpartyChannelId;
  if (!counterparty) return null;
  return {
    sourceChainId: link.destChainId,
    destChainId: link.sourceChainId,
    channelId: counterparty,
    port: link.counterpartyPortId ?? TRANSFER_PORT,
    counterpartyChannelId: link.channelId,
    counterpartyPortId: link.port ?? TRANSFER_PORT,
    source: link.source ?? "seed",
    state: link.state ?? "unknown",
    derived: true,
  };
}

/**
 * Index a flat list of links into a {@link ChannelDirectory}.
 *
 * Provided so the three clients do not each write the same grouping code. A
 * host with a live discovery cache can implement the interface directly instead.
 *
 * Explicit links win over derived ones with the same key, so a table that
 * states both directions keeps whatever it said about each.
 */
export function createChannelDirectory(
  links: readonly ChannelLink[],
  options: CreateChannelDirectoryOptions = {},
): ChannelDirectory {
  const deriveReverse = options.deriveReverse ?? true;
  const byKey = new Map<string, ChannelLink>();

  for (const link of links) {
    if (!link.sourceChainId || !link.destChainId || !link.channelId) continue;
    byKey.set(linkKey(link), link);
  }
  if (deriveReverse) {
    for (const link of links) {
      const reversed = reverseLink(link);
      if (!reversed) continue;
      const key = linkKey(reversed);
      if (byKey.has(key)) continue;
      byKey.set(key, reversed);
    }
  }

  const byChain = new Map<string, ChannelLink[]>();
  for (const link of byKey.values()) {
    const bucket = byChain.get(link.sourceChainId);
    if (bucket) bucket.push(link);
    else byChain.set(link.sourceChainId, [link]);
  }
  for (const bucket of byChain.values()) bucket.sort(compareLinks);

  return {
    from: (chainId: string): readonly ChannelLink[] => byChain.get(chainId) ?? [],
  };
}

function sourceRank(source: ChannelLinkSource | undefined): number {
  // Manual first: the user said this one. Verified before seed: seed tables go
  // stale and we would rather offer a channel someone has actually looked at.
  if (source === "manual") return 0;
  if (source === "verified") return 1;
  return 2;
}

function stateRank(state: IbcChannelState | undefined): number {
  if (state === "open") return 0;
  if (state === undefined || state === "unknown") return 1;
  return 2;
}

/** Numeric-aware ordering so `channel-9` sorts before `channel-141`. */
function compareChannelIds(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

function compareLinks(a: ChannelLink, b: ChannelLink): number {
  const bySource = sourceRank(a.source) - sourceRank(b.source);
  if (bySource !== 0) return bySource;
  const byState = stateRank(a.state) - stateRank(b.state);
  if (byState !== 0) return byState;
  const byDerived = Number(a.derived ?? false) - Number(b.derived ?? false);
  if (byDerived !== 0) return byDerived;
  const byDest = a.destChainId.localeCompare(b.destChainId);
  if (byDest !== 0) return byDest;
  return compareChannelIds(a.channelId, b.channelId);
}

/* -------------------------------------------------------------------------- *
 * Path finding
 * -------------------------------------------------------------------------- */

/** A chain sequence and the channels that join it. */
export interface RoutePath {
  /** Chains visited, source first, destination last. Always `links.length + 1`. */
  readonly chainIds: readonly string[];
  /** Channels in travel order. `links[0]` is the transfer the user signs. */
  readonly links: readonly ChannelLink[];
}

/** Options for {@link findRoutePaths}. */
export interface FindRoutePathsOptions {
  /** Maximum channels in a path. Clamped to 1…{@link MAX_HOPS_CAP}. Default 3. */
  readonly maxHops?: number;
  /** Stop after this many complete paths. Default 12. */
  readonly maxPaths?: number;
  /**
   * Keep at most this many channels per chain pair. Default 3.
   *
   * Busy pairs have a dozen historical channels; expanding all of them turns a
   * three-hop search into thousands of paths for no user-visible benefit.
   */
  readonly maxLinksPerPair?: number;
}

interface PartialPath {
  readonly chainIds: readonly string[];
  readonly links: readonly ChannelLink[];
  readonly visited: ReadonlySet<string>;
}

function clampHops(value: number | undefined, fallback: number): number {
  const raw = value ?? fallback;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(MAX_HOPS_CAP, Math.max(1, Math.floor(raw)));
}

/**
 * Every simple path from one chain to another, shortest first.
 *
 * Breadth-first, so paths come back ordered by hop count with no post-sort.
 * Cycles are impossible: a chain already on the path is never revisited, which
 * also bounds the search on a densely connected graph.
 *
 * Channels whose state is known to be `closed` are dropped. A channel of
 * unknown state is kept — most directories cannot tell us, and refusing to plan
 * over "unknown" would mean refusing to plan at all.
 */
export function findRoutePaths(
  fromChainId: string,
  toChainId: string,
  directory: ChannelDirectory,
  options: FindRoutePathsOptions = {},
): RoutePath[] {
  const maxHops = clampHops(options.maxHops, DEFAULT_MAX_HOPS);
  const maxPaths = Math.max(1, options.maxPaths ?? DEFAULT_MAX_PATHS);
  const maxLinksPerPair = Math.max(
    1,
    options.maxLinksPerPair ?? DEFAULT_MAX_LINKS_PER_PAIR,
  );

  if (!fromChainId || !toChainId || fromChainId === toChainId) return [];

  const found: RoutePath[] = [];
  let frontier: PartialPath[] = [
    { chainIds: [fromChainId], links: [], visited: new Set([fromChainId]) },
  ];

  for (let depth = 0; depth < maxHops && frontier.length > 0; depth++) {
    const next: PartialPath[] = [];
    for (const partial of frontier) {
      const head = partial.chainIds[partial.chainIds.length - 1];
      if (head === undefined) continue;

      const perPair = new Map<string, number>();
      for (const link of directory.from(head)) {
        if (link.state === "closed") continue;
        if (partial.visited.has(link.destChainId)) continue;
        const used = perPair.get(link.destChainId) ?? 0;
        if (used >= maxLinksPerPair) continue;
        perPair.set(link.destChainId, used + 1);

        const chainIds = [...partial.chainIds, link.destChainId];
        const links = [...partial.links, link];
        if (link.destChainId === toChainId) {
          found.push({ chainIds, links });
          if (found.length >= maxPaths) return found;
          // A path that has arrived is complete; do not extend it further.
          continue;
        }
        const visited = new Set(partial.visited);
        visited.add(link.destChainId);
        next.push({ chainIds, links, visited });
      }
    }
    frontier = next;
  }

  return found;
}

/* -------------------------------------------------------------------------- *
 * Manual overrides
 * -------------------------------------------------------------------------- */

/**
 * A channel the user chose by hand.
 *
 * Discovery fails: an LCD is slow, paginates badly, or has no client state for
 * a connection. When that happens the user still knows the channel, and the
 * wallet must let them proceed. An override matching a chain pair is added to
 * the graph before the search, so it can build a route on its own; an override
 * matching {@link hopIndex} replaces whatever the search picked at that
 * position.
 */
export interface RouteHopOverride {
  /** Position in the path to replace, 0-based. Applied after the search. */
  readonly hopIndex?: number;
  /** Chain the hop leaves. With {@link toChainId}, adds an edge to the graph. */
  readonly fromChainId?: string;
  /** Chain the hop arrives on. */
  readonly toChainId?: string;
  /** Channel id on the leaving chain. Required. */
  readonly channelId: string;
  /** Port on the leaving chain. Defaults to `transfer`. */
  readonly port?: string;
  /** Channel id on the arriving chain, if the user knows it. */
  readonly counterpartyChannelId?: string;
}

function overrideToLink(override: RouteHopOverride): ChannelLink | null {
  if (!override.fromChainId || !override.toChainId || !override.channelId) {
    return null;
  }
  return {
    sourceChainId: override.fromChainId,
    destChainId: override.toChainId,
    channelId: override.channelId,
    port: override.port ?? TRANSFER_PORT,
    counterpartyChannelId: override.counterpartyChannelId,
    source: "manual",
    state: "unknown",
  };
}

function matchesOverride(
  override: RouteHopOverride,
  link: ChannelLink,
  index: number,
): boolean {
  if (override.hopIndex !== undefined) return override.hopIndex === index;
  if (override.fromChainId && override.fromChainId !== link.sourceChainId) {
    return false;
  }
  if (override.toChainId && override.toChainId !== link.destChainId) {
    return false;
  }
  return Boolean(override.fromChainId || override.toChainId);
}

function applyOverrides(
  links: readonly ChannelLink[],
  overrides: readonly RouteHopOverride[],
): ChannelLink[] {
  return links.map((link, index) => {
    const hit = overrides.find((o) => matchesOverride(o, link, index));
    if (!hit || hit.channelId === link.channelId) return link;
    return {
      ...link,
      channelId: hit.channelId,
      port: hit.port ?? link.port ?? TRANSFER_PORT,
      // The counterparty of the original channel does not apply to a different
      // channel, so drop it unless the user supplied one. Losing it only costs
      // us the computed destination denom, which we then warn about.
      counterpartyChannelId: hit.counterpartyChannelId,
      source: "manual",
      state: "unknown",
      derived: false,
    };
  });
}

/**
 * Overlay a directory with extra links, without mutating the host's.
 *
 * Used for manual overrides and for the unwind edge, both of which must be
 * searchable even when the host's table has never heard of them.
 */
function withExtraLinks(
  directory: ChannelDirectory,
  extra: readonly ChannelLink[],
): ChannelDirectory {
  if (extra.length === 0) return directory;
  const byChain = new Map<string, ChannelLink[]>();
  for (const link of extra) {
    const bucket = byChain.get(link.sourceChainId);
    if (bucket) bucket.push(link);
    else byChain.set(link.sourceChainId, [link]);
  }
  return {
    from: (chainId: string): readonly ChannelLink[] => {
      const added = byChain.get(chainId);
      if (!added) return directory.from(chainId);
      const base = directory
        .from(chainId)
        .filter(
          (link) =>
            !added.some(
              (a) =>
                a.channelId === link.channelId &&
                (a.port ?? TRANSFER_PORT) === (link.port ?? TRANSFER_PORT),
            ),
        );
      return [...added, ...base].sort(compareLinks);
    },
  };
}

/* -------------------------------------------------------------------------- *
 * Chain capabilities and swap venues
 * -------------------------------------------------------------------------- */

/**
 * Middleware a chain runs.
 *
 * The Keplr-format registry does not publish this — `features` covers
 * `cosmwasm` and little else — so the host supplies it from its own config.
 * Every field is optional and `undefined` means "nobody checked", which the
 * planner reports differently from a known `false`.
 */
export interface ChainCapabilities {
  /** Runs packet-forward-middleware, so it can execute a `forward` memo. */
  readonly pfm?: boolean;
  /** Runs ibc-hooks, so it can execute a `wasm` memo. */
  readonly ibcHooks?: boolean;
  /** Runs CosmWasm. Falls back to the registry's `features` when absent. */
  readonly cosmwasm?: boolean;
}

/** Capability lookup, implemented by the host. Synchronous, like the registry. */
export type ChainCapabilityLookup = (
  chainId: string,
) => ChainCapabilities | undefined;

/**
 * A place a swap can happen.
 *
 * {@link contractAddress} is never hardcoded in this package. The
 * crosschain-swaps addresses that circulate in Osmosis governance and docs are
 * unverified candidates, and a wrong contract address in a memo sends funds to
 * a contract that will not send them back. The host looks the address up,
 * checks it exists on chain, and passes it in.
 */
export interface SwapVenue {
  /** Chain the venue runs on, e.g. `osmosis-1`. */
  readonly chainId: string;
  /**
   * Contract the memo targets: the crosschain-swaps contract for a cross-chain
   * route, or the local router for a same-chain swap.
   */
  readonly contractAddress: string;
  /**
   * Denoms the venue can trade, as held on {@link chainId}. Omit when the host
   * does not have the list; the planner then offers the venue and warns instead
   * of silently ruling it out.
   */
  readonly denoms?: readonly string[];
  /** Display name for UI copy. Defaults to the chain name. */
  readonly label?: string;
}

/* -------------------------------------------------------------------------- *
 * Denom resolution
 * -------------------------------------------------------------------------- */

/** Argument to a {@link RouteDenomResolver}. One object, so it stays adaptable. */
export interface DenomResolverInput {
  /** Chain that holds the denom. */
  readonly chain: ChainInfoLike;
  /** Denom as held there: `uatom` or `ibc/27394F…`. */
  readonly denom: string;
  /** LCD access, for the resolver's own reads. */
  readonly lcd?: LcdClientFactory;
  /** Timeout / cancellation for those reads. */
  readonly request?: LcdRequestOptions;
}

/**
 * Turns a denom into its trace. Wire this to `denom.ts`.
 *
 * Injected rather than imported so the planner has no network dependency of its
 * own and so its tests are pure. When it is absent the planner still works: it
 * treats an `ibc/…` denom as opaque, cannot compute the destination denom, and
 * says so in the warnings.
 */
export type RouteDenomResolver = (
  input: DenomResolverInput,
) => Promise<ResolvedDenom>;

/**
 * Adapt `denom.ts`'s {@link TraceDenomResolver} to the planner's port.
 *
 * The planner declares its own narrow function type so its tests stay offline
 * and so a host with a denom cache of its own can supply that instead. This is
 * the glue for the ordinary case: `createDenomResolver(ctx)` on one side,
 * `planRoute` on the other.
 *
 * The `lcd` and `request` fields of the input are ignored — `denom.ts` already
 * holds its own {@link LcdClientFactory} through its {@link DenomContext} — but
 * the per-call timeout and abort signal are forwarded.
 */
export function routeDenomResolver(
  resolver: TraceDenomResolver,
): RouteDenomResolver {
  return async (input) =>
    resolver.resolveDenom(input.chain.chainId, input.denom, {
      ...(input.request?.signal === undefined
        ? {}
        : { signal: input.request.signal }),
      ...(input.request?.timeoutMs === undefined
        ? {}
        : { timeoutMs: input.request.timeoutMs }),
    });
}

/** Computes the `ibc/…` hash for a trace. Defaults to SHA-256 over `path/base`. */
export type DenomHasher = (
  path: string,
  baseDenom: string,
) => Promise<string | null>;

/** A denom mid-flight: its trace path and the denom it started as. */
interface DenomState {
  readonly path: string;
  readonly baseDenom: string;
}

function splitTracePath(path: string): DenomHop[] {
  const parts = path.split("/").filter((part) => part.length > 0);
  const hops: DenomHop[] = [];
  // Pairs only. An odd tail is a malformed trace; drop it rather than guess,
  // and the caller sees a shorter path than it expected, never a wrong one.
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const port = parts[i];
    const channelId = parts[i + 1];
    if (port === undefined || channelId === undefined) break;
    hops.push({ port, channelId });
  }
  return hops;
}

function joinTracePath(hops: readonly DenomHop[]): string {
  return hops.map((hop) => `${hop.port}/${hop.channelId}`).join("/");
}

/**
 * Move a denom across one channel.
 *
 * Two cases, and getting them the wrong way round is how wallets mint denoms
 * nobody can name:
 *
 * - The trace already starts with this channel, so the token is going back the
 *   way it came. ICS20 unwraps one hop.
 * - Anything else wraps: the receiving chain prefixes the trace with *its own*
 *   port and channel, which is why {@link ChannelLink.counterpartyChannelId}
 *   matters. Without it we return null rather than guess.
 */
function stepDenom(state: DenomState, link: ChannelLink): DenomState | null {
  const port = link.port ?? TRANSFER_PORT;
  const hops = splitTracePath(state.path);
  const first = hops[0];
  if (first && first.port === port && first.channelId === link.channelId) {
    return { path: joinTracePath(hops.slice(1)), baseDenom: state.baseDenom };
  }
  const counterparty = link.counterpartyChannelId;
  if (!counterparty) return null;
  const counterpartyPort = link.counterpartyPortId ?? TRANSFER_PORT;
  return {
    path: joinTracePath([
      { port: counterpartyPort, channelId: counterparty },
      ...hops,
    ]),
    baseDenom: state.baseDenom,
  };
}

function stepDenomAlong(
  state: DenomState | null,
  links: readonly ChannelLink[],
): DenomState | null {
  let current = state;
  for (const link of links) {
    if (!current) return null;
    current = stepDenom(current, link);
  }
  return current;
}

/**
 * `ibc/HASH` is uppercase hex SHA-256 of `path/base_denom`.
 *
 * Delegates to `denom.ts` so the hash has one definition in the package — a
 * planner that computed it differently from the module that reads traces back
 * would name a denom nobody holds.
 *
 * Returns null rather than throwing when the environment has no WebCrypto, so
 * a caller in an odd runtime gets a plan with an unknown output denom and a
 * warning instead of a failed route.
 */
const defaultDenomHasher: DenomHasher = async (path, baseDenom) => {
  try {
    return await ibcDenomHashHex(path, baseDenom);
  } catch {
    return null;
  }
};

async function denomStringFor(
  state: DenomState | null,
  hasher: DenomHasher,
): Promise<string | null> {
  if (!state) return null;
  if (state.path.length === 0) return state.baseDenom;
  const hash = await hasher(state.path, state.baseDenom);
  return hash === null ? null : `ibc/${hash}`;
}

/* -------------------------------------------------------------------------- *
 * Memos
 * -------------------------------------------------------------------------- */

/**
 * Nest a list of forward hops into a packet-forward-middleware memo, or return
 * `tail` unchanged when there is nothing to forward.
 *
 * The nesting, the `"pfm"` sentinel on every hop but the last, and the
 * identifier/timeout/retry validation all live in `memo.ts`; this only handles
 * the zero-hop case, which is a plan with no forwarding rather than an error.
 */
function forwardMemoOrNull(
  hops: readonly ForwardHop[],
  finalReceiver: string,
  timeout: string,
  retries: number,
  tail?: JsonObject,
): JsonObject | null {
  if (hops.length === 0) return tail ?? null;
  return buildForwardMemoJson(hops, finalReceiver, {
    timeout,
    retries,
    ...(tail === undefined ? {} : { next: tail }),
    // The planner's own hop budget already bounded this list, so pin memo.ts's
    // ceiling to the same number rather than leaving it at MAX_FORWARD_HOPS.
    // Tighter of the two wins, and a plan the planner refused to enumerate must
    // not become buildable by going through the memo builder directly.
    maxHops: MAX_HOPS_CAP,
  });
}

/** Slippage in whichever of the two forms crosschain-swaps accepts. */
function planSlippage(
  slippagePercent: number,
  windowSeconds: number,
  minOutputAmount: string | undefined,
): XcsSlippage {
  if (minOutputAmount !== undefined) {
    return { kind: "min_output_amount", minOutputAmount };
  }
  return {
    kind: "twap",
    // A string, not a number: the contract parses a Decimal.
    slippagePercentage: String(slippagePercent),
    windowSeconds,
  };
}

function stringifyMemo(memo: JsonObject | null): string {
  // An empty memo and an absent memo are the same on the wire, so "" is the
  // canonical "no memo".
  return memo === null ? "" : JSON.stringify(memo as JsonValue);
}

/* -------------------------------------------------------------------------- *
 * Plans
 * -------------------------------------------------------------------------- */

/**
 * How a plan moves the value.
 *
 * - `bank-send` — same chain, same denom. No IBC at all.
 * - `local-swap` — same chain, different denom, through a contract on it.
 * - `ibc-transfer` — one ICS20 hop, no memo.
 * - `ibc-forward` — one signed hop plus packet-forward-middleware hops.
 * - `ibc-swap` — an ibc-hooks contract call on a venue chain, with forwards
 *   before or after as the path needs.
 */
export type RouteStrategy =
  | "bank-send"
  | "local-swap"
  | "ibc-transfer"
  | "ibc-forward"
  | "ibc-swap";

/**
 * How long a route takes, roughly.
 *
 * TODO-VERIFY: these are invented order-of-magnitude figures for "arrives in
 * about a minute" copy, derived from typical six-second blocks plus relayer
 * polling — not a measurement, and not a promise. A host with real telemetry
 * should pass its own numbers.
 */
export interface RouteDurationModel {
  /** A same-chain send: one block plus confirmation. Default 10. */
  readonly bankSendSeconds?: number;
  /** Fixed cost of getting the first packet committed and picked up. Default 20. */
  readonly baseSeconds?: number;
  /** Each packet-moving hop. Default 40. */
  readonly perPacketHopSeconds?: number;
  /** Contract execution inside packet processing. Default 15. */
  readonly swapSeconds?: number;
}

/**
 * One route the user could take.
 *
 * The {@link plan} is the part the rest of the system consumes; everything else
 * exists so the UI can explain the choice and let the user override it.
 */
export interface RoutePlanCandidate {
  /** The plan itself: hops, memo, warnings. */
  readonly plan: RoutePlan;
  readonly strategy: RouteStrategy;
  /** Channels used, in travel order. Empty for a same-chain plan. */
  readonly links: readonly ChannelLink[];
  /**
   * ICS20 `receiver` for the transfer the user signs.
   *
   * Not always the final recipient: a swap route addresses the packet to the
   * contract (ibc-hooks requires the receiver to be `""` or the contract), and
   * a forward route addresses it to the intermediate chain.
   */
  readonly receiver: string;
  /**
   * Priced result, or null when nobody has quoted it.
   *
   * Always null here. The planner has no pool state and will not invent an
   * output amount or a price impact; `swap.ts` fills this in.
   */
  readonly quote: SwapQuote | null;
  /** True when the plan is meaningless until {@link quote} is filled in. */
  readonly requiresQuote: boolean;
  /** Venue the swap runs on, or null for a plan with no swap. */
  readonly venue: SwapVenue | null;
  /** True when the first hop sends a wrapped token back the way it came. */
  readonly unwindsDenom: boolean;
  /** Channels on the path that nobody has verified as open. */
  readonly unverifiedChannelCount: number;
  /** Hops that move an IBC packet. Excludes the swap hop. */
  readonly packetHopCount: number;
  /** Ranking score, lower is better. Exposed so a UI can show ties honestly. */
  readonly score: number;
}

/** Everything {@link planRoute} found. */
export interface RoutePlanResult {
  readonly sourceChainId: string;
  readonly destChainId: string;
  readonly inputDenom: string;
  /** Output denom the caller asked for, defaulted to the unwrapped input. */
  readonly requestedOutputDenom: string;
  /** Viable plans, best first. Empty when nothing works; see {@link warnings}. */
  readonly candidates: readonly RoutePlanCandidate[];
  /** `candidates[0]`, or null. */
  readonly best: RoutePlanCandidate | null;
  /** Why some route was not offered. Planner-level, not per-plan. */
  readonly warnings: readonly string[];
  /** The input denom's trace, when a resolver was available and it was wrapped. */
  readonly resolvedInput: ResolvedDenom | null;
}

/** What {@link planRoute} needs from the host. */
export interface RoutePlannerDeps {
  /** Chain metadata. */
  readonly registry: ChainRegistry;
  /** The channel graph to search. */
  readonly channels: ChannelDirectory;
  /**
   * LCD access, passed through to {@link resolveDenom}. The planner itself
   * never reads from it — that is the point of taking a resolver.
   */
  readonly lcd?: LcdClientFactory;
  /** Denom trace lookup. Without it, `ibc/…` inputs stay opaque. */
  readonly resolveDenom?: RouteDenomResolver;
  /** Which middleware each chain runs. */
  readonly capabilities?: ChainCapabilityLookup;
  /** Places a swap can happen. Empty disables every swap route. */
  readonly venues?: readonly SwapVenue[];
}

/** Tuning for {@link planRoute}. All optional. */
export interface PlanRouteOptions {
  /** Plans to return. Default 8. */
  readonly maxCandidates?: number;
  /** Paths to enumerate per leg. Default 12. */
  readonly maxPathsPerLeg?: number;
  /** Channels to try per chain pair. Default 3. */
  readonly maxLinksPerPair?: number;
  /** User-chosen channels. See {@link RouteHopOverride}. */
  readonly overrides?: readonly RouteHopOverride[];
  /**
   * Receiver to address the packet to on each intermediate chain, keyed by
   * chain id.
   *
   * This package does not derive addresses, so the host — which has the user's
   * key material through zunia-core — re-encodes the sender for each
   * intermediate prefix and passes the results here. Without an entry the
   * planner falls back to the `"pfm"` placeholder and warns; see the note on
   * {@link PFM_INTERMEDIATE_RECEIVER}.
   *
   * TODO-VERIFY: INTERCHAIN-SPEC.md documents `forward.receiver` inside the
   * memo but says nothing about the ICS20 `receiver` of the packet that lands
   * on an intermediate chain. This is the one field where a wrong choice loses
   * funds, so the fallback warns and the host is expected to supply a real
   * address. Confirm against packet-forward-middleware whether an intermediate
   * receiver must be a valid address on that chain.
   */
  readonly intermediateReceivers?: Readonly<Record<string, string>>;
  /** `retries` in each `forward` object. Default 2, the README's value. */
  readonly pfmRetries?: number;
  /** `window_seconds` for TWAP slippage. Default 10, the README's value. */
  readonly twapWindowSeconds?: number;
  /**
   * Use `{"min_output_amount": …}` slippage instead of TWAP.
   *
   * Only meaningful once something has quoted the pool, so the planner never
   * computes it; a caller that has a quote passes the minimum through.
   */
  readonly minOutputAmount?: string;
  /** Drop routes whose intermediate chains do not confirm PFM. Default false. */
  readonly requirePfmSupport?: boolean;
  /** Drop swap routes whose venue does not confirm ibc-hooks. Default false. */
  readonly requireIbcHooksSupport?: boolean;
  /** Passed to {@link RouteDenomResolver} for its reads. */
  readonly lcdRequest?: LcdRequestOptions;
  /** Override the `ibc/…` hash function, e.g. to reuse `denom.ts`'s. */
  readonly hashDenom?: DenomHasher;
  /** Duration estimates. */
  readonly durations?: RouteDurationModel;
  /**
   * Pre-resolved trace for the input denom, so a caller that already has one
   * can plan with no awaits at all.
   */
  readonly resolvedInput?: ResolvedDenom;
}

/* -------------------------------------------------------------------------- *
 * Warnings
 * -------------------------------------------------------------------------- */

function addWarning(list: string[], text: string): void {
  if (!list.includes(text)) list.push(text);
}

function chainLabel(registry: ChainRegistry, chainId: string): string {
  return registry.get(chainId)?.chainName ?? chainId;
}

function isBaseUnitAmount(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function hasCosmwasm(
  chain: ChainInfoLike,
  capabilities: ChainCapabilityLookup | undefined,
): boolean {
  const declared = capabilities?.(chain.chainId)?.cosmwasm;
  if (declared !== undefined) return declared;
  const features = chain.features;
  // A registry row with no `features` array tells us nothing; the catalog
  // generator drops the field today. Treat silence as "maybe", not "no".
  if (!features) return true;
  return features.includes("cosmwasm");
}

/**
 * Warn about the chains a path crosses.
 *
 * Collected per plan rather than per search so the copy can name the chain the
 * user is about to route through.
 */
function collectPathWarnings(args: {
  readonly registry: ChainRegistry;
  readonly capabilities: ChainCapabilityLookup | undefined;
  readonly links: readonly ChannelLink[];
  readonly chainIds: readonly string[];
  /** Chains that must execute a `forward` memo. */
  readonly forwardingChainIds: readonly string[];
  readonly warnings: string[];
}): { unverified: number; capabilityGaps: number } {
  const { registry, capabilities, links, chainIds, warnings } = args;
  let unverified = 0;
  let capabilityGaps = 0;

  for (const link of links) {
    const source = link.source ?? "seed";
    if (source === "verified" && link.state === "open") continue;
    unverified += 1;
    const from = chainLabel(registry, link.sourceChainId);
    if (source === "manual") {
      addWarning(
        warnings,
        `${link.channelId} on ${from} was entered by hand and has not been checked`,
      );
    } else if (link.state === "closed") {
      addWarning(warnings, `${link.channelId} on ${from} is closed`);
    } else {
      addWarning(
        warnings,
        `${link.channelId} on ${from} has not been verified as open`,
      );
    }
    if (!link.counterpartyChannelId) {
      addWarning(
        warnings,
        `The counterparty of ${link.channelId} on ${from} is unknown, so the denom on arrival cannot be computed`,
      );
    }
  }

  for (const chainId of args.forwardingChainIds) {
    const pfm = capabilities?.(chainId)?.pfm;
    if (pfm === true) continue;
    capabilityGaps += 1;
    const label = chainLabel(registry, chainId);
    addWarning(
      warnings,
      pfm === false
        ? `${label} does not run packet-forward-middleware, so the forward will fail`
        : `Packet forwarding on ${label} is unconfirmed`,
    );
  }

  const networks = new Set<string>();
  for (const chainId of chainIds) {
    const network = registry.get(chainId)?.network;
    if (network) networks.add(network);
  }
  if (networks.size > 1) {
    addWarning(
      warnings,
      "This route mixes mainnet and testnet chains and will not complete",
    );
  }

  return { unverified, capabilityGaps };
}

/* -------------------------------------------------------------------------- *
 * Plan assembly
 * -------------------------------------------------------------------------- */

function durationFor(
  model: RouteDurationModel | undefined,
  packetHops: number,
  swaps: number,
): number {
  const base = model?.baseSeconds ?? 20;
  const perHop = model?.perPacketHopSeconds ?? 40;
  const perSwap = model?.swapSeconds ?? 15;
  return base + packetHops * perHop + swaps * perSwap;
}

function transferHop(link: ChannelLink, kind: "transfer" | "forward"): RouteHop {
  return {
    chainId: link.sourceChainId,
    channelId: link.channelId,
    port: link.port ?? TRANSFER_PORT,
    counterpartyChainId: link.destChainId,
    kind,
  };
}

/**
 * The swap hop.
 *
 * `channelId` and `port` are empty because nothing moves: the contract runs on
 * the venue chain during packet processing and the value stays there until the
 * next hop sends it on, so `counterpartyChainId` is the venue itself.
 */
function swapHop(chainId: string): RouteHop {
  return {
    chainId,
    channelId: "",
    port: "",
    counterpartyChainId: chainId,
    kind: "swap",
  };
}

function scoreOf(args: {
  readonly packetHops: number;
  readonly unverified: number;
  readonly capabilityGaps: number;
  readonly isSwap: boolean;
  readonly missedUnwind: boolean;
}): number {
  return (
    args.packetHops * 100 +
    args.unverified * 10 +
    args.capabilityGaps * 5 +
    (args.isSwap ? 5 : 0) +
    (args.missedUnwind ? MISSED_UNWIND_PENALTY : 0)
  );
}

/**
 * Receiver for the packet landing on an intermediate chain.
 *
 * See {@link PlanRouteOptions.intermediateReceivers}. The fallback is honest
 * rather than clever: `"pfm"` is the placeholder the middleware itself uses,
 * and the warning tells the caller it needs a real address.
 */
function intermediateReceiverFor(
  chainId: string,
  registry: ChainRegistry,
  receivers: Readonly<Record<string, string>> | undefined,
  warnings: string[],
): string {
  const supplied = receivers?.[chainId];
  if (supplied) return supplied;
  addWarning(
    warnings,
    `No receiver address for ${chainLabel(registry, chainId)}; the placeholder "${PFM_INTERMEDIATE_RECEIVER}" is used and the host must replace it before signing`,
  );
  return PFM_INTERMEDIATE_RECEIVER;
}

/* -------------------------------------------------------------------------- *
 * planRoute
 * -------------------------------------------------------------------------- */

/**
 * Plan every viable way to move value from one chain to another.
 *
 * Strategies are tried in this order, and all of them contribute candidates:
 *
 * 1. Same chain, same denom — a bank send with no hops.
 * 2. Same chain, different denom — a contract swap on that chain.
 * 3. Cross chain, same asset — a direct ICS20 transfer, or a
 *    packet-forward-middleware chain when nothing direct exists.
 * 4. Cross chain, different asset — through a swap venue's ibc-hooks contract,
 *    with forwards before or after.
 * 5. A wrapped token native to neither side — the first hop unwinds it along
 *    the channel it arrived on, and routing continues from its origin. Sending
 *    it any other way mints a double-wrapped denom no UI can name, so plans
 *    that do are ranked below plans that unwind.
 *
 * @returns All viable plans, best first, plus the reasons anything was ruled
 *   out. An empty {@link RoutePlanResult.candidates} is a normal answer, not an
 *   error — {@link RoutePlanResult.warnings} says why.
 * @throws {@link InterchainError} `unsupported-chain` when either chain is
 *   unknown to the registry. Nothing else here throws: a route that cannot be
 *   built comes back as a warning, because the UI has to show the user
 *   something either way.
 */
export async function planRoute(
  request: RouteRequest,
  deps: RoutePlannerDeps,
  options: PlanRouteOptions = {},
): Promise<RoutePlanResult> {
  const warnings: string[] = [];
  const registry = deps.registry;

  const source = registry.get(request.sourceChainId);
  if (!source) {
    throw new InterchainError(
      "unsupported-chain",
      `Unknown source chain ${request.sourceChainId}`,
      { chainId: request.sourceChainId },
    );
  }
  const dest = registry.get(request.destChainId);
  if (!dest) {
    throw new InterchainError(
      "unsupported-chain",
      `Unknown destination chain ${request.destChainId}`,
      { chainId: request.destChainId },
    );
  }

  if (!isBaseUnitAmount(request.amount)) {
    addWarning(
      warnings,
      "Amount is not a whole number of base units; check it before signing",
    );
  }
  if (request.recipient.length === 0) {
    addWarning(warnings, "No recipient address was supplied");
  }

  const hasher = options.hashDenom ?? defaultDenomHasher;
  const maxHops = clampHops(request.maxHops, DEFAULT_MAX_HOPS);
  const allowPfm = request.allowPfm ?? true;
  const allowSwap = request.allowSwap ?? false;
  const overrides = options.overrides ?? [];

  // Resolve the input denom's trace. Only an `ibc/` denom needs it: anything
  // else is native to the chain that holds it, by definition.
  let resolvedInput: ResolvedDenom | null = options.resolvedInput ?? null;
  if (!resolvedInput && request.inputDenom.startsWith("ibc/")) {
    if (deps.resolveDenom) {
      try {
        resolvedInput = await deps.resolveDenom({
          chain: source,
          denom: request.inputDenom,
          lcd: deps.lcd,
          request: options.lcdRequest,
        });
      } catch {
        // A trace lookup that fails costs us the origin chain and the computed
        // output denom, not the route. Carry on and say so.
        addWarning(
          warnings,
          "Could not read the denom trace, so the token's origin chain is unknown",
        );
      }
    } else {
      addWarning(
        warnings,
        "No denom resolver was supplied, so this wrapped token's origin chain is unknown",
      );
    }
  }

  const inputState: DenomState | null = resolvedInput
    ? { path: resolvedInput.path, baseDenom: resolvedInput.baseDenom }
    : request.inputDenom.startsWith("ibc/")
      ? null
      : { path: "", baseDenom: request.inputDenom };

  const unwrappedInput = resolvedInput?.baseDenom ?? request.inputDenom;
  const requestedOutputDenom = request.outputDenom ?? unwrappedInput;
  const sameAsset =
    request.outputDenom === undefined ||
    request.outputDenom === request.inputDenom ||
    request.outputDenom === unwrappedInput;

  const candidates: RoutePlanCandidate[] = [];

  const emptyResult = (): RoutePlanResult => ({
    sourceChainId: source.chainId,
    destChainId: dest.chainId,
    inputDenom: request.inputDenom,
    requestedOutputDenom,
    candidates: [],
    best: null,
    warnings,
    resolvedInput,
  });

  /* ---------------------------------------------------------------- *
   * 1 & 2: same chain
   * ---------------------------------------------------------------- */

  if (source.chainId === dest.chainId) {
    if (request.outputDenom === undefined || request.outputDenom === request.inputDenom) {
      const plan: RoutePlan = {
        sourceChainId: source.chainId,
        destChainId: dest.chainId,
        inputDenom: request.inputDenom,
        outputDenom: request.inputDenom,
        hops: [],
        memo: "",
        warnings: [...warnings],
        estimatedDurationSeconds: options.durations?.bankSendSeconds ?? 10,
        requiresPfm: false,
        requiresIbcHooks: false,
      };
      candidates.push({
        plan,
        strategy: "bank-send",
        links: [],
        receiver: request.recipient,
        quote: null,
        requiresQuote: false,
        venue: null,
        unwindsDenom: false,
        unverifiedChannelCount: 0,
        packetHopCount: 0,
        score: 0,
      });
      return finish(candidates, warnings, options, {
        source,
        dest,
        request,
        requestedOutputDenom,
        resolvedInput,
      });
    }

    // Different denom on the same chain: a contract swap, not IBC.
    if (!allowSwap) {
      addWarning(
        warnings,
        "Swaps are turned off, so a same-chain swap was not planned",
      );
      return emptyResult();
    }
    if (!hasCosmwasm(source, deps.capabilities)) {
      addWarning(
        warnings,
        `${source.chainName} does not run CosmWasm, so it cannot host a swap`,
      );
      return emptyResult();
    }
    const localVenue = (deps.venues ?? []).find(
      (venue) => venue.chainId === source.chainId,
    );
    if (!localVenue) {
      addWarning(
        warnings,
        `No swap venue is configured on ${source.chainName}`,
      );
      return emptyResult();
    }

    const planWarnings = [...warnings];
    addWarning(
      planWarnings,
      "The output amount is unknown until the pool is quoted",
    );
    const plan: RoutePlan = {
      sourceChainId: source.chainId,
      destChainId: dest.chainId,
      inputDenom: request.inputDenom,
      outputDenom: requestedOutputDenom,
      hops: [swapHop(source.chainId)],
      // A local swap is an ExecuteContract the user signs directly; there is no
      // packet and therefore no memo. `swap.ts` builds the message.
      memo: "",
      warnings: planWarnings,
      estimatedDurationSeconds: durationFor(options.durations, 0, 1),
      requiresPfm: false,
      requiresIbcHooks: false,
    };
    candidates.push({
      plan,
      strategy: "local-swap",
      links: [],
      receiver: request.recipient,
      quote: null,
      requiresQuote: true,
      venue: localVenue,
      unwindsDenom: false,
      unverifiedChannelCount: 0,
      packetHopCount: 0,
      score: 5,
    });
    return finish(candidates, warnings, options, {
      source,
      dest,
      request,
      requestedOutputDenom,
      resolvedInput,
    });
  }

  /* ---------------------------------------------------------------- *
   * Graph: the host's links, plus anything the user forced
   * ---------------------------------------------------------------- */

  const extraLinks: ChannelLink[] = [];
  for (const override of overrides) {
    const link = overrideToLink(override);
    if (link) extraLinks.push(link);
  }

  // 5: the unwind edge. A wrapped token leaves along the channel it arrived on;
  // add that edge so the search can use it even when the directory has no entry.
  let unwindChannelId: string | null = null;
  if (resolvedInput && !resolvedInput.isNative) {
    const firstHop = resolvedInput.hops[0];
    if (firstHop) {
      unwindChannelId = firstHop.channelId;
      const known = deps.channels
        .from(source.chainId)
        .find(
          (link) =>
            link.channelId === firstHop.channelId &&
            (link.port ?? TRANSFER_PORT) === firstHop.port,
        );
      if (!known) {
        // Only safe when the trace has a single hop: then the channel's other
        // end is the origin chain. With more hops the next chain along is not
        // the origin and we cannot name it, so we leave the edge out.
        if (resolvedInput.hops.length === 1 && resolvedInput.originChainId) {
          extraLinks.push({
            sourceChainId: source.chainId,
            destChainId: resolvedInput.originChainId,
            channelId: firstHop.channelId,
            port: firstHop.port,
            source: "seed",
            state: "unknown",
          });
        } else {
          addWarning(
            warnings,
            `Channel ${firstHop.channelId} unwinds this token but is not in the channel list`,
          );
        }
      }
    }
  }

  const directory = withExtraLinks(deps.channels, extraLinks);
  const pathOptions: FindRoutePathsOptions = {
    maxHops: allowPfm ? maxHops : 1,
    maxPaths: options.maxPathsPerLeg ?? DEFAULT_MAX_PATHS,
    maxLinksPerPair: options.maxLinksPerPair ?? DEFAULT_MAX_LINKS_PER_PAIR,
  };
  if (!allowPfm && maxHops > 1) {
    addWarning(
      warnings,
      "Packet forwarding is turned off, so only a direct channel was considered",
    );
  }

  const timeout = `${request.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES}m`;
  const retries = options.pfmRetries ?? DEFAULT_PFM_RETRIES;

  /* ---------------------------------------------------------------- *
   * 3: cross chain, same asset
   * ---------------------------------------------------------------- */

  if (sameAsset) {
    const paths = findRoutePaths(source.chainId, dest.chainId, directory, pathOptions);
    if (paths.length === 0) {
      addWarning(
        warnings,
        `No channel path from ${source.chainName} to ${dest.chainName} within ${maxHops} hops`,
      );
    }

    for (const path of paths) {
      const links = applyOverrides(path.links, overrides);
      const first = links[0];
      if (!first) continue;

      const planWarnings = [...warnings];
      const forwardingChainIds = path.chainIds.slice(1, -1);
      const { unverified, capabilityGaps } = collectPathWarnings({
        registry,
        capabilities: deps.capabilities,
        links,
        chainIds: path.chainIds,
        forwardingChainIds,
        warnings: planWarnings,
      });

      // Hops after the one the user signs. `memo.ts` puts the real recipient on
      // the last of them and the "pfm" sentinel on every earlier one.
      const forwards: ForwardHop[] = [];
      for (let i = 1; i < links.length; i++) {
        const link = links[i];
        if (!link) continue;
        forwards.push({ channelId: link.channelId, port: link.port ?? TRANSFER_PORT });
      }
      const memo = forwardMemoOrNull(forwards, request.recipient, timeout, retries);
      const receiver =
        links.length === 1
          ? request.recipient
          : intermediateReceiverFor(
              path.chainIds[1] ?? "",
              registry,
              options.intermediateReceivers,
              planWarnings,
            );

      const outputState = stepDenomAlong(inputState, links);
      // Null here means either the trace arithmetic gave up (an unknown
      // counterparty channel) or the environment has no WebCrypto. Either way
      // the honest answer is "unknown", never the input denom passed off as the
      // output.
      const computedOutput = await denomStringFor(outputState, hasher);
      const outputDenom = computedOutput ?? requestedOutputDenom;
      if (computedOutput === null) {
        addWarning(
          planWarnings,
          "The denom the recipient ends up with could not be computed",
        );
      }

      const unwindsDenom =
        unwindChannelId !== null && first.channelId === unwindChannelId;
      const missedUnwind = unwindChannelId !== null && !unwindsDenom;
      if (missedUnwind) {
        addWarning(
          planWarnings,
          "This sends a wrapped token onward instead of unwinding it, so the recipient receives a double-wrapped denom",
        );
      }
      if (links.length > 2) {
        addWarning(
          planWarnings,
          `${links.length} hops: each one adds delay and another chance of a timeout`,
        );
      }

      const hops: RouteHop[] = links.map((link, index) =>
        transferHop(link, index === 0 ? "transfer" : "forward"),
      );
      const plan: RoutePlan = {
        sourceChainId: source.chainId,
        destChainId: dest.chainId,
        inputDenom: request.inputDenom,
        outputDenom,
        hops,
        memo: stringifyMemo(memo),
        warnings: planWarnings,
        estimatedDurationSeconds: durationFor(options.durations, links.length, 0),
        requiresPfm: forwards.length > 0,
        requiresIbcHooks: false,
      };
      if (options.requirePfmSupport === true && capabilityGaps > 0) continue;

      candidates.push({
        plan,
        strategy: forwards.length > 0 ? "ibc-forward" : "ibc-transfer",
        links,
        receiver,
        quote: null,
        requiresQuote: false,
        venue: null,
        unwindsDenom,
        unverifiedChannelCount: unverified,
        packetHopCount: links.length,
        score: scoreOf({
          packetHops: links.length,
          unverified,
          capabilityGaps,
          isSwap: false,
          missedUnwind,
        }),
      });
    }

    return finish(candidates, warnings, options, {
      source,
      dest,
      request,
      requestedOutputDenom,
      resolvedInput,
    });
  }

  /* ---------------------------------------------------------------- *
   * 4: cross chain, different asset
   * ---------------------------------------------------------------- */

  if (!allowSwap) {
    addWarning(
      warnings,
      "Swaps are turned off, so no cross-chain swap route was planned",
    );
    return emptyResult();
  }
  const venues = deps.venues ?? [];
  if (venues.length === 0) {
    addWarning(warnings, "No swap venue is configured");
    return emptyResult();
  }
  if (request.slippagePercent === undefined) {
    addWarning(
      warnings,
      `No slippage tolerance was given; ${DEFAULT_SLIPPAGE_PERCENT}% is assumed`,
    );
  }
  if (request.recoveryAddress === undefined) {
    addWarning(
      warnings,
      "No recovery address: if the swap succeeds but delivery fails, the funds cannot be reclaimed",
    );
  }

  const slippage = planSlippage(
    request.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT,
    options.twapWindowSeconds ?? DEFAULT_TWAP_WINDOW_SECONDS,
    options.minOutputAmount,
  );

  for (const venue of venues) {
    const venueChain = registry.get(venue.chainId);
    if (!venueChain) {
      addWarning(warnings, `Swap venue chain ${venue.chainId} is not in the registry`);
      continue;
    }
    if (venue.chainId === source.chainId) {
      // ibc-hooks fires on an incoming packet. Swapping where the funds already
      // are means a contract call and then a transfer: two signatures, which is
      // a different flow, not a route.
      addWarning(
        warnings,
        `Swapping on ${venueChain.chainName} and then transferring takes two transactions and is not planned as one route`,
      );
      continue;
    }
    if (!hasCosmwasm(venueChain, deps.capabilities)) {
      addWarning(
        warnings,
        `${venueChain.chainName} does not run CosmWasm, so it cannot host the swap`,
      );
      continue;
    }
    const hooks = deps.capabilities?.(venue.chainId)?.ibcHooks;
    if (hooks === false && options.requireIbcHooksSupport === true) {
      addWarning(
        warnings,
        `${venueChain.chainName} does not run ibc-hooks, so the swap memo would be ignored`,
      );
      continue;
    }

    const inPaths = findRoutePaths(source.chainId, venue.chainId, directory, pathOptions);
    if (inPaths.length === 0) {
      addWarning(
        warnings,
        `No channel path from ${source.chainName} to ${venueChain.chainName}`,
      );
      continue;
    }
    const outPaths: RoutePath[] =
      venue.chainId === dest.chainId
        ? [{ chainIds: [venue.chainId], links: [] }]
        : findRoutePaths(venue.chainId, dest.chainId, directory, pathOptions);
    if (outPaths.length === 0) {
      addWarning(
        warnings,
        `No channel path from ${venueChain.chainName} to ${dest.chainName}`,
      );
      continue;
    }

    for (const inPath of inPaths) {
      for (const outPath of outPaths) {
        const totalHops = inPath.links.length + outPath.links.length;
        if (totalHops > maxHops) continue;

        const inLinks = applyOverrides(inPath.links, overrides);
        const outLinks = applyOverrides(outPath.links, overrides);
        const first = inLinks[0];
        if (!first) continue;

        const planWarnings = [...warnings];
        const chainIds = [...inPath.chainIds, ...outPath.chainIds.slice(1)];
        const forwardingChainIds = inPath.chainIds.slice(1, -1);
        const { unverified, capabilityGaps } = collectPathWarnings({
          registry,
          capabilities: deps.capabilities,
          links: [...inLinks, ...outLinks],
          chainIds,
          forwardingChainIds,
          warnings: planWarnings,
        });
        if (hooks !== true) {
          addWarning(
            planWarnings,
            hooks === false
              ? `${venueChain.chainName} does not run ibc-hooks, so the swap memo may be ignored`
              : `ibc-hooks support on ${venueChain.chainName} is unconfirmed`,
          );
        }

        // What the swap receives, as denominated on the venue chain. Needed to
        // tell the venue what it is selling; unknowable without a trace.
        const venueInputState = stepDenomAlong(inputState, inLinks);
        const venueInputDenom = await denomStringFor(venueInputState, hasher);
        if (venueInputDenom === null) {
          addWarning(
            planWarnings,
            `The denom arriving on ${venueChain.chainName} could not be computed`,
          );
        } else if (venue.denoms && !venue.denoms.includes(venueInputDenom)) {
          addWarning(
            planWarnings,
            `${venueChain.chainName} does not list ${venueInputDenom} as tradeable`,
          );
        }
        if (!venue.denoms) {
          addWarning(
            planWarnings,
            `The tradeable denoms on ${venueChain.chainName} are unknown, so the pool may not exist`,
          );
        }

        // Post-swap addressing. The contract sends the swapped token to
        // `receiver`, whose prefix picks the destination chain, and `next_memo`
        // carries any further forwards from there.
        //
        // TODO-VERIFY: the spec says XCS v2 keeps on-chain registries of
        // channels and denoms and decides PFM-versus-callback itself, but it
        // does not say that `receiver` is read as "an address on the chain
        // immediately after Osmosis". That reading is what puts a forward in
        // `next_memo` rather than more hops in `receiver`.
        const afterVenueChainId = outPath.chainIds[1] ?? dest.chainId;
        const swapReceiver =
          outLinks.length <= 1
            ? request.recipient
            : intermediateReceiverFor(
                afterVenueChainId,
                registry,
                options.intermediateReceivers,
                planWarnings,
              );
        const postForwards: ForwardHop[] = [];
        for (let i = 1; i < outLinks.length; i++) {
          const link = outLinks[i];
          if (!link) continue;
          postForwards.push({
            channelId: link.channelId,
            port: link.port ?? TRANSFER_PORT,
          });
        }
        const nextMemo = forwardMemoOrNull(
          postForwards,
          request.recipient,
          timeout,
          retries,
        );

        const onFailedDelivery: XcsFailedDelivery =
          request.recoveryAddress === undefined
            ? { kind: "do_nothing" }
            : { kind: "local_recovery_addr", address: request.recoveryAddress };
        // `buildXcsSwapMemoJson` emits the whole `{wasm:{contract,msg}}`, so the
        // exactly-two-keys rule is enforced in one place for every caller.
        const wasmMemo = buildXcsSwapMemoJson({
          contract: venue.contractAddress,
          outputDenom: requestedOutputDenom,
          receiver: swapReceiver,
          slippage,
          onFailedDelivery,
          ...(nextMemo === null ? {} : { nextMemo }),
        });

        // Pre-swap forwards. The last one lands on the venue chain, so its
        // receiver is the contract — ibc-hooks requires the ICS20 receiver to
        // be "" or the contract address — and the wasm memo rides in `next`.
        const preForwards: ForwardHop[] = [];
        for (let i = 1; i < inLinks.length; i++) {
          const link = inLinks[i];
          if (!link) continue;
          preForwards.push({
            channelId: link.channelId,
            port: link.port ?? TRANSFER_PORT,
          });
        }
        // The last pre-swap forward lands on the venue chain, so its receiver is
        // the contract — ibc-hooks requires the ICS20 receiver to be "" or the
        // contract address — and the wasm memo rides in its `next`.
        const memo = forwardMemoOrNull(
          preForwards,
          venue.contractAddress,
          timeout,
          retries,
          wasmMemo,
        );
        const receiver =
          inLinks.length === 1
            ? venue.contractAddress
            : intermediateReceiverFor(
                inPath.chainIds[1] ?? "",
                registry,
                options.intermediateReceivers,
                planWarnings,
              );

        // The recipient holds the venue's output denom wrapped by whatever it
        // crossed on the way out. Only computable when we know the output
        // denom's own trace on the venue chain, which we do not; state it.
        const outputState: DenomState | null = requestedOutputDenom.startsWith("ibc/")
          ? null
          : stepDenomAlong(
              { path: "", baseDenom: requestedOutputDenom },
              outLinks,
            );
        const computedOutput = await denomStringFor(outputState, hasher);
        const outputDenom = computedOutput ?? requestedOutputDenom;
        if (computedOutput === null && outLinks.length > 0) {
          addWarning(
            planWarnings,
            `The denom on ${dest.chainName} is the IBC form of ${requestedOutputDenom} and could not be computed here`,
          );
        }

        addWarning(
          planWarnings,
          "The output amount is unknown until the pool is quoted",
        );
        if (totalHops > 2) {
          addWarning(
            planWarnings,
            `${totalHops} hops: each one adds delay and another chance of a timeout`,
          );
        }

        const hops: RouteHop[] = [
          ...inLinks.map((link, index) =>
            transferHop(link, index === 0 ? "transfer" : "forward"),
          ),
          swapHop(venue.chainId),
          // The outbound packet is emitted by the contract, not by the user and
          // not by PFM, but from the packet's point of view it is a forward.
          ...outLinks.map((link) => transferHop(link, "forward")),
        ];

        const unwindsDenom =
          unwindChannelId !== null && first.channelId === unwindChannelId;
        const plan: RoutePlan = {
          sourceChainId: source.chainId,
          destChainId: dest.chainId,
          inputDenom: request.inputDenom,
          outputDenom,
          hops,
          memo: stringifyMemo(memo),
          warnings: planWarnings,
          estimatedDurationSeconds: durationFor(options.durations, totalHops, 1),
          requiresPfm: preForwards.length > 0 || postForwards.length > 0,
          requiresIbcHooks: true,
        };
        if (options.requirePfmSupport === true && capabilityGaps > 0) continue;

        candidates.push({
          plan,
          strategy: "ibc-swap",
          links: [...inLinks, ...outLinks],
          receiver,
          quote: null,
          requiresQuote: true,
          venue,
          unwindsDenom,
          unverifiedChannelCount: unverified,
          packetHopCount: totalHops,
          score: scoreOf({
            packetHops: totalHops,
            unverified,
            capabilityGaps,
            isSwap: true,
            missedUnwind: false,
          }),
        });
      }
    }
  }

  return finish(candidates, warnings, options, {
    source,
    dest,
    request,
    requestedOutputDenom,
    resolvedInput,
  });
}

/** Sort, cap and package the candidates. */
function finish(
  candidates: readonly RoutePlanCandidate[],
  warnings: readonly string[],
  options: PlanRouteOptions,
  context: {
    readonly source: ChainInfoLike;
    readonly dest: ChainInfoLike;
    readonly request: RouteRequest;
    readonly requestedOutputDenom: string;
    readonly resolvedInput: ResolvedDenom | null;
  },
): RoutePlanResult {
  const ranked = [...candidates].sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    // Deterministic tie-break, so the same inputs always produce the same
    // "best" route and the UI does not reshuffle between renders.
    const aKey = a.links.map((link) => link.channelId).join(",");
    const bKey = b.links.map((link) => link.channelId).join(",");
    return compareChannelIds(aKey, bKey);
  });
  const capped = ranked.slice(0, Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
  return {
    sourceChainId: context.source.chainId,
    destChainId: context.dest.chainId,
    inputDenom: context.request.inputDenom,
    requestedOutputDenom: context.requestedOutputDenom,
    candidates: capped,
    best: capped[0] ?? null,
    warnings: [...warnings],
    resolvedInput: context.resolvedInput,
  };
}

/**
 * The single best plan, for callers that do not offer a choice.
 *
 * @throws {@link InterchainError} `no-route` when nothing works. The message
 *   carries the planner's warnings, because "no route" on its own tells the user
 *   nothing they can act on.
 */
export async function bestRoutePlan(
  request: RouteRequest,
  deps: RoutePlannerDeps,
  options: PlanRouteOptions = {},
): Promise<RoutePlan> {
  const result = await planRoute(request, deps, options);
  const best = result.best;
  if (!best) {
    const detail = result.warnings.join("; ");
    throw new InterchainError(
      "no-route",
      detail
        ? `No route from ${request.sourceChainId} to ${request.destChainId}: ${detail}`
        : `No route from ${request.sourceChainId} to ${request.destChainId}`,
      { chainId: request.sourceChainId },
    );
  }
  return best.plan;
}
