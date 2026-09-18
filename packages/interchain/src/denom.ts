/**
 * Denom resolution and unwinding.
 *
 * This is the module that stops the wallet minting exotic double-wrapped IBC
 * denoms. Two facts drive everything here:
 *
 * 1. A voucher's trace path is written by the *receiving* chain: on delivery,
 *    the destination prepends its own `port/channel` to the denom. So the
 *    leftmost hop of `transfer/channel-0/transfer/channel-42` is the channel on
 *    the chain that currently holds the token, and the rightmost hop is the one
 *    closest to the origin.
 * 2. ICS20 only *burns* a voucher when the outgoing `port/channel` is the first
 *    hop of that token's own trace. Send it anywhere else and it is escrowed
 *    instead, and the receiver mints a brand new voucher whose trace is the old
 *    path with one more hop prepended — a different `ibc/…` hash that no
 *    registry names, no UI recognises and no pool prices.
 *
 * Unwinding therefore walks {@link ResolvedDenom.hops} left to right, which is
 * the token's own journey in reverse. See {@link unwindPath}.
 *
 * Nothing here signs or broadcasts. It reads the LCD through {@link LcdClient}
 * and returns plain data; the transaction is built elsewhere and signed by
 * zunia-core.
 */

import {
  InterchainError,
  TRANSFER_PORT,
  isInterchainError,
  type ChainInfoLike,
  type ChainRegistry,
  type DenomHop,
  type DenomTrace,
  type LcdClient,
  type LcdClientFactory,
  type LcdRequestOptions,
  type ResolvedDenom,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

/** Prefix every IBC voucher carries on the chain that holds it. */
const IBC_PREFIX = "ibc/";

/** Documented single-trace endpoint (see INTERCHAIN-SPEC §5). */
const DENOM_TRACES_PATH = "/ibc/apps/transfer/v1/denom_traces";
/**
 * ibc-go v9 renamed the query to `/denoms` and reshaped the body to
 * `{ denom: { base, trace: [{ port_id, channel_id }] } }`.
 *
 * TODO-VERIFY: not in INTERCHAIN-SPEC.md. It is only tried after the documented path answers
 * 404/501, and the parser tolerates it missing entirely. Treat as unverified.
 */
const DENOMS_PATH = "/ibc/apps/transfer/v1/denoms";

const HASH_PATTERN = /^[0-9a-fA-F]{64}$/;
const CHANNEL_PATTERN = /^channel-\d+$/;

/**
 * Traces are immutable: `ibc/HASH` is a pure function of `path` + `base_denom`,
 * so a hash can never mean something else later. Cache generously.
 */
const DEFAULT_TRACE_CACHE_TTL_MS = 10 * 60_000;

/** Page size for the trace list. LCDs cap this; 1000 is the usual ceiling. */
const DEFAULT_PAGE_LIMIT = 1000;
/** Hard stop, so a chain with tens of thousands of traces cannot hang a popup. */
const DEFAULT_MAX_PAGES = 10;
/**
 * Above this many unknown vouchers, one paginated sweep beats N point lookups.
 * Below it, the point lookups are smaller and cache individually.
 */
const DEFAULT_BULK_THRESHOLD = 12;
/** Ceiling on point lookups in one sweep, so a junk balance list cannot fan out. */
const DEFAULT_MAX_LOOKUPS = 32;

const encoder = /* @__PURE__ */ new TextEncoder();

/* -------------------------------------------------------------------------- *
 * Extra types owned by this module
 * -------------------------------------------------------------------------- */

/**
 * Resolves "which chain is on the other end of this channel?".
 *
 * Implemented by the channel module (connection -> client -> `chain_id`) and
 * injected, because denom resolution must not depend on a sibling feature
 * module. Implementations should resolve to `null` rather than throw when the
 * counterparty cannot be determined; a throw is caught and treated as `null`,
 * except `aborted`, which is a condition on the whole operation.
 *
 * An adapter over the channel service is one line:
 * `async (chainId, _port, channelId) =>
 *    (await channels.validateIbcChannel(chainId, channelId)).counterpartyChainId ?? null`
 */
export type ChannelCounterpartyLookup = (
  chainId: string,
  portId: string,
  channelId: string,
  options?: LcdRequestOptions,
) => Promise<string | null>;

/** Everything this module needs from the host. */
export interface DenomContext {
  /** Builds a read-only LCD client per chain. Never called with an unknown chain. */
  readonly lcd: LcdClientFactory;
  /** Chain lookup, used to turn a chain id into endpoints and denom metadata. */
  readonly registry: ChainRegistry;
  /**
   * Optional channel -> counterparty chain id lookup. Without it the origin
   * chain of a voucher cannot be proven and {@link ResolvedDenom.originChainId}
   * stays `null`.
   */
  readonly counterparty?: ChannelCounterpartyLookup;
  /** Override the trace cache TTL. Defaults to 10 minutes. */
  readonly traceCacheTtlMs?: number;
  /**
   * Let {@link recommendDenom} fall back to "which chain calls this its native
   * denom?" when no {@link counterparty} lookup is wired. Default `true`; the
   * guess is always reported through `originProvenance` and a warning, and is
   * only used when exactly one chain in the registry matches.
   */
  readonly inferOriginFromRegistry?: boolean;
}

/** How confident we are about {@link ResolvedDenom.originChainId}. */
export type OriginProvenance =
  /** The denom is native to the chain that holds it. */
  | "native"
  /** Every hop was walked through {@link ChannelCounterpartyLookup}. */
  | "channel-walk"
  /** Guessed from the registry because exactly one chain claims the base denom. */
  | "registry-guess"
  /** Not determined. Do not route on this. */
  | "unknown";

/**
 * A {@link ResolvedDenom} plus the context the base type has no room for.
 *
 * `ResolvedDenom` describes a denom but not *where* it was resolved, and
 * routing needs the chain ids behind each hop. Assignable to `ResolvedDenom`,
 * so callers that only need the contract type are unaffected.
 */
export interface ResolvedDenomOnChain extends ResolvedDenom {
  /** Chain the denom was resolved on, i.e. the chain that holds the balance. */
  readonly chainId: string;
  /**
   * Chain reached after each hop of {@link ResolvedDenom.hops}, same order and
   * length; `null` where the counterparty could not be resolved. The last entry
   * is the origin chain.
   */
  readonly hopChainIds: readonly (string | null)[];
  readonly originProvenance: OriginProvenance;
}

/** Knobs for {@link parseTracePath}. */
export interface ParseTracePathOptions {
  /**
   * Accept ports other than `transfer`. cw20-ics20 deployments use
   * `wasm.<contract>` as their port, so a real trace can contain one; it is
   * off by default because in every other case a non-`transfer` port means we
   * mis-split the path.
   */
  readonly allowNonTransferPorts?: boolean;
  /**
   * Accept channel identifiers that are not `channel-<n>`. ICS-24 permits
   * them; ibc-go has never generated one. Off by default for the same reason.
   */
  readonly allowNonStandardChannelIds?: boolean;
}

/** Options for {@link resolveDenom}. */
export interface ResolveDenomOptions
  extends LcdRequestOptions,
    ParseTracePathOptions {}

/** One leg of the walk back to a voucher's origin chain. */
export interface UnwindStep {
  /** Position in the walk, starting at 0. */
  readonly index: number;
  /** Port to send out on. */
  readonly port: string;
  /** Channel to send out on, on {@link fromChainId}. Using any other channel wraps instead of burns. */
  readonly channelId: string;
  /** Chain the hop leaves from; `null` when chain ids were never resolved. */
  readonly fromChainId: string | null;
  /** Chain the hop lands on; `null` when unresolved. */
  readonly toChainId: string | null;
  /** Denom as held on {@link fromChainId} before this hop. */
  readonly denom: string;
  /** Denom as it will appear once this hop lands. */
  readonly nextDenom: string;
  /** Trace path left after this hop; `""` once the token is home. */
  readonly nextPath: string;
  /** True when this hop puts the token back on its origin chain. */
  readonly landsOnOrigin: boolean;
}

/** What to do with a holding that is being sent to another chain. */
export type DenomStrategy =
  /** Send it as-is: it is native here, so the destination mints the first voucher. */
  | "direct"
  /** Send it back along its own trace; the destination is on that path. */
  | "unwind"
  /** Walk back to the origin chain first, then forward to the destination. */
  | "unwind-then-forward"
  /** The origin could not be determined; refuse to guess. */
  | "unknown";

/** Options for {@link recommendDenom}. */
export interface RecommendDenomOptions extends ResolveDenomOptions {
  /**
   * Channel on the *destination* chain that will receive the final hop.
   *
   * Needed to name the arriving denom: the receiver prepends its own
   * `port/channel`, so without it the wrapped hash cannot be computed and
   * {@link DenomRecommendation.outputDenom} is `null`. Comes from channel
   * discovery (`IbcChannelOption.counterpartyChannelId` as seen from the
   * sender), not from anything this module can read.
   */
  readonly destinationReceiveChannelId?: string;
  /** Port on the destination chain. Defaults to `transfer`. */
  readonly destinationReceivePort?: string;
}

/** The answer {@link recommendDenom} gives. */
export interface DenomRecommendation {
  readonly strategy: DenomStrategy;
  readonly sourceChainId: string;
  readonly destChainId: string;
  /** Denom as held on the source chain. */
  readonly inputDenom: string;
  /** Denom on its origin chain. Equals {@link inputDenom} when native. */
  readonly baseDenom: string;
  readonly originChainId: string | null;
  readonly originProvenance: OriginProvenance;
  /**
   * Denom the recipient ends up holding, or `null` when it cannot be named
   * without {@link RecommendDenomOptions.destinationReceiveChannelId}.
   */
  readonly outputDenom: string | null;
  /** Hops to walk before the final leg. Empty for `direct`. */
  readonly unwind: readonly UnwindStep[];
  /**
   * The channel the first transfer must leave on, when the strategy fixes it.
   * `null` for `direct`, where the router is free to pick any open channel.
   */
  readonly firstHop: DenomHop | null;
  /** Non-fatal notes for the UI, in the order they were raised. */
  readonly warnings: readonly string[];
  /** One sentence explaining the strategy. Developer-facing. */
  readonly reason: string;
}

/** One page of `/ibc/apps/transfer/v1/denom_traces`. */
export interface DenomTracePage {
  readonly traces: readonly DenomTrace[];
  /** `pagination.next_key`, or `null` on the last page. */
  readonly nextKey: string | null;
  /** `pagination.total` as a decimal string, when the endpoint reports it. */
  readonly total: string | null;
  /**
   * Rows dropped because they did not parse. A sweep is a best-effort read of
   * someone else's data: one broken row must not lose the other 999.
   */
  readonly skipped: number;
}

/** Options for {@link listDenomTraces}. */
export interface ListDenomTracesOptions extends LcdRequestOptions {
  /** Rows per page. Default 1000. */
  readonly pageLimit?: number;
  /** Maximum pages to walk. Default 10. */
  readonly maxPages?: number;
}

/** Options for {@link identifyDenoms}. */
export interface IdentifyDenomsOptions
  extends ResolveDenomOptions,
    ListDenomTracesOptions {
  /** Unknown-voucher count above which one paginated sweep is used. Default 12. */
  readonly bulkThreshold?: number;
  /** Ceiling on point lookups. Default 32. */
  readonly maxLookups?: number;
}

/** {@link DenomContext} bound into methods, for hosts that prefer an object. */
export interface DenomResolver {
  resolveDenom(
    chainId: string,
    denom: string,
    options?: ResolveDenomOptions,
  ): Promise<ResolvedDenomOnChain>;
  recommendDenom(
    fromChainId: string,
    toChainId: string,
    denom: string,
    options?: RecommendDenomOptions,
  ): Promise<DenomRecommendation>;
  listDenomTraces(
    chainId: string,
    options?: ListDenomTracesOptions,
  ): Promise<readonly DenomTrace[]>;
  identifyDenoms(
    chainId: string,
    denoms: readonly string[],
    options?: IdentifyDenomsOptions,
  ): Promise<ReadonlyMap<string, ResolvedDenomOnChain>>;
}

/* -------------------------------------------------------------------------- *
 * Small helpers
 * -------------------------------------------------------------------------- */

function malformed(message: string, chainId?: string): InterchainError {
  return new InterchainError(
    "malformed-response",
    message,
    chainId === undefined ? {} : { chainId },
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

/** Strip surrounding whitespace and slashes; `"transfer/channel-0/"` is not a new shape. */
function normalizePath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function requireChain(registry: ChainRegistry, chainId: string): ChainInfoLike {
  const chain = registry.get(chainId);
  if (!chain) {
    throw new InterchainError("unsupported-chain", `Unknown chain ${chainId}`, {
      chainId,
    });
  }
  return chain;
}

function clientFor(ctx: DenomContext, chainId: string): LcdClient {
  return ctx.lcd(requireChain(ctx.registry, chainId));
}

/* -------------------------------------------------------------------------- *
 * Hashing
 * -------------------------------------------------------------------------- */

function subtleCrypto(): typeof globalThis.crypto.subtle {
  const provider = globalThis.crypto;
  if (!provider || typeof provider.subtle?.digest !== "function") {
    // Every target has WebCrypto (MV3 worker, Node 22, Next server) except a
    // browser page served over plain http, which is not a secure context. That
    // is the host's deployment, not a problem with the chain, so it must not
    // read as `unsupported-chain`.
    throw new InterchainError(
      "unsupported-environment",
      "crypto.subtle is unavailable; ibc/ denom hashes cannot be computed",
    );
  }
  return provider.subtle;
}

async function sha256UpperHex(text: string): Promise<string> {
  const digest = await subtleCrypto().digest("SHA-256", encoder.encode(text));
  const bytes = new Uint8Array(digest);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out.toUpperCase();
}

/**
 * The uppercase hex SHA-256 of `path/baseDenom` — the part after `ibc/`.
 *
 * This is ibc-go's `DenomTrace.Hash()`: the voucher denom is the hash of the
 * full denom path, so a token that has travelled a different route is a
 * different denom even when the base denom matches.
 *
 * @param path - Slash-joined `port/channel` pairs, outermost hop first. `""`
 *   for a denom with no hops, which hashes the base denom alone.
 * @param baseDenom - The denom on its origin chain, e.g. `uatom`.
 * @throws {@link InterchainError} `malformed-response` when `baseDenom` is empty.
 */
export async function ibcDenomHashHex(
  path: string,
  baseDenom: string,
): Promise<string> {
  const base = baseDenom.trim();
  if (base === "") throw malformed("Cannot hash an empty base denom");
  const prefix = normalizePath(path);
  return sha256UpperHex(prefix === "" ? base : `${prefix}/${base}`);
}

/**
 * The full voucher denom, `ibc/` + {@link ibcDenomHashHex}.
 *
 * Use this to name a token *before* it moves: given the channel that will
 * receive it, the arriving denom is known without asking the destination.
 */
export async function ibcDenomHash(
  path: string,
  baseDenom: string,
): Promise<string> {
  return `${IBC_PREFIX}${await ibcDenomHashHex(path, baseDenom)}`;
}

/** True when `denom` is an IBC voucher, i.e. starts with `ibc/`. */
export function isIbcDenom(denom: string): boolean {
  return denom.trim().startsWith(IBC_PREFIX);
}

/**
 * The uppercase hash inside an `ibc/…` denom, or `null` when `denom` is native.
 *
 * @throws {@link InterchainError} `malformed-response` when the denom carries
 *   the `ibc/` prefix but not 64 hex characters — that is a corrupt balance
 *   row, not a native denom, and silently treating it as native would hide it.
 */
export function ibcHashFromDenom(denom: string): string | null {
  const trimmed = denom.trim();
  if (!trimmed.startsWith(IBC_PREFIX)) return null;
  const hash = trimmed.slice(IBC_PREFIX.length);
  if (!HASH_PATTERN.test(hash)) {
    throw malformed(`"${denom}" is not a 64-character ibc/ hash`);
  }
  // LCDs accept either case; ours is canonical uppercase so hashes compare.
  return hash.toUpperCase();
}

/* -------------------------------------------------------------------------- *
 * Trace paths
 * -------------------------------------------------------------------------- */

/**
 * Split a trace path into ordered hops.
 *
 * `"transfer/channel-0/transfer/channel-42"` becomes two hops, outermost
 * first — `channel-0` is on the chain holding the token.
 *
 * Malformed input is rejected rather than repaired: an odd segment count, an
 * empty segment, a port that is not `transfer` or a channel that is not
 * `channel-<n>` all mean the path is not what we think it is, and guessing here
 * produces a wrong `ibc/` hash further down. Both strict checks can be relaxed
 * through {@link ParseTracePathOptions} for the cw20-ics20 case.
 *
 * @throws {@link InterchainError} `malformed-response`.
 */
export function parseTracePath(
  path: string,
  options: ParseTracePathOptions = {},
): readonly DenomHop[] {
  const normalized = normalizePath(path);
  if (normalized === "") return [];

  const segments = normalized.split("/");
  if (segments.length % 2 !== 0) {
    throw malformed(
      `Trace path "${path}" has ${segments.length} segments; ports and channels come in pairs`,
    );
  }

  const hops: DenomHop[] = [];
  for (let i = 0; i < segments.length; i += 2) {
    const port = segments[i] ?? "";
    const channelId = segments[i + 1] ?? "";
    if (port === "" || channelId === "") {
      throw malformed(`Trace path "${path}" has an empty segment`);
    }
    if (port !== TRANSFER_PORT && options.allowNonTransferPorts !== true) {
      throw malformed(`Trace path "${path}" uses port "${port}", not "transfer"`);
    }
    if (
      !CHANNEL_PATTERN.test(channelId) &&
      options.allowNonStandardChannelIds !== true
    ) {
      throw malformed(
        `Trace path "${path}" has "${channelId}" where a channel-<n> was expected`,
      );
    }
    hops.push({ port, channelId });
  }
  return hops;
}

/** Join hops back into a trace path. Inverse of {@link parseTracePath}. */
export function joinTracePath(hops: readonly DenomHop[]): string {
  return hops.map((hop) => `${hop.port}/${hop.channelId}`).join("/");
}

/* -------------------------------------------------------------------------- *
 * Response parsers
 * -------------------------------------------------------------------------- */

/**
 * Normalise one denom trace out of an LCD body.
 *
 * Three shapes are accepted:
 * - `{ "denom_trace": { "path": …, "base_denom": … } }` — the documented one.
 * - `{ "path": …, "base_denom": … }` — bare, as some gateways unwrap it.
 * - `{ "denom": { "base": …, "trace": [{ "port_id": …, "channel_id": … }] } }` —
 *   ibc-go v9's `/denoms` shape. NOT in the verified spec; tolerated because
 *   the fallback endpoint returns it, and ignored when absent.
 *
 * Extra keys are ignored throughout.
 *
 * @throws {@link InterchainError} `malformed-response` when no shape matches or
 *   the base denom is missing — an endpoint that answers "I don't know this
 *   hash" with an empty body must not be mistaken for a native denom.
 */
export function parseDenomTrace(body: unknown): DenomTrace {
  const root = asRecord(body);
  if (!root) throw malformed("Denom trace response is not a JSON object");

  const wrapped = asRecord(root["denom_trace"]);
  const flat = wrapped ?? (root["base_denom"] !== undefined ? root : null);
  if (flat) {
    const baseDenom = (readString(flat, "base_denom") ?? "").trim();
    if (baseDenom === "") {
      throw malformed("Denom trace has no base_denom");
    }
    const rawPath = flat["path"];
    if (rawPath !== undefined && typeof rawPath !== "string") {
      throw malformed("Denom trace path is not a string");
    }
    return { path: normalizePath(rawPath ?? ""), baseDenom };
  }

  const v9 = asRecord(root["denom"]);
  if (v9) {
    const baseDenom = (readString(v9, "base") ?? "").trim();
    if (baseDenom === "") throw malformed("Denom trace has no base");
    const rawTrace = v9["trace"];
    const hops: DenomHop[] = [];
    if (Array.isArray(rawTrace)) {
      for (const entry of rawTrace) {
        const hop = asRecord(entry);
        const port = hop ? readString(hop, "port_id") : null;
        const channelId = hop ? readString(hop, "channel_id") : null;
        if (!port || !channelId) throw malformed("Denom trace hop is incomplete");
        hops.push({ port, channelId });
      }
    } else if (rawTrace !== undefined && rawTrace !== null) {
      throw malformed("Denom trace `trace` is not an array");
    }
    return { path: joinTracePath(hops), baseDenom };
  }

  throw malformed("Denom trace response has no denom_trace, path or denom key");
}

/**
 * Parse one page of the paginated trace list.
 *
 * Accepts the documented `denom_traces` array and, defensively, ibc-go v9's
 * `denoms` array. Rows that do not parse are counted in
 * {@link DenomTracePage.skipped} rather than thrown, because this list is used
 * for a best-effort sweep over a user's holdings and one bad row must not lose
 * the page.
 *
 * @throws {@link InterchainError} `malformed-response` only when the envelope
 *   itself is wrong (not an object, or no array of rows at all).
 */
export function parseDenomTracesPage(body: unknown): DenomTracePage {
  const root = asRecord(body);
  if (!root) throw malformed("Denom trace list is not a JSON object");

  const rows = root["denom_traces"] ?? root["denoms"];
  if (!Array.isArray(rows)) {
    throw malformed("Denom trace list has no denom_traces array");
  }

  const traces: DenomTrace[] = [];
  let skipped = 0;
  for (const row of rows) {
    try {
      // Each row is the inner object, so it is parsed bare; the v9 rows carry
      // `base`/`trace` and are handled by wrapping them the way the single
      // query returns them.
      const record = asRecord(row);
      if (!record) {
        skipped += 1;
        continue;
      }
      traces.push(
        parseDenomTrace(
          record["base_denom"] !== undefined || record["path"] !== undefined
            ? record
            : { denom: record },
        ),
      );
    } catch {
      skipped += 1;
    }
  }

  const pagination = asRecord(root["pagination"]);
  const rawNext = pagination ? readString(pagination, "next_key") : null;
  const rawTotal = pagination ? readString(pagination, "total") : null;

  return {
    traces,
    nextKey: rawNext === null || rawNext === "" ? null : rawNext,
    total: rawTotal === null || rawTotal === "" ? null : rawTotal,
    skipped,
  };
}

/* -------------------------------------------------------------------------- *
 * Resolution
 * -------------------------------------------------------------------------- */

function nativeResult(chainId: string, denom: string): ResolvedDenomOnChain {
  return {
    denom,
    baseDenom: denom,
    path: "",
    hops: [],
    originChainId: chainId,
    isNative: true,
    ibcHash: null,
    chainId,
    hopChainIds: [],
    originProvenance: "native",
  };
}

async function fetchTrace(
  ctx: DenomContext,
  chainId: string,
  hash: string,
  options: LcdRequestOptions,
): Promise<DenomTrace> {
  const client = clientFor(ctx, chainId);
  const request: LcdRequestOptions = {
    ...options,
    cacheTtlMs: options.cacheTtlMs ?? ctx.traceCacheTtlMs ?? DEFAULT_TRACE_CACHE_TTL_MS,
  };
  try {
    return parseDenomTrace(await client.getJson(`${DENOM_TRACES_PATH}/${hash}`, request));
  } catch (error) {
    // ibc-go v9 dropped the endpoint. Retry once on the newer path before
    // reporting failure; anything else (timeout, 5xx, bad JSON) is the caller's
    // problem and is rethrown untouched.
    const gone =
      isInterchainError(error) &&
      (error.httpStatus === 404 || error.httpStatus === 501);
    if (!gone) throw error;
    try {
      return parseDenomTrace(await client.getJson(`${DENOMS_PATH}/${hash}`, request));
    } catch {
      throw error;
    }
  }
}

async function walkHopChains(
  ctx: DenomContext,
  chainId: string,
  hops: readonly DenomHop[],
  options: LcdRequestOptions,
): Promise<readonly (string | null)[]> {
  const lookup = ctx.counterparty;
  if (!lookup || hops.length === 0) return hops.map(() => null);

  const out: (string | null)[] = [];
  let current: string | null = chainId;
  for (const hop of hops) {
    if (current === null) {
      out.push(null);
      continue;
    }
    let next: string | null = null;
    try {
      next = await lookup(current, hop.port, hop.channelId, options);
    } catch (error) {
      // A cancelled request is a global condition, not a missing counterparty.
      if (isInterchainError(error) && error.code === "aborted") throw error;
      next = null;
    }
    out.push(next);
    current = next;
  }
  return out;
}

/**
 * Resolve what a denom actually is on the chain that holds it.
 *
 * A native denom is returned as-is without a network call. An `ibc/…` voucher
 * is looked up through `/ibc/apps/transfer/v1/denom_traces/{hash}` and the
 * trace is verified to hash back to the requested denom, because the endpoint
 * is a stranger's node and a trace we did not check could rename a token.
 *
 * {@link ResolvedDenomOnChain.originChainId} is filled only when
 * {@link DenomContext.counterparty} is wired and every hop resolves; otherwise
 * it stays `null` rather than being guessed.
 *
 * @throws {@link InterchainError} `unsupported-chain` when the chain is unknown,
 *   `malformed-response` when the denom or the trace does not parse, plus
 *   anything {@link LcdClient.getJson} throws.
 */
export async function resolveDenom(
  ctx: DenomContext,
  chainId: string,
  denom: string,
  options: ResolveDenomOptions = {},
): Promise<ResolvedDenomOnChain> {
  // Validated up front even for a native denom: the result claims this chain
  // holds the token, and a chain the registry has never heard of cannot.
  requireChain(ctx.registry, chainId);

  const trimmed = denom.trim();
  if (trimmed === "") throw malformed("Cannot resolve an empty denom", chainId);

  const hash = ibcHashFromDenom(trimmed);
  if (hash === null) return nativeResult(chainId, trimmed);

  const trace = await fetchTrace(ctx, chainId, hash, options);

  const recomputed = await ibcDenomHashHex(trace.path, trace.baseDenom);
  if (recomputed !== hash) {
    throw malformed(
      `Denom trace for ${trimmed} hashes to ${recomputed}; the endpoint answered with a different token`,
      chainId,
    );
  }

  const hops = parseTracePath(trace.path, options);
  const hopChainIds = await walkHopChains(ctx, chainId, hops, options);
  const last = hopChainIds.length === 0 ? null : hopChainIds[hopChainIds.length - 1] ?? null;
  const originChainId = hops.length === 0 ? chainId : last;

  return {
    denom: trimmed,
    baseDenom: trace.baseDenom,
    path: trace.path,
    hops,
    originChainId,
    // The chain holds a voucher, so the token is not native here even in the
    // degenerate empty-path case.
    isNative: false,
    ibcHash: hash,
    chainId,
    hopChainIds,
    originProvenance: originChainId === null ? "unknown" : "channel-walk",
  };
}

/* -------------------------------------------------------------------------- *
 * Unwinding
 * -------------------------------------------------------------------------- */

function hopChainIdsOf(resolved: ResolvedDenom): readonly (string | null)[] {
  const extra = resolved as Partial<ResolvedDenomOnChain>;
  const rows = extra.hopChainIds;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => (typeof row === "string" ? row : null));
}

function chainIdOf(resolved: ResolvedDenom): string | null {
  const extra = resolved as Partial<ResolvedDenomOnChain>;
  return typeof extra.chainId === "string" ? extra.chainId : null;
}

/**
 * The ordered hops that walk a voucher back to its origin chain.
 *
 * The walk follows {@link ResolvedDenom.hops} left to right, which is the
 * token's own journey in reverse: hop 0 is the channel on the chain holding the
 * token, and sending out of exactly that channel burns the voucher instead of
 * wrapping it again. Each step also names the denom before and after the hop,
 * so a UI can show "ibc/27394F… -> uatom" without a second round trip.
 *
 * Returns an empty array for a native denom.
 *
 * `fromChainId` / `toChainId` are populated only when the argument came from
 * {@link resolveDenom} with a counterparty lookup wired; otherwise they are
 * `null` and the denoms are still exact.
 */
export async function unwindPath(
  resolved: ResolvedDenom,
): Promise<readonly UnwindStep[]> {
  const hops = resolved.hops;
  if (hops.length === 0) return [];

  const chainIds = hopChainIdsOf(resolved);
  const holder = chainIdOf(resolved);
  const steps: UnwindStep[] = [];

  let denom = resolved.denom;
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    if (!hop) continue;
    const nextPath = joinTracePath(hops.slice(i + 1));
    const nextDenom =
      nextPath === "" ? resolved.baseDenom : await ibcDenomHash(nextPath, resolved.baseDenom);
    steps.push({
      index: i,
      port: hop.port,
      channelId: hop.channelId,
      fromChainId: i === 0 ? holder : chainIds[i - 1] ?? null,
      toChainId: chainIds[i] ?? null,
      denom,
      nextDenom,
      nextPath,
      landsOnOrigin: i === hops.length - 1,
    });
    denom = nextDenom;
  }
  return steps;
}

/* -------------------------------------------------------------------------- *
 * Recommendation
 * -------------------------------------------------------------------------- */

/**
 * Chains that call `baseDenom` their native token.
 *
 * A weak signal — base denoms are not unique across a 332-chain registry and
 * plenty of tokens are not a chain's staking denom — so callers must treat a
 * multi-element result as "unknown" rather than picking the first.
 */
export function originCandidates(
  registry: ChainRegistry,
  baseDenom: string,
): readonly ChainInfoLike[] {
  return registry.list().filter((chain) => chain.coinMinimalDenom === baseDenom);
}

/**
 * Decide how to move a holding to another chain, and name the denom it will
 * arrive as.
 *
 * The rule, and why it exists:
 *
 * - **native here** -> send it directly. The destination mints the first
 *   voucher, whose hash is `SHA256("transfer/<destChannel>/<denom>")`.
 * - **wrapped, and the destination is on its trace** -> send it back along that
 *   trace. The voucher is burned hop by hop and the recipient gets the denom
 *   that chain already knows, `uatom` on the Hub rather than a fresh hash.
 * - **wrapped, destination elsewhere** -> unwind to the origin chain first,
 *   then forward. Sending a wrapped token onward without unwinding does not
 *   fail; it quietly succeeds and mints a *new* double-wrapped `ibc/` denom
 *   whose hash no registry names, no wallet can label and no pool prices. The
 *   user is left holding something that looks like dust.
 * - **origin unknown** -> `unknown`. Refusing is better than a wrong guess,
 *   because the wrong guess is the failure mode above.
 *
 * @throws {@link InterchainError} `unsupported-chain` when either chain is
 *   unknown, plus anything {@link resolveDenom} throws.
 */
export async function recommendDenom(
  ctx: DenomContext,
  fromChainId: string,
  toChainId: string,
  denom: string,
  options: RecommendDenomOptions = {},
): Promise<DenomRecommendation> {
  requireChain(ctx.registry, fromChainId);
  const dest = requireChain(ctx.registry, toChainId);

  const resolved = await resolveDenom(ctx, fromChainId, denom, options);
  const warnings: string[] = [];

  const destPort = options.destinationReceivePort ?? TRANSFER_PORT;
  const destChannel = options.destinationReceiveChannelId;
  const wrapOnArrival = async (sent: string): Promise<string | null> => {
    if (!destChannel) {
      warnings.push(
        `Destination denom is unknown until a receiving channel on ${toChainId} is chosen.`,
      );
      return null;
    }
    return ibcDenomHash(`${destPort}/${destChannel}`, sent);
  };

  const base = {
    sourceChainId: fromChainId,
    destChainId: toChainId,
    inputDenom: resolved.denom,
    baseDenom: resolved.baseDenom,
  } as const;

  if (fromChainId === toChainId) {
    return {
      ...base,
      strategy: "direct",
      originChainId: resolved.originChainId,
      originProvenance: resolved.originProvenance,
      outputDenom: resolved.denom,
      unwind: [],
      firstHop: null,
      warnings,
      reason: "Source and destination are the same chain; nothing moves.",
    };
  }

  if (resolved.isNative) {
    return {
      ...base,
      strategy: "direct",
      originChainId: fromChainId,
      originProvenance: "native",
      outputDenom: await wrapOnArrival(resolved.denom),
      unwind: [],
      firstHop: null,
      warnings,
      reason: `${resolved.denom} is native to ${fromChainId}; ${toChainId} mints the first voucher.`,
    };
  }

  const steps = await unwindPath(resolved);

  // Does the walk pass through the destination? If so we stop there: the
  // partially unwound denom is exactly what that chain already holds.
  const landing = steps.findIndex((step) => step.toChainId === toChainId);
  if (landing >= 0) {
    const step = steps[landing];
    const truncated = steps.slice(0, landing + 1);
    const first = resolved.hops[0] ?? null;
    return {
      ...base,
      strategy: "unwind",
      originChainId: resolved.originChainId,
      originProvenance: resolved.originProvenance,
      outputDenom: step ? step.nextDenom : null,
      unwind: truncated,
      firstHop: first,
      warnings,
      reason:
        truncated.length === 1
          ? `${resolved.denom} came from ${toChainId} over ${truncated[0]?.channelId}; sending it back there burns the voucher.`
          : `${resolved.denom} unwinds to ${toChainId} in ${truncated.length} hops along its own trace.`,
    };
  }

  // No channel data, or the walk never reached the destination. Fall back to
  // the registry: if exactly one chain calls this base denom its own, treat it
  // as the origin but say so.
  let originChainId = resolved.originChainId;
  let originProvenance = resolved.originProvenance;
  if (originChainId === null && ctx.inferOriginFromRegistry !== false) {
    const candidates = originCandidates(ctx.registry, resolved.baseDenom);
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only) {
      originChainId = only.chainId;
      originProvenance = "registry-guess";
      warnings.push(
        `Origin chain inferred from the registry: ${only.chainName} is the only chain whose native denom is ${resolved.baseDenom}.`,
      );
    }
  }

  if (originChainId === null) {
    warnings.push(
      `Could not determine where ${resolved.denom} came from; sending it on would mint a denom nothing recognises.`,
    );
    return {
      ...base,
      strategy: "unknown",
      originChainId: null,
      originProvenance: "unknown",
      outputDenom: null,
      unwind: steps,
      firstHop: resolved.hops[0] ?? null,
      warnings,
      reason: `The origin chain of ${resolved.denom} is unknown; refusing to guess a route.`,
    };
  }

  if (originChainId === toChainId) {
    const first = resolved.hops[0] ?? null;
    return {
      ...base,
      strategy: "unwind",
      originChainId,
      originProvenance,
      outputDenom: resolved.baseDenom,
      unwind: steps,
      firstHop: first,
      warnings,
      reason: `${toChainId} is the origin of ${resolved.baseDenom}; unwind along the trace and it arrives unwrapped.`,
    };
  }

  warnings.push(
    `Sending ${resolved.denom} straight to ${dest.chainName} would mint a new double-wrapped denom; the plan unwinds through ${originChainId} first.`,
  );
  return {
    ...base,
    strategy: "unwind-then-forward",
    originChainId,
    originProvenance,
    outputDenom: await wrapOnArrival(resolved.baseDenom),
    unwind: steps,
    firstHop: resolved.hops[0] ?? null,
    warnings,
    reason: `${resolved.denom} unwinds to ${originChainId}, then forwards to ${toChainId}.`,
  };
}

