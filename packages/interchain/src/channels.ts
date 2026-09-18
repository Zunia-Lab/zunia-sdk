/**
 * Unified IBC channel discovery and validation.
 *
 * This module replaces three hand-maintained copies of the same logic:
 * `zunia-extension/lib/ibc-channels.ts`, `zunia-dashboard/src/lib/server/ibc-channels.ts`
 * and the IBC section of `zunia-mobile/lib/services/chain_client.dart`. The
 * result shapes and the user-facing `message` strings are kept byte-identical
 * to those, so all three clients are a drop-in swap.
 *
 * Two behavioural changes are deliberate and are called out where they happen:
 *
 * 1. `STATE_TRYOPEN` is no longer reported as `open`. All three predecessors
 *    tested `includes("OPEN")` first, and "STATE_TRYOPEN" contains "OPEN", so a
 *    half-open channel looked ready. See {@link parseChannelState}.
 * 2. {@link IbcChannelService.validateIbcChannel} can verify the *counterparty*
 *    side as well. An IBC channel is two objects on two chains; the source side
 *    can be `STATE_OPEN` while the far side is closed, was re-handshaked onto a
 *    different channel, or never existed. Transfers into that channel are
 *    escrowed on the source chain and never minted on the destination.
 *
 * This module reads. It never holds a key and never signs: signing stays in
 * zunia-core (Rust/WASM/FFI). Every request goes through {@link LcdClient} so
 * timeouts, retries, endpoint fallback and the host's live-reads gate are
 * applied uniformly; there is no `fetch` call in this file.
 */