/* -------------------------------------------------------------------------- *
 * Sweeps
 * -------------------------------------------------------------------------- */

/**
 * Walk `/ibc/apps/transfer/v1/denom_traces` and return every trace it lists.
 *
 * Bounded by {@link ListDenomTracesOptions.maxPages}: a hub chain publishes
 * tens of thousands of traces and a wallet popup must not walk them all.
 */
export async function listDenomTraces(
  ctx: DenomContext,
  chainId: string,
  options: ListDenomTracesOptions = {},
): Promise<readonly DenomTrace[]> {
  const client = clientFor(ctx, chainId);
  const limit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const out: DenomTrace[] = [];
  let key: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const body = await client.getJson(DENOM_TRACES_PATH, {
      ...options,
      cacheTtlMs:
        options.cacheTtlMs ?? ctx.traceCacheTtlMs ?? DEFAULT_TRACE_CACHE_TTL_MS,
      query: {
        ...options.query,
        "pagination.limit": limit,
        "pagination.key": key,
      },
    });
    const parsed = parseDenomTracesPage(body);
    out.push(...parsed.traces);
    if (parsed.nextKey === null) break;
    key = parsed.nextKey;
  }
  return out;
}

/**
 * Index traces by the voucher denom they produce.
 *
 * The map is keyed `ibc/HASH`, so a balance row can be looked up directly. This
 * is the only direction that works: the hash is one-way, so identifying an
 * unknown voucher means hashing every trace and comparing.
 */