import {
  InterchainError,
  TRANSFER_PORT,
  isInterchainError,
  type ChainInfoLike,
  type ChainRegistry,
  type IbcChannelCheck,
  type IbcChannelOption,
  type IbcChannelState,
  type LcdClient,
  type LcdClientFactory,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

/** Channels per page of `/ibc/core/channel/v1/channels`. Matches the old code. */
const DEFAULT_PAGE_LIMIT = 100;
/** Pages walked before giving up. Matches the old code. */
const DEFAULT_MAX_PAGES = 3;
/** Channel listings change on the timescale of a relayer deployment, not a block. */
const DEFAULT_CHANNEL_CACHE_TTL_MS = 30_000;
/** A connection's client never re-points at a different chain, so cache hard. */
const DEFAULT_CONNECTION_CACHE_TTL_MS = 300_000;
/** A failed resolution is usually a flaky endpoint; retry it soon. */
const DEFAULT_CONNECTION_FAILURE_TTL_MS = 10_000;
/** Module sets change at upgrade height. Ten minutes is well inside that. */
const DEFAULT_MODULE_SUPPORT_TTL_MS = 600_000;
/** An inconclusive probe is worth repeating sooner than a conclusive one. */
const DEFAULT_MODULE_SUPPORT_UNKNOWN_TTL_MS = 30_000;

/**
 * HTTP statuses that mean "this route is not registered on this node".
 *
 * The cosmos gRPC gateway answers 501 for a query service the chain does not
 * run, and reverse proxies in front of public LCDs answer 404 or 405. 400 is
 * deliberately absent: a bad-request could also be a real route rejecting real
 * input, and misreading that as "module missing" would be a confident lie.
 */
const ROUTE_ABSENT_STATUSES: ReadonlySet<number> = new Set([404, 405, 501]);

/**
 * Candidate REST routes for the packet-forward-middleware params query.
 *
 * TODO-VERIFY: not covered by INTERCHAIN-SPEC.md. Confirm the first path
 * against a live Osmosis or Neutron LCD before trusting a `supported` answer.
 * `/ibc/apps/packetforward/v1/params`
 * is the route ibc-apps registers for the current `packetforward` module; the
 * others are the older `router` module name. They are tried in order and the
 * first that answers with a `params` object wins. Treat a hit as evidence, not
 * proof — see {@link ModuleSupport}.
 */
export const PFM_PROBE_PATHS: readonly string[] = [
  "/ibc/apps/packetforward/v1/params",
  "/ibc/apps/router/v1/params",
  "/router/v1/params",
];

/**
 * Candidate REST routes for an ibc-hooks params query.
 *
 * TODO-VERIFY: not covered by INTERCHAIN-SPEC.md, and weaker evidence than the PFM
 * probe: Osmosis' `x/ibc-hooks` is a middleware wrapped around the transfer
 * stack and several releases register no query service at all. When none of
 * these answer, {@link IbcChannelService.detectIbcHooksSupport} falls back to
 * asking whether CosmWasm is present, which is necessary but not sufficient.
 */
export const IBC_HOOKS_PROBE_PATHS: readonly string[] = [
  "/ibc/apps/ibchooks/v1/params",
  "/osmosis/ibchooks/v1beta1/params",
];

/** Cheapest CosmWasm liveness probe: one page of one code id. */
const WASM_PROBE_PATH = "/cosmwasm/wasm/v1/codes";

/* -------------------------------------------------------------------------- *
 * Public result types
 * -------------------------------------------------------------------------- */

/**
 * A chain, either by id or by value.
 *
 * The clients being replaced pass chain ids; a caller that already holds the
 * catalog row can pass it directly and skip the registry lookup. Passing an id
 * requires {@link IbcChannelServiceConfig.registry}.
 */
export type ChainRef = string | ChainInfoLike;

/** Outcome of the counterparty-side check. */
export type CounterpartyCheckStatus =
  /** The far side exists, is open, and names our channel back. */
  | "ok"
  /** The far side does not have that channel. */
  | "not-found"
  /** The far side exists but is not open. */
  | "not-open"
  /** The far side is open but points at a different channel or chain. */
  | "mismatch"
  /** The destination LCD did not answer. Proves nothing either way. */
  | "unreachable"
  /** The check could not be attempted (no chain metadata, no REST endpoint). */
  | "skipped";

/**
 * What the destination chain says about its half of the channel.
 *
 * `ok` is true only for {@link CounterpartyCheckStatus} `"ok"`. `"unreachable"`
 * and `"skipped"` are not failures: they mean nothing was learned, and the
 * caller should keep whatever the source-side check concluded.
 */
export interface CounterpartyCheck {
  readonly status: CounterpartyCheckStatus;
  /** True only when the far side was found, open, and pointing back. */
  readonly ok: boolean;
  /** Chain that was queried. `null` when the check was skipped. */
  readonly chainId: string | null;
  /** Channel id queried on the destination. `null` when unknown. */
  readonly channelId: string | null;
  /** Port queried on the destination. `null` when unknown. */
  readonly portId: string | null;
  /** State of the far side. `"unknown"` when it was never read. */
  readonly state: IbcChannelState;
  /** The channel id the far side names as *its* counterparty. */
  readonly pointsBackTo: string | null;
  /** User-facing copy, in the same voice as {@link IbcChannelCheck.message}. */
  readonly message: string;
}

/**
 * {@link IbcChannelCheck} plus the optional counterparty result.
 *
 * Structurally assignable to `IbcChannelCheck`, so existing render code keeps
 * working and only screens that ask for the deeper check see the extra field.
 */
export interface IbcChannelValidation extends IbcChannelCheck {
  /** Present only when the deeper check ran. */
  readonly counterparty?: CounterpartyCheck;
}

/** Interchain middlewares this module can probe for. */
export type InterchainModule = "packet-forward" | "ibc-hooks";

/**
 * How confident the probe is.
 *
 * `"unknown"` is a real answer and not an error: public LCDs hide routes, and
 * some middlewares register no query service. Both `"unsupported"` and
 * `"unknown"` mean "do not build a memo that depends on this module"; they
 * differ only in what the UI is entitled to claim.
 */
export type ModuleSupportStatus = "supported" | "unsupported" | "unknown";

/** Result of a module probe. */
export interface ModuleSupport {
  readonly chainId: string;
  readonly module: InterchainModule;
  readonly status: ModuleSupportStatus;
  /** Convenience for call sites: true only when `status === "supported"`. */
  readonly supported: boolean;
  /** Which probe produced this answer. Developer-facing, safe to log. */
  readonly evidence: string;
  /** `Date.now()` at the time the answer was produced. */
  readonly checkedAt: number;
}

/**
 * Host-declared truth about a chain's middlewares.
 *
 * The probes below are heuristics. A host that has verified a chain (from the
 * chain registry, a config file, or a governance proposal it trusts) can pin
 * the answer and skip the network entirely. The package ships no such list of
 * its own — nothing here is hardcoded per chain.
 */
export interface ModuleSupportOverride {
  readonly packetForward?: boolean;
  readonly ibcHooks?: boolean;
}

/* -------------------------------------------------------------------------- *
 * User-facing copy
 * -------------------------------------------------------------------------- */

/**
 * The strings the clients render as-is.
 *
 * Overridable because the three predecessors disagree on exactly one line: the
 * extension says "Turn on live balances to check channels" (its switch is
 * labelled Live balances) while mobile says "live reads". Everything else is
 * shared, and the defaults reproduce the existing wording.
 */
export interface ChannelMessages {
  /** Empty input in the manual-entry field. */
  readonly emptyInput: string;
  /** The host's live-reads gate is off. */
  readonly readsDisabled: string;
  /** No REST endpoint is configured for the chain. */
  readonly noEndpoint: string;
  /** The chain does not know that channel. */
  readonly notFound: string;
  /** The source LCD did not answer. */
  readonly unreachable: string;
  /** Channel exists but is not open. */
  notOpen(state: IbcChannelState): string;
  /** Channel is open but its client targets a different chain. */
  wrongChain(chainId: string): string;
  /** Open, and the counterparty chain could not be named. */
  readonly open: string;
  /** Open, with the counterparty chain named. */
  openWith(chainId: string): string;
  /** Both sides confirmed. */
  counterpartyOk(chainId: string): string;
  /** The far side has no such channel. */
  counterpartyNotFound(chainId: string): string;
  /** The far side exists but is not open. */
  counterpartyNotOpen(state: IbcChannelState, chainId: string): string;
  /** The far side points somewhere else. */
  counterpartyMismatch(expected: string, actual: string | null): string;
  /** The destination LCD did not answer. */
  counterpartyUnreachable(chainId: string): string;
  /** The check could not run. `reason` is developer-facing detail. */
  counterpartySkipped(reason: string): string;
}

/** Default copy. Matches the strings the three clients render today. */
export const DEFAULT_CHANNEL_MESSAGES: ChannelMessages = {
  emptyInput: "Enter a channel id (e.g. channel-141)",
  readsDisabled: "Turn on live reads to check channels",
  noEndpoint: "No REST endpoint for this chain",
  notFound: "Channel not found on this chain",
  unreachable: "Could not reach the chain to verify this channel",
  notOpen: (state) => `Channel is ${state}, not open`,
  wrongChain: (chainId) => `Open, but connects to ${chainId}`,
  open: "Open and ready",
  openWith: (chainId) => `Open · ${chainId}`,
  counterpartyOk: (chainId) => `Open on both sides · ${chainId}`,
  counterpartyNotFound: (chainId) => `Open here, but missing on ${chainId}`,
  counterpartyNotOpen: (state, chainId) =>
    `Open here, but ${state} on ${chainId}`,
  counterpartyMismatch: (expected, actual) =>
    actual
      ? `The other side points at ${actual}, not ${expected}`
      : `The other side does not point back at ${expected}`,
  counterpartyUnreachable: (chainId) => `Could not reach ${chainId} to check the other side`,
  counterpartySkipped: (reason) => `Other side not checked: ${reason}`,
};

/* -------------------------------------------------------------------------- *
 * Options
 * -------------------------------------------------------------------------- */

/** Per-call knobs shared by every method. */
export interface ChannelQueryOptions {
  /** Caller cancellation. Propagated to every request; aborts always throw. */
  readonly signal?: AbortSignal;
  /** Channels per page. Defaults to the service's, then 100. */
  readonly pageLimit?: number;
  /** Maximum pages walked. Defaults to the service's, then 3. */
  readonly maxPages?: number;
  /** Cache TTL for this call's reads. `0` bypasses the cache. */
  readonly cacheTtlMs?: number;
  /** Port to inspect. Defaults to `transfer`; ICS721 callers pass their own. */
  readonly portId?: string;
}

/** Extra knobs for {@link IbcChannelService.validateIbcChannel}. */
export interface ChannelValidateOptions extends ChannelQueryOptions {
  /**
   * Also query the destination chain and confirm the far side is open and
   * points back. Off by default: it costs a second chain's LCD round-trip, and
   * the manual-entry field is typed into character by character.
   */
  readonly checkCounterparty?: boolean;
}

/** Construction options for {@link createIbcChannelService}. */
export interface IbcChannelServiceConfig {
  /** Builds the read client for a chain. Required. */
  readonly lcd: LcdClientFactory;
  /**
   * Chain lookup. Required only if callers pass chain ids rather than chain
   * objects, or if the counterparty check should resolve the destination chain
   * from the connection's client state.
   */
  readonly registry?: ChainRegistry;
  /** Channels per page. Default 100. */
  readonly pageLimit?: number;
  /** Maximum pages walked. Default 3. */
  readonly maxPages?: number;
  /** TTL for channel reads. Default 30_000. */
  readonly channelCacheTtlMs?: number;
  /** TTL for a resolved connection to chain id. Default 300_000. */
  readonly connectionCacheTtlMs?: number;
  /** TTL for a failed connection resolution. Default 10_000. */
  readonly connectionFailureTtlMs?: number;
  /** TTL for a conclusive module probe. Default 600_000. */
  readonly moduleSupportTtlMs?: number;
  /** TTL for an inconclusive module probe. Default 30_000. */
  readonly moduleSupportUnknownTtlMs?: number;
  /** Copy overrides, merged over {@link DEFAULT_CHANNEL_MESSAGES}. */
  readonly messages?: Partial<ChannelMessages>;
  /** Verified per-chain module support, keyed by chain id. Consulted first. */
  readonly moduleSupport?: Readonly<Record<string, ModuleSupportOverride>>;
  /** Probe routes for PFM. Defaults to {@link PFM_PROBE_PATHS}. */
  readonly pfmProbePaths?: readonly string[];
  /** Probe routes for ibc-hooks. Defaults to {@link IBC_HOOKS_PROBE_PATHS}. */
  readonly ibcHooksProbePaths?: readonly string[];
  /** Injected for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Channel discovery, validation and middleware probing for one host.
 *
 * Construct once per host and keep it: the memo caches for connection to chain
 * id and for module probes live on the instance, and a discovery pass over a
 * hundred channels collapses to a handful of requests because of them.
 */
export interface IbcChannelService {
  /**
   * Open transfer channels on `source` whose connection client targets `dest`.
   *
   * @returns Channels sorted by numeric channel id. Empty when the source chain
   *   is unknown, has no REST endpoint, equals the destination, or when the
   *   host's live-reads gate is off — all four are ordinary states in the UI,
   *   not errors.
   * @throws {@link InterchainError} `aborted` when the caller cancels, and
   *   `lcd-unreachable` / `malformed-response` when the channel listing itself
   *   fails. A failure resolving one connection is swallowed: that channel is
   *   dropped rather than the whole list.
   */
  findIbcChannels(
    source: ChainRef,
    dest: ChainRef,
    options?: ChannelQueryOptions,
  ): Promise<readonly IbcChannelOption[]>;

  /**
   * Check one channel id typed by the user.
   *
   * Accepts `channel-141` or `141`. Never throws for a chain-state reason: the
   * failure is the returned {@link IbcChannelValidation}, whose `message` the
   * clients render directly.
   *
   * @throws {@link InterchainError} `aborted` only.
   */
  validateIbcChannel(
    source: ChainRef,
    channelRaw: string,
    dest?: ChainRef,
    options?: ChannelValidateOptions,
  ): Promise<IbcChannelValidation>;

  /**
   * Ask the destination chain about its half of an already-discovered channel.
   *
   * Exposed separately so a caller can deep-check one option out of a list from
   * {@link IbcChannelService.findIbcChannels} without re-validating the source
   * side.
   *
   * @throws {@link InterchainError} `aborted` only.
   */
  checkCounterpartyChannel(
    source: ChainRef,
    option: IbcChannelOption,
    dest?: ChainRef,
    options?: ChannelQueryOptions,
  ): Promise<CounterpartyCheck>;

  /**
   * Probe for packet-forward-middleware.
   *
   * A probe, not a guarantee: it asks the LCD for the module's params route.
   * A public node may hide the route, and a chain may run the middleware
   * without registering a query service.
   */
  detectPfmSupport(
    chain: ChainRef,
    options?: ChannelQueryOptions,
  ): Promise<ModuleSupport>;

  /**
   * Probe for ibc-hooks (the wasm memo hook).
   *
   * Weaker than the PFM probe. When no hooks route answers, this falls back to
   * "is CosmWasm present at all", which rules the module out when wasm is
   * missing but cannot rule it in when wasm is there. Expect `"unknown"` on
   * chains that genuinely run it, and pin the answer through
   * {@link IbcChannelServiceConfig.moduleSupport} when you know better.
   */
  detectIbcHooksSupport(
    chain: ChainRef,
    options?: ChannelQueryOptions,
  ): Promise<ModuleSupport>;

  /** Drop every memoised connection and module answer. */
  clearCache(): void;
}

/* -------------------------------------------------------------------------- *
 * Parsing helpers
 * -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Normalise a user-typed channel id.
 *
 * Accepts `channel-141` and the bare `141`. Anything else is lowercased and
 * returned unchanged so the LCD gets the chance to reject it with a real
 * answer, which is more useful than a client-side guess.
 */
export function normalizeChannelId(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "";
  if (/^channel-\d+$/.test(value)) return value;
  if (/^\d+$/.test(value)) return `channel-${value}`;
  return value;
}

/**
 * Normalise a channel state from the LCD.
 *
 * Handles both the string form (`"STATE_OPEN"`) and the integer form some
 * proto-JSON encoders emit, and tolerates a missing value.
 *
 * Order matters here, and this is where the module diverges from the code it
 * replaces: `"STATE_TRYOPEN".includes("OPEN")` is true, so testing OPEN first
 * — as all three predecessors did — reports a channel that is still mid
 * handshake as ready to receive funds. TRYOPEN is checked first for that
 * reason.
 *
 * ibc-go v8.1's channel-upgrade states (`STATE_FLUSHING`,
 * `STATE_FLUSHCOMPLETE`) fall through to `"unknown"`. The shared
 * {@link IbcChannelState} union has no member for them, and "unknown" is the
 * safe reading: a flushing channel is not accepting new packets.
 */
export function parseChannelState(raw: unknown): IbcChannelState {
  if (typeof raw === "number") {
    // ibc-go's State enum: 1 INIT, 2 TRYOPEN, 3 OPEN, 4 CLOSED.
    if (raw === 1) return "init";
    if (raw === 2) return "tryopen";
    if (raw === 3) return "open";
    if (raw === 4) return "closed";
    return "unknown";
  }
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return "unknown";
  // `STATE_UNINITIALIZED_UNSPECIFIED` contains "INIT". Rule the zero value out
  // before any substring test, or a channel that was never opened reads as one
  // that is mid-handshake.
  if (value.includes("UNINITIALIZED") || value.includes("UNSPECIFIED")) return "unknown";
  if (value.includes("TRYOPEN") || value.includes("TRY_OPEN") || value.includes("TRY")) {
    return "tryopen";
  }
  if (value.includes("CLOSED")) return "closed";
  if (value.includes("INIT")) return "init";
  if (value.includes("OPEN")) return "open";
  return "unknown";
}

/** A channel row, narrowed from LCD JSON. */
interface ParsedChannel {
  readonly channelId: string;
  readonly portId: string;
  readonly state: IbcChannelState;
  readonly connectionId: string | null;
  readonly counterpartyChannelId: string;
  readonly counterpartyPortId: string;
}

/**
 * Narrow one channel object.
 *
 * `/ibc/core/channel/v1/channels` returns `IdentifiedChannel` rows, which carry
 * `channel_id` and `port_id`. `/channels/{id}/ports/{port}` returns a bare
 * `Channel`, which does not — hence the fallbacks, which the caller fills from
 * what it asked for.
 */
function parseChannel(
  value: unknown,
  fallbackChannelId: string,
  fallbackPortId: string,
): ParsedChannel | null {
  const row = asRecord(value);
  if (!row) return null;
  const channelId = asNonEmptyString(row.channel_id) ?? fallbackChannelId;
  if (!channelId) return null;
  const hops = Array.isArray(row.connection_hops) ? row.connection_hops : [];
  const counterparty = asRecord(row.counterparty);
  return {
    channelId,
    portId: asNonEmptyString(row.port_id) ?? fallbackPortId,
    state: parseChannelState(row.state),
    // Only the first hop identifies the directly connected chain. Multi-hop
    // connection paths are not used by any live IBC deployment, so a longer
    // list is ignored rather than guessed at.
    connectionId: asNonEmptyString(hops[0]),
    counterpartyChannelId: counterparty
      ? (asNonEmptyString(counterparty.channel_id) ?? "")
      : "",
    counterpartyPortId: counterparty
      ? (asNonEmptyString(counterparty.port_id) ?? TRANSFER_PORT)
      : TRANSFER_PORT,
  };
}

/**
 * The client id behind a connection.
 *
 * `/ibc/core/connection/v1/connections/{id}` nests the row under `connection`;
 * a few forks answer flat. Both are accepted, as in the code being replaced.
 */
function parseConnectionClientId(value: unknown): string | null {
  const body = asRecord(value);
  if (!body) return null;
  const nested = asRecord(body.connection);
  return (
    asNonEmptyString(nested?.client_id) ?? asNonEmptyString(body.client_id)
  );
}

/**
 * The chain id a client tracks.
 *
 * `/ibc/core/client/v1/client_states/{id}` answers
 * `{ "client_state": { "@type": "...ClientState", "chain_id": "osmosis-1" } }`.
 * Solo-machine and localhost clients have no `chain_id`; they yield `null`
 * rather than a fabricated value.
 */
function parseClientChainId(value: unknown): string | null {
  const body = asRecord(value);
  if (!body) return null;
  const nested = asRecord(body.client_state) ?? body;
  return asNonEmptyString(nested.chain_id);
}

/** The `pagination.next_key` of a list response, or `null` when exhausted. */
function parseNextKey(value: unknown): string | null {
  const pagination = asRecord(asRecord(value)?.pagination);
  return asNonEmptyString(pagination?.next_key);
}

/* -------------------------------------------------------------------------- *
 * Error predicates
 * -------------------------------------------------------------------------- */

function errorCode(error: unknown): string | null {
  return isInterchainError(error) ? error.code : null;
}

/** An abort is the caller's decision and is never swallowed. */
function isAborted(error: unknown): boolean {
  return errorCode(error) === "aborted";
}

function isReadsDisabled(error: unknown): boolean {
  return errorCode(error) === "reads-disabled";
}

function httpStatusOf(error: unknown): number | undefined {
  return isInterchainError(error) ? error.httpStatus : undefined;
}

function assertNotAborted(signal: AbortSignal | undefined, chainId: string): void {
  if (signal?.aborted === true) {
    throw new InterchainError("aborted", `${chainId}: request cancelled`, { chainId });
  }
}

/* -------------------------------------------------------------------------- *
 * Service
 * -------------------------------------------------------------------------- */

interface ConnectionCacheEntry {
  readonly chainId: string | null;
  readonly expiresAt: number;
}

interface SupportCacheEntry {
  readonly value: ModuleSupport;
  readonly expiresAt: number;
}

/** Outcome of probing a list of candidate routes. */
type ProbeOutcome =
  /** A route answered with a params object. */
  | { readonly kind: "hit"; readonly path: string }
  /** Every route was answered, and every answer said "no such route". */
  | { readonly kind: "absent"; readonly path: string }
  /** At least one route failed for a reason that proves nothing. */
  | { readonly kind: "unknown"; readonly detail: string }
  /** The host's live-reads gate is off. Never cached. */
  | { readonly kind: "reads-disabled" };

/**
 * Build the channel service.
 *
 * @param config - Host wiring. Only `lcd` is required; `registry` becomes
 *   required as soon as a caller passes a chain id instead of a chain object.
 */
export function createIbcChannelService(
  config: IbcChannelServiceConfig,
): IbcChannelService {
  const messages: ChannelMessages = { ...DEFAULT_CHANNEL_MESSAGES, ...config.messages };
  const now = config.now ?? (() => Date.now());
  const defaultPageLimit = config.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const defaultMaxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
  const channelTtlMs = config.channelCacheTtlMs ?? DEFAULT_CHANNEL_CACHE_TTL_MS;
  const connectionTtlMs = config.connectionCacheTtlMs ?? DEFAULT_CONNECTION_CACHE_TTL_MS;
  const connectionFailureTtlMs =
    config.connectionFailureTtlMs ?? DEFAULT_CONNECTION_FAILURE_TTL_MS;
  const supportTtlMs = config.moduleSupportTtlMs ?? DEFAULT_MODULE_SUPPORT_TTL_MS;
  const supportUnknownTtlMs =
    config.moduleSupportUnknownTtlMs ?? DEFAULT_MODULE_SUPPORT_UNKNOWN_TTL_MS;
  const pfmPaths = config.pfmProbePaths ?? PFM_PROBE_PATHS;
  const hooksPaths = config.ibcHooksProbePaths ?? IBC_HOOKS_PROBE_PATHS;

  // Shared across calls: the same connection is walked once per discovery pass
  // per channel otherwise, and a busy chain has a hundred channels on a dozen
  // connections.
  const connectionCache = new Map<string, ConnectionCacheEntry>();
  const supportCache = new Map<string, SupportCacheEntry>();

  function resolveChain(ref: ChainRef): ChainInfoLike | undefined {
    if (typeof ref !== "string") return ref;
    const chainId = ref.trim();
    if (!chainId) return undefined;
    if (!config.registry) {
      // A missing registry is a wiring bug, not a missing chain: fail loudly
      // rather than returning "unknown chain" and hiding it in empty UI.
      throw new InterchainError(
        "unsupported-chain",
        `A ChainRegistry is required to resolve "${chainId}" by id`,
        { chainId },
      );
    }
    return config.registry.get(chainId);
  }

  function refChainId(ref: ChainRef | undefined): string {
    if (ref === undefined) return "";
    return (typeof ref === "string" ? ref : ref.chainId).trim();
  }

  /**
   * Build a read client, or `null` when the chain has no usable endpoint.
   *
   * The factory throws `unsupported-chain` for a chain with no REST URL. That
   * is a UI state ("No REST endpoint for this chain"), not an exception, so it
   * is converted here. Catching rather than pre-checking `rest` keeps hosts
   * that inject their own endpoint lists working.
   */
  function clientFor(chain: ChainInfoLike): LcdClient | null {
    try {
      return config.lcd(chain);
    } catch (error) {
      if (errorCode(error) === "unsupported-chain") return null;
      throw error;
    }
  }

  async function resolveConnectionChainId(
    client: LcdClient,
    connectionId: string,
    options: ChannelQueryOptions,
  ): Promise<string | null> {
    const key = `${client.chainId}|${connectionId}`;
    const hit = connectionCache.get(key);
    if (hit && hit.expiresAt > now()) return hit.chainId;

    const requestOptions = {
      signal: options.signal,
      cacheTtlMs: options.cacheTtlMs ?? channelTtlMs,
    };

    try {
      const connection = await client.getJson(
        `/ibc/core/connection/v1/connections/${encodeURIComponent(connectionId)}`,
        requestOptions,
      );
      const clientId = parseConnectionClientId(connection);
      if (!clientId) {
        remember(key, null);
        return null;
      }
      const clientState = await client.getJson(
        `/ibc/core/client/v1/client_states/${encodeURIComponent(clientId)}`,
        requestOptions,
      );
      const chainId = parseClientChainId(clientState);
      remember(key, chainId);
      return chainId;
    } catch (error) {
      if (isAborted(error) || isReadsDisabled(error)) throw error;
      // One unresolvable connection drops one channel from the list; it must
      // not fail the whole listing, which is why this is swallowed.
      remember(key, null);
      return null;
    }
  }

  function remember(key: string, chainId: string | null): void {
    connectionCache.set(key, {
      chainId,
      expiresAt: now() + (chainId === null ? connectionFailureTtlMs : connectionTtlMs),
    });
  }

  async function listChannels(
    client: LcdClient,
    portId: string,
    options: ChannelQueryOptions,
  ): Promise<ParsedChannel[]> {
    const pageLimit = Math.max(1, Math.trunc(options.pageLimit ?? defaultPageLimit));
    const maxPages = Math.max(1, Math.trunc(options.maxPages ?? defaultMaxPages));
    const out: ParsedChannel[] = [];
    const seenKeys = new Set<string>();
    let key: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      assertNotAborted(options.signal, client.chainId);
      const body = await client.getJson("/ibc/core/channel/v1/channels", {
        signal: options.signal,
        cacheTtlMs: options.cacheTtlMs ?? channelTtlMs,
        query: { "pagination.limit": pageLimit, "pagination.key": key },
      });
      const rows = asRecord(body)?.channels;
      if (Array.isArray(rows)) {
        for (const raw of rows) {
          const parsed = parseChannel(raw, "", portId);
          if (!parsed || !parsed.channelId) continue;
          if (parsed.portId !== portId) continue;
          out.push(parsed);
        }
      }
      const next = parseNextKey(body);
      // A node that echoes the same cursor forever would otherwise burn every
      // page of the budget on one page of data.
      if (!next || seenKeys.has(next)) break;
      seenKeys.add(next);
      key = next;
    }
    return out;
  }

  async function readChannel(
    client: LcdClient,
    channelId: string,
    portId: string,
    options: ChannelQueryOptions,
  ): Promise<ParsedChannel | null> {
    const body = await client.getJson(
      `/ibc/core/channel/v1/channels/${encodeURIComponent(channelId)}/ports/${encodeURIComponent(portId)}`,
      {
        signal: options.signal,
        cacheTtlMs: options.cacheTtlMs ?? channelTtlMs,
      },
    );
    return parseChannel(asRecord(body)?.channel, channelId, portId);
  }

  function skipped(reason: string, chainId: string | null): CounterpartyCheck {
    return {
      status: "skipped",
      ok: false,
      chainId,
      channelId: null,
      portId: null,
      state: "unknown",
      pointsBackTo: null,
      message: messages.counterpartySkipped(reason),
    };
  }

  async function counterpartyCheck(
    sourceChainId: string,
    channelId: string,
    portId: string,
    counterpartyChannelId: string,
    counterpartyPortId: string,
    counterpartyChainId: string | null,
    destChain: ChainInfoLike | undefined,
    options: ChannelQueryOptions,
  ): Promise<CounterpartyCheck> {
    if (!counterpartyChannelId) {
      return skipped("the source chain did not name a counterparty channel", counterpartyChainId);
    }

    let chain = destChain;
    if (!chain && counterpartyChainId && config.registry) {
      chain = config.registry.get(counterpartyChainId);
    }
    if (!chain) {
      return skipped("the destination chain is not in the registry", counterpartyChainId);
    }

    const client = clientFor(chain);
    if (!client) return skipped(messages.noEndpoint, chain.chainId);

    let far: ParsedChannel | null;
    try {
      far = await readChannel(client, counterpartyChannelId, counterpartyPortId, options);
    } catch (error) {
      if (isAborted(error)) throw error;
      const status = httpStatusOf(error);
      if (status !== undefined && ROUTE_ABSENT_STATUSES.has(status)) {
        return {
          status: "not-found",
          ok: false,
          chainId: chain.chainId,
          channelId: counterpartyChannelId,
          portId: counterpartyPortId,
          state: "unknown",
          pointsBackTo: null,
          message: messages.counterpartyNotFound(chain.chainId),
        };
      }
      // Reads-disabled and every transport failure land here: nothing was
      // learned about the far side, so the source-side verdict stands.
      return {
        status: "unreachable",
        ok: false,
        chainId: chain.chainId,
        channelId: counterpartyChannelId,
        portId: counterpartyPortId,
        state: "unknown",
        pointsBackTo: null,
        message: messages.counterpartyUnreachable(chain.chainId),
      };
    }

    if (!far) {
      return {
        status: "not-found",
        ok: false,
        chainId: chain.chainId,
        channelId: counterpartyChannelId,
        portId: counterpartyPortId,
        state: "unknown",
        pointsBackTo: null,
        message: messages.counterpartyNotFound(chain.chainId),
      };
    }

    const base = {
      chainId: chain.chainId,
      channelId: counterpartyChannelId,
      portId: counterpartyPortId,
      state: far.state,
      pointsBackTo: far.counterpartyChannelId || null,
    } as const;

    if (far.state !== "open") {
      return {
        ...base,
        status: "not-open",
        ok: false,
        message: messages.counterpartyNotOpen(far.state, chain.chainId),
      };
    }

    // The pair must name each other. A channel re-handshaked after an upgrade
    // can leave the old id open on one side only; funds sent into it are
    // escrowed on the source chain and never minted on the destination.
    if (far.counterpartyChannelId !== channelId || far.counterpartyPortId !== portId) {
      return {
        ...base,
        status: "mismatch",
        ok: false,
        message: messages.counterpartyMismatch(channelId, far.counterpartyChannelId || null),
      };
    }

    // Last proof: the far side's own connection must track the source chain.
    // Only checked when it resolves; an unresolvable client is not evidence of
    // a mismatch.
    if (far.connectionId) {
      const backChainId = await resolveConnectionChainId(client, far.connectionId, options);
      if (backChainId !== null && backChainId !== sourceChainId) {
        return {
          ...base,
          status: "mismatch",
          ok: false,
          message: messages.counterpartyMismatch(sourceChainId, backChainId),
        };
      }
    }

    return {
      ...base,
      status: "ok",
      ok: true,
      message: messages.counterpartyOk(chain.chainId),
    };
  }

  async function findIbcChannels(
    source: ChainRef,
    dest: ChainRef,
    options: ChannelQueryOptions = {},
  ): Promise<readonly IbcChannelOption[]> {
    const sourceChain = resolveChain(source);
    const destChainId = refChainId(dest);
    if (!sourceChain || !destChainId) return [];
    if (sourceChain.chainId === destChainId) return [];

    const client = clientFor(sourceChain);
    if (!client) return [];
    const portId = options.portId ?? TRANSFER_PORT;

    try {
      const rows = await listChannels(client, portId, options);
      const matches: IbcChannelOption[] = [];

      for (const row of rows) {
        assertNotAborted(options.signal, client.chainId);
        if (row.state !== "open") continue;
        if (!row.connectionId) continue;
        const counterpartyChainId = await resolveConnectionChainId(
          client,
          row.connectionId,
          options,
        );
        if (counterpartyChainId !== destChainId) continue;
        matches.push({
          channelId: row.channelId,
          portId: row.portId,
          counterpartyChannelId: row.counterpartyChannelId,
          counterpartyPortId: row.counterpartyPortId,
          connectionId: row.connectionId,
          counterpartyChainId,
          state: row.state,
        });
      }

      return matches.sort((a, b) =>
        a.channelId.localeCompare(b.channelId, undefined, { numeric: true }),
      );
    } catch (error) {
      if (isAborted(error)) throw error;
      // Live reads off is a settings state, and the three clients all render it
      // as "no channels found" plus their own prompt elsewhere in the screen.
      if (isReadsDisabled(error)) return [];
      throw error;
    }
  }

  async function validateIbcChannel(
    source: ChainRef,
    channelRaw: string,
    dest?: ChainRef,
    options: ChannelValidateOptions = {},
  ): Promise<IbcChannelValidation> {
    const portId = options.portId ?? TRANSFER_PORT;
    const channelId = normalizeChannelId(channelRaw);
    if (!channelId) {
      return {
        ok: false,
        state: "unknown",
        channelId: "",
        portId,
        message: messages.emptyInput,
      };
    }

    const sourceChain = resolveChain(source);
    const client = sourceChain ? clientFor(sourceChain) : null;
    if (!sourceChain || !client) {
      return {
        ok: false,
        state: "unknown",
        channelId,
        portId,
        message: messages.noEndpoint,
      };
    }

    let row: ParsedChannel | null;
    try {
      row = await readChannel(client, channelId, portId, options);
    } catch (error) {
      if (isAborted(error)) throw error;
      const message = isReadsDisabled(error)
        ? messages.readsDisabled
        : (() => {
            const status = httpStatusOf(error);
            // The gateway answers 404 for a channel the chain does not have,
            // which is a better message than "could not reach".
            return status !== undefined && ROUTE_ABSENT_STATUSES.has(status)
              ? messages.notFound
              : messages.unreachable;
          })();
      return { ok: false, state: "unknown", channelId, portId, message };
    }

    if (!row) {
      return {
        ok: false,
        state: "unknown",
        channelId,
        portId,
        message: messages.notFound,
      };
    }

    let counterpartyChainId: string | null = null;
    if (row.connectionId) {
      try {
        counterpartyChainId = await resolveConnectionChainId(client, row.connectionId, options);
      } catch (error) {
        if (isAborted(error)) throw error;
        // reads-disabled mid-check: report what we have rather than lying.
        counterpartyChainId = null;
      }
    }

    if (row.state !== "open") {
      return {
        ok: false,
        state: row.state,
        channelId,
        portId,
        counterpartyChannelId: row.counterpartyChannelId,
        counterpartyChainId,
        message: messages.notOpen(row.state),
      };
    }

    const destChainId = refChainId(dest);
    if (destChainId && counterpartyChainId && counterpartyChainId !== destChainId) {
      return {
        ok: false,
        state: row.state,
        channelId,
        portId,
        counterpartyChannelId: row.counterpartyChannelId,
        counterpartyChainId,
        message: messages.wrongChain(counterpartyChainId),
      };
    }

    const openResult: IbcChannelValidation = {
      ok: true,
      state: row.state,
      channelId,
      portId,
      counterpartyChannelId: row.counterpartyChannelId,
      counterpartyChainId,
      message: counterpartyChainId ? messages.openWith(counterpartyChainId) : messages.open,
    };

    if (options.checkCounterparty !== true) return openResult;

    const destChain = dest === undefined ? undefined : resolveChain(dest);
    const counterparty = await counterpartyCheck(
      sourceChain.chainId,
      channelId,
      portId,
      row.counterpartyChannelId,
      row.counterpartyPortId,
      counterpartyChainId,
      destChain,
      options,
    );

    // Only a definite negative overrides the source-side verdict. "unreachable"
    // and "skipped" mean nothing was learned, and blocking a send because the
    // destination's public LCD is down would be its own failure mode.
    const definiteFailure =
      counterparty.status === "not-found" ||
      counterparty.status === "not-open" ||
      counterparty.status === "mismatch";

    if (definiteFailure) {
      return { ...openResult, ok: false, message: counterparty.message, counterparty };
    }
    if (counterparty.status === "ok") {
      return { ...openResult, message: counterparty.message, counterparty };
    }
    return { ...openResult, counterparty };
  }

  async function checkCounterpartyChannel(
    source: ChainRef,
    option: IbcChannelOption,
    dest?: ChainRef,
    options: ChannelQueryOptions = {},
  ): Promise<CounterpartyCheck> {
    const sourceChain = resolveChain(source);
    if (!sourceChain) return skipped("the source chain is not in the registry", null);
    const destChain = dest === undefined ? undefined : resolveChain(dest);
    return counterpartyCheck(
      sourceChain.chainId,
      option.channelId,
      option.portId,
      option.counterpartyChannelId,
      option.counterpartyPortId,
      option.counterpartyChainId,
      destChain,
      options,
    );
  }

  /* ---------------------------------------------------------------------- *
   * Module probes
   * ---------------------------------------------------------------------- */

  /**
   * Try each candidate route until one answers with a `params` object.
   *
   * A 200 whose body has no `params` is treated as inconclusive rather than a
   * hit: a proxy that answers every path with `{}` would otherwise make every
   * chain look like it runs every module.
   */
  async function probeParams(
    client: LcdClient,
    paths: readonly string[],
    options: ChannelQueryOptions,
  ): Promise<ProbeOutcome> {
    let sawAbsent: string | null = null;
    let inconclusive: string | null = null;

    for (const path of paths) {
      assertNotAborted(options.signal, client.chainId);
      try {
        const body = await client.getJson(path, {
          signal: options.signal,
          cacheTtlMs: options.cacheTtlMs ?? channelTtlMs,
        });
        if (asRecord(asRecord(body)?.params)) return { kind: "hit", path };
        inconclusive = `${path} answered without a params object`;
      } catch (error) {
        if (isAborted(error)) throw error;
        if (isReadsDisabled(error)) return { kind: "reads-disabled" };
        const status = httpStatusOf(error);
        if (status !== undefined && ROUTE_ABSENT_STATUSES.has(status)) {
          sawAbsent = path;
          continue;
        }
        inconclusive =
          status === undefined
            ? `${path} could not be reached`
            : `${path} answered HTTP ${status}`;
      }
    }

    // "Absent" only when nothing muddied the picture: a single unreachable
    // route means the chain might still run the module.
    if (inconclusive === null && sawAbsent !== null) {
      return { kind: "absent", path: sawAbsent };
    }
    return { kind: "unknown", detail: inconclusive ?? "no probe route answered" };
  }

  function cacheSupport(value: ModuleSupport): ModuleSupport {
    const ttl = value.status === "unknown" ? supportUnknownTtlMs : supportTtlMs;
    supportCache.set(`${value.module}|${value.chainId}`, {
      value,
      expiresAt: now() + ttl,
    });
    return value;
  }

  function support(
    chainId: string,
    module: InterchainModule,
    status: ModuleSupportStatus,
    evidence: string,
  ): ModuleSupport {
    return {
      chainId,
      module,
      status,
      supported: status === "supported",
      evidence,
      checkedAt: now(),
    };
  }

  function overrideFor(chainId: string, module: InterchainModule): boolean | undefined {
    const row = config.moduleSupport?.[chainId];
    if (!row) return undefined;
    return module === "packet-forward" ? row.packetForward : row.ibcHooks;
  }

  async function detectModule(
    module: InterchainModule,
    ref: ChainRef,
    options: ChannelQueryOptions,
  ): Promise<ModuleSupport> {
    const chainId = refChainId(ref);
    const pinned = overrideFor(chainId, module);
    if (pinned !== undefined) {
      return support(
        chainId,
        module,
        pinned ? "supported" : "unsupported",
        "declared by the host",
      );
    }

    const cached = supportCache.get(`${module}|${chainId}`);
    if (cached && cached.expiresAt > now()) return cached.value;

    const chain = resolveChain(ref);
    if (!chain) {
      return support(chainId, module, "unknown", "chain is not in the registry");
    }
    const client = clientFor(chain);
    if (!client) {
      return support(chain.chainId, module, "unknown", "chain has no REST endpoint");
    }

    // ibc-hooks executes a CosmWasm contract from inside packet handling, so a
    // chain without wasm cannot run it. The registry flag settles that without
    // a request — when the flag is there at all; the catalog generator
    // currently drops `features`, so its absence proves nothing.
    if (
      module === "ibc-hooks" &&
      chain.features !== undefined &&
      !chain.features.includes("cosmwasm")
    ) {
      return cacheSupport(
        support(chain.chainId, module, "unsupported", "registry declares no cosmwasm feature"),
      );
    }

    const paths = module === "packet-forward" ? pfmPaths : hooksPaths;
    const probe = await probeParams(client, paths, options);

    if (probe.kind === "reads-disabled") {
      // Not cached: the answer flips the moment the user turns reads on.
      return support(chain.chainId, module, "unknown", "live reads are off");
    }

    if (probe.kind === "hit") {
      return cacheSupport(support(chain.chainId, module, "supported", `${probe.path} answered`));
    }

    if (module === "packet-forward") {
      if (probe.kind === "absent") {
        return cacheSupport(
          support(chain.chainId, module, "unsupported", `${probe.path} is not registered`),
        );
      }
      return cacheSupport(support(chain.chainId, module, "unknown", probe.detail));
    }

    // ibc-hooks fallback. No hooks route answered, which is normal even where
    // the middleware is installed, so fall back to wasm presence: its absence
    // rules the module out, its presence rules nothing in.
    const probeDetail =
      probe.kind === "absent" ? `${probe.path} is not registered` : probe.detail;
    const wasm = await probeWasm(client, options);
    if (wasm === "absent") {
      return cacheSupport(
        support(chain.chainId, module, "unsupported", "no CosmWasm module on this chain"),
      );
    }
    if (wasm === "present") {
      return cacheSupport(
        support(
          chain.chainId,
          module,
          "unknown",
          "CosmWasm is present but ibc-hooks exposes no query route",
        ),
      );
    }
    return cacheSupport(support(chain.chainId, module, "unknown", probeDetail));
  }

  async function probeWasm(
    client: LcdClient,
    options: ChannelQueryOptions,
  ): Promise<"present" | "absent" | "unknown"> {
    try {
      const body = await client.getJson(WASM_PROBE_PATH, {
        signal: options.signal,
        cacheTtlMs: options.cacheTtlMs ?? channelTtlMs,
        query: { "pagination.limit": 1 },
      });
      return Array.isArray(asRecord(body)?.code_infos) ? "present" : "unknown";
    } catch (error) {
      if (isAborted(error)) throw error;
      const status = httpStatusOf(error);
      if (status !== undefined && ROUTE_ABSENT_STATUSES.has(status)) return "absent";
      return "unknown";
    }
  }

  return {
    findIbcChannels,
    validateIbcChannel,
    checkCounterpartyChannel,
    detectPfmSupport: (chain, options = {}) => detectModule("packet-forward", chain, options),
    detectIbcHooksSupport: (chain, options = {}) => detectModule("ibc-hooks", chain, options),
    clearCache: () => {
      connectionCache.clear();
      supportCache.clear();
    },
  };
}