export async function indexDenomTraces(
  traces: readonly DenomTrace[],
): Promise<ReadonlyMap<string, DenomTrace>> {
  const index = new Map<string, DenomTrace>();
  for (const trace of traces) {
    try {
      index.set(await ibcDenomHash(trace.path, trace.baseDenom), trace);
    } catch {
      // A trace we cannot hash is a row we cannot match; skip it.
    }
  }
  return index;
}

/**
 * Work out what each of a user's holdings actually is.
 *
 * The lost-denom problem: a balance sheet full of `ibc/1A2B…` rows tells the
 * user nothing, and one of them may be a double-wrapped token they can no
 * longer trade. This resolves the lot in one pass.
 *
 * Below {@link IdentifyDenomsOptions.bulkThreshold} unknown vouchers it makes
 * one point lookup each, which are small and cache individually; above it, it
 * takes the paginated list once and matches by hash. Denoms that cannot be
 * resolved are simply absent from the result — a missing key means "unknown",
 * which is exactly what the UI should say. `aborted` and `reads-disabled`
 * propagate, because they are conditions on the whole sweep, not on one row.
 */
export async function identifyDenoms(
  ctx: DenomContext,
  chainId: string,
  denoms: readonly string[],
  options: IdentifyDenomsOptions = {},
): Promise<ReadonlyMap<string, ResolvedDenomOnChain>> {
  requireChain(ctx.registry, chainId);

  const out = new Map<string, ResolvedDenomOnChain>();
  const wanted = new Map<string, string>(); // hash -> denom as given

  for (const raw of denoms) {
    const denom = raw.trim();
    if (denom === "" || out.has(denom)) continue;
    let hash: string | null;
    try {
      hash = ibcHashFromDenom(denom);
    } catch {
      // A malformed ibc/ row is left unidentified rather than failing the sweep.
      continue;
    }
    if (hash === null) {
      out.set(denom, nativeResult(chainId, denom));
      continue;
    }
    wanted.set(hash, denom);
  }
  if (wanted.size === 0) return out;

  const bulkThreshold = options.bulkThreshold ?? DEFAULT_BULK_THRESHOLD;
  if (wanted.size > bulkThreshold) {
    const traces = await listDenomTraces(ctx, chainId, options);
    for (const trace of traces) {
      let hash: string;
      try {
        hash = await ibcDenomHashHex(trace.path, trace.baseDenom);
      } catch {
        continue;
      }
      const denom = wanted.get(hash);
      if (denom === undefined) continue;
      wanted.delete(hash);
      let hops: readonly DenomHop[];
      try {
        hops = parseTracePath(trace.path, options);
      } catch {
        continue;
      }
      const hopChainIds = await walkHopChains(ctx, chainId, hops, options);
      const last =
        hopChainIds.length === 0 ? null : hopChainIds[hopChainIds.length - 1] ?? null;
      out.set(denom, {
        denom,
        baseDenom: trace.baseDenom,
        path: trace.path,
        hops,
        originChainId: hops.length === 0 ? chainId : last,
        isNative: false,
        ibcHash: hash,
        chainId,
        hopChainIds,
        originProvenance: last === null && hops.length > 0 ? "unknown" : "channel-walk",
      });
    }
  }

  const maxLookups = options.maxLookups ?? DEFAULT_MAX_LOOKUPS;
  let lookups = 0;
  for (const denom of wanted.values()) {
    if (lookups >= maxLookups) break;
    lookups += 1;
    try {
      out.set(denom, await resolveDenom(ctx, chainId, denom, options));
    } catch (error) {
      if (
        isInterchainError(error) &&
        (error.code === "aborted" || error.code === "reads-disabled")
      ) {
        throw error;
      }
      // Anything else is one unidentifiable row; the rest of the sweep stands.
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Bound resolver
 * -------------------------------------------------------------------------- */

/**
 * Bind a {@link DenomContext} into an object, for hosts that would rather hold
 * a resolver than thread the context through every call.
 */
export function createDenomResolver(ctx: DenomContext): DenomResolver {
  return {
    resolveDenom: (chainId, denom, options) => resolveDenom(ctx, chainId, denom, options),
    recommendDenom: (fromChainId, toChainId, denom, options) =>
      recommendDenom(ctx, fromChainId, toChainId, denom, options),
    listDenomTraces: (chainId, options) => listDenomTraces(ctx, chainId, options),
    identifyDenoms: (chainId, denoms, options) =>
      identifyDenoms(ctx, chainId, denoms, options),
  };
}
