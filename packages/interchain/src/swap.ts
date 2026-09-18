/**
 * Osmosis swap quoting.
 *
 * Two venues, both operated by Osmosis itself — no third-party aggregator:
 *
 * 1. The **sidecar query server** (SQS) router, `https://sqs.osmosis.zone`.
 *    It is the same router the Osmosis frontend uses: it knows every pool,
 *    splits an order across routes, and reports price impact and the effective
 *    fee separately. Prefer it whenever the host is willing to talk to it.
 * 2. The chain's own **poolmanager** REST module, for a known route. It answers
 *    one pool at a time, so a multi-hop quote is a chain of single-pool
 *    estimates. Slower and less accurate on splits, but it is the chain.
 *
 * The SQS router is a different host from the chain's LCD, so it arrives as its
 * own {@link LcdClient} in {@link OsmosisSwapQuoteParams.router}. Everything
 * here goes through that interface; this module never calls `fetch`.
 *
 * This module quotes. It never holds a key and never signs — the quote feeds
 * the XCS memo builder and, eventually, zunia-core, which does the signing.
 *
 * ## Endpoint verification
 *
 * Every path in {@link OSMOSIS_SWAP_PATHS} was called against
 * `https://lcd.osmosis.zone` and `https://sqs.osmosis.zone` on 2026-09-06 and
 * the response shapes below are what came back. Two results are worth knowing
 * before changing anything:
 *
 * - `/osmosis/poolmanager/v1beta1/params` (lowercase) answers HTTP 501
 *   `{"code":12,"message":"Not Implemented"}`. The working spelling is
 *   `/Params`, capitalised. This is a gRPC-gateway quirk, not a typo.
 * - `EstimateSwapExactAmountIn`
 *   (`/osmosis/poolmanager/v1beta1/{pool_id}/estimate/swap_exact_amount_in`)
 *   **cannot be called over REST at all**: `routes` is a repeated message and
 *   the gateway rejects every query-string spelling of it
 *   (`{"code":3,"message":"unexpected repeated field in routes.pool_id"}`).
 *   That is why multi-hop quoting chains `single_pool_swap_exact_amount_in`
 *   rather than issuing one call.
 *
 * Paths are constants rather than inline literals so a host running a node with
 * a different gateway prefix can override them; see
 * {@link OsmosisSwapQuoteParams.paths}.
 */

import type { XcsSlippage } from "./memo.js";
import {
  InterchainError,
  isInterchainError,
  type LcdClient,
  type LcdRequestOptions,
  type SwapPoolHop,
  type SwapQuote,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Configuration
 * -------------------------------------------------------------------------- */

/**
 * REST paths this module calls.
 *
 * `{pool_id}` is the only placeholder; it is replaced with a URL-encoded pool
 * id. The `router*` entries are paths on the SQS host, not on the chain's LCD.
 */
export interface OsmosisSwapPaths {
  /**
   * Poolmanager module params.
   *
   * TODO-VERIFY on a node upgrade: the capitalised spelling
   * `https://lcd.osmosis.zone/osmosis/poolmanager/v1beta1/Params` is the one
   * that works today; the lowercase `/params` answers HTTP 501.
   */
  readonly params: string;
  /** `GET https://lcd.osmosis.zone/osmosis/poolmanager/v1beta1/pools/{pool_id}` */
  readonly pool: string;
  /**
   * `GET .../pools/{pool_id}/total_pool_liquidity`.
   *
   * The only pool query that answers the same shape for every pool type
   * (balancer, stableswap, concentrated, cosmwasm), so denom membership is
   * read from here rather than from the pool document.
   */
  readonly totalPoolLiquidity: string;
  /**
   * `GET .../{pool_id}/estimate/single_pool_swap_exact_amount_in`
   * `?token_in=<amount><denom>&token_out_denom=<denom>` →
   * `{"token_out_amount":"22411"}`.
   */
  readonly estimateSinglePoolSwapExactAmountIn: string;
  /**
   * `GET /osmosis/poolmanager/v2/pools/{pool_id}/prices`
   * `?base_asset_denom=<in>&quote_asset_denom=<out>` → `{"spot_price":"0.0226…"}`.
   *
   * v2, not v1beta1: the v1beta1 spelling answers HTTP 501. Empirically the
   * value is "quote per base", i.e. output units per input unit when base is
   * the token going in — which matches SQS's `in_base_out_quote_spot_price`.
   */
  readonly spotPrice: string;
  /**
   * `GET .../trading_pair_takerfee?denom_0=<a>&denom_1=<b>` →
   * `{"taker_fee":"0.008000000000000000"}`. A fraction, not a percentage.
   */
  readonly tradingPairTakerFee: string;
  /** SQS: `GET /router/quote?tokenIn=<amount><denom>&tokenOutDenom=<denom>`. */
  readonly routerQuote: string;
  /** SQS: `GET /router/routes?tokenIn=<denom>&tokenOutDenom=<denom>`. */
  readonly routerRoutes: string;
  /**
   * SQS: `GET /router/custom-direct-quote?tokenIn=<amount><denom>`
   * `&tokenOutDenom=<denom>[,<denom>…]&poolID=<id>[,<id>…]`.
   *
   * Quotes one caller-chosen route. The two lists are positional and must have
   * the same length.
   */
  readonly routerCustomDirectQuote: string;
}

/** Default paths. Verified 2026-09-06; see the module header. */
export const OSMOSIS_SWAP_PATHS: OsmosisSwapPaths = {
  params: "/osmosis/poolmanager/v1beta1/Params",
  pool: "/osmosis/poolmanager/v1beta1/pools/{pool_id}",
  totalPoolLiquidity:
    "/osmosis/poolmanager/v1beta1/pools/{pool_id}/total_pool_liquidity",
  estimateSinglePoolSwapExactAmountIn:
    "/osmosis/poolmanager/v1beta1/{pool_id}/estimate/single_pool_swap_exact_amount_in",
  spotPrice: "/osmosis/poolmanager/v2/pools/{pool_id}/prices",
  tradingPairTakerFee: "/osmosis/poolmanager/v1beta1/trading_pair_takerfee",
  routerQuote: "/router/quote",
  routerRoutes: "/router/routes",
  routerCustomDirectQuote: "/router/custom-direct-quote",
};

/**
 * Public SQS router base URLs, highest priority first.
 *
 * Exported as data, not baked in: a host builds its router {@link LcdClient}
 * from these (or from its own deployment) and passes it in. Both hosts below
 * answered identically during verification.
 */
export const OSMOSIS_ROUTER_ENDPOINTS: readonly string[] = [
  "https://sqs.osmosis.zone",
  "https://sqsprod.osmosis.zone",
];

/**
 * Chain-id prefixes accepted as "this is Osmosis".
 *
 * Mainnet is `osmosis-1`; the public testnet is `osmo-test-5`, which does not
 * share a prefix with mainnet, hence two entries rather than one.
 */
export const OSMOSIS_CHAIN_ID_PREFIXES: readonly string[] = [
  "osmosis-",
  "osmo-test-",
];

/** Slippage tolerance used when the caller does not state one, as a percentage. */
export const DEFAULT_SLIPPAGE_PERCENT = 1;

/**
 * TWAP window used when the caller does not state one, in seconds.
 *
 * Matches the value in the crosschain-swaps README example. A short window
 * tracks the pool closely; a long one resists a single-block manipulation.
 */
export const DEFAULT_TWAP_WINDOW_SECONDS = 10;

/** Cap on candidate routes evaluated by the LCD-only search. */
const DEFAULT_MAX_ROUTES = 4;

/**
 * Fixed-point scale for percentage arithmetic, as decimal places of a percent.
 *
 * Amounts are uint128 on the wire, so slippage is applied with `BigInt`, and
 * `BigInt` needs the percentage as an integer. Six places is far finer than any
 * slippage a UI offers and keeps `percent * 1e6` inside `Number.MAX_SAFE_INTEGER`.
 */
const PERCENT_DECIMALS = 6;
const PERCENT_SCALE = 1_000_000n;
/** 100% expressed at {@link PERCENT_SCALE}. */
const FULL_PERCENT_SCALED = 100n * PERCENT_SCALE;

/* -------------------------------------------------------------------------- *
 * Types
 * -------------------------------------------------------------------------- */

/** Which venue produced a quote. */
export type OsmosisQuoteSource = "router" | "poolmanager";

/** One pool leg of a route, with the venue's fee data attached. */
export interface OsmosisPoolLeg {
  /** Pool id as a decimal string. SQS reports it as a JSON number; we normalise. */
  readonly poolId: string;
  /** Denom leaving this pool. */
  readonly tokenOutDenom: string;
  /**
   * Pool spread factor (the LP fee) as a decimal fraction string, e.g.
   * `"0.002000000000000000"` for 0.2%. `null` when the venue did not say.
   */
  readonly spreadFactor: string | null;
  /**
   * Protocol taker fee as a decimal fraction string. Charged by poolmanager on
   * top of the spread factor, so the two add up rather than compose.
   * `null` when the venue did not say.
   */
  readonly takerFee: string | null;
  /**
   * Raw poolmanager pool-type discriminant, when reported.
   *
   * Kept as a number on purpose: the enum is Osmosis-internal and gains members
   * (balancer, stableswap, concentrated, cosmwasm, …). Naming them here would
   * turn a new pool type into a parse failure.
   */
  readonly poolType: number | null;
}

/**
 * One split of an order.
 *
 * The SQS router may divide an order across several routes to reduce impact,
 * so a quote is a list of these rather than a single path.
 */
export interface OsmosisRouteSplit {
  readonly pools: readonly OsmosisPoolLeg[];
  /** Input allocated to this split, base units. */
  readonly inAmount: string;
  /** Output produced by this split, base units. */
  readonly outAmount: string;
}

/**
 * A priced Osmosis swap.
 *
 * Extends the package-wide {@link SwapQuote} with the Osmosis-specific facts a
 * wallet wants to show — chiefly {@link splits}, because
 * {@link SwapQuote.route} can only carry one path and the router routinely
 * returns several.
 */
export interface OsmosisSwapQuote extends SwapQuote {
  /** Venue that produced this quote. */
  readonly source: OsmosisQuoteSource;
  /**
   * Every split, in the venue's order. {@link SwapQuote.route} mirrors the
   * largest split so single-path consumers keep working.
   */
  readonly splits: readonly OsmosisRouteSplit[];
  /**
   * Spot price at quote time as a decimal fraction string, output units per
   * input unit. `null` when neither venue reported one.
   */
  readonly spotPrice: string | null;
  /**
   * Total fee as a decimal fraction string (`"0.008"` = 0.8%), the raw form
   * {@link SwapQuote.poolFee} is derived from. Kept because the fraction is
   * what the contract and the docs speak in, and re-deriving it from a rounded
   * percentage loses digits.
   */
  readonly effectiveFeeFraction: string | null;
  /** Non-fatal notes: split orders, missing fee data, forced routes. */
  readonly warnings: readonly string[];
  /** `Date.now()` when the quote was assembled. Quotes go stale in seconds. */
  readonly fetchedAt: number;
}

/** A route between two denoms, as pool legs. */
export interface OsmosisPoolRoute {
  readonly pools: readonly OsmosisRouteLeg[];
  readonly tokenInDenom: string;
  readonly tokenOutDenom: string;
}

/** One leg of an {@link OsmosisPoolRoute}. */
export interface OsmosisRouteLeg {
  readonly poolId: string;
  readonly tokenInDenom: string;
  readonly tokenOutDenom: string;
}

/** What {@link quoteOsmosisSwap} needs. */
export interface OsmosisSwapQuoteParams {
  /** Denom going in, as held on Osmosis (`uosmo` or `ibc/…`). */
  readonly tokenInDenom: string;
  /** Amount going in, base units as a decimal string. Never a `number`. */
  readonly tokenInAmount: string;
  /** Denom wanted out. */
  readonly tokenOutDenom: string;
  /** Tolerance as a percentage, e.g. `1` for 1%. Defaults to {@link DEFAULT_SLIPPAGE_PERCENT}. */
  readonly slippagePercent?: number;
  /**
   * The SQS router, as its own client. Absent means LCD-only quoting, which
   * needs {@link route} or {@link candidatePoolIds} because the chain has no
   * pool-by-denom index.
   */
  readonly router?: LcdClient;
  /**
   * Quote exactly this route instead of searching. Each entry is a pool and the
   * denom leaving it; the last entry's denom must be {@link tokenOutDenom}.
   */
  readonly route?: readonly SwapPoolHop[];
  /**
   * Pools to consider when there is no router. Only direct (single-leg) pairs
   * are found from these; see {@link findOsmosisPools}.
   */
  readonly candidatePoolIds?: readonly string[];
  /** Cap on candidate routes evaluated without a router. Default 4. */
  readonly maxRoutes?: number;
  /**
   * Ask the router for one path rather than a split order. Splits execute as
   * several pool hops, which some downstream memo builders cannot express.
   */
  readonly singleRoute?: boolean;
  /**
   * Reject the quote when the output falls below this, base units. Produces
   * `slippage-exceeded` rather than a quote the caller has to re-check.
   */
  readonly minOutputAmount?: string;
  /**
   * Skip the "is this Osmosis?" check on the LCD's chain id. For a fork or a
   * local devnet that runs poolmanager under a different chain id.
   */
  readonly allowAnyChainId?: boolean;
  /** Path overrides, merged over {@link OSMOSIS_SWAP_PATHS}. */
  readonly paths?: Partial<OsmosisSwapPaths>;
  /** Passed to every {@link LcdClient.getJson} call: timeout, signal, cache TTL. */
  readonly request?: LcdRequestOptions;
}

/** What {@link findOsmosisPools} needs. */
export interface OsmosisPoolSearch {
  readonly tokenInDenom: string;
  readonly tokenOutDenom: string;
  /** The SQS router. Strongly preferred; see the caveat on {@link findOsmosisPools}. */
  readonly router?: LcdClient;
  /** Pools to test for the pair when there is no router. */
  readonly candidatePoolIds?: readonly string[];
  /** Cap on returned routes. Default 4. */
  readonly maxRoutes?: number;
  readonly paths?: Partial<OsmosisSwapPaths>;
  readonly request?: LcdRequestOptions;
}

/**
 * The TWAP form of the XCS `slippage` field.
 *
 * Wire shape, from the crosschain-swaps README:
 * `{"twap": {"slippage_percentage": "20", "window_seconds": 10}}`.
 * `slippage_percentage` is a **string percentage**, `window_seconds` a
 * **number**. Declared as a type alias rather than an interface so it stays
 * structurally assignable to `JsonObject` when a memo builder embeds it.
 */
export type XcsTwapSlippage = {
  readonly twap: {
    readonly slippage_percentage: string;
    readonly window_seconds: number;
  };
};

/**
 * The absolute form of the XCS `slippage` field:
 * `{"min_output_amount": "100"}`, base units as a string.
 */
export type XcsMinOutputSlippage = {
  readonly min_output_amount: string;
};

/**
 * Either form the XCS contract accepts for `slippage`, on the wire.
 *
 * This is the serialised shape. `memo.ts` owns the tagged input form —
 * {@link XcsSlippage}, with a `kind` discriminant — which is what
 * `buildXcsSwapMemo` takes. Use {@link toMemoSlippage} to cross between them;
 * a quote produces the wire form, a memo consumes the tagged one.
 */
export type XcsSlippageJson = XcsTwapSlippage | XcsMinOutputSlippage;

/**
 * Convert a wire-form slippage into the tagged form `memo.ts` builds from.
 *
 * The two representations exist because they are produced and consumed by
 * different layers: {@link slippageToTwapParams} and {@link minOutputFromQuote}
 * fall out of a quote, while `buildXcsSwapMemo` validates a tagged union. This
 * is the only conversion between them, so neither layer has to know the
 * other's shape.
 *
 * Validation stays where it was: this only re-labels, and `buildXcsSwapMemo`
 * rechecks every field before it reaches a packet.
 */
export function toMemoSlippage(slippage: XcsSlippageJson): XcsSlippage {
  if ("min_output_amount" in slippage) {
    return {
      kind: "min_output_amount",
      minOutputAmount: slippage.min_output_amount,
    };
  }
  return {
    kind: "twap",
    slippagePercentage: slippage.twap.slippage_percentage,
    windowSeconds: slippage.twap.window_seconds,
  };
}

/* -------------------------------------------------------------------------- *
 * Errors
 * -------------------------------------------------------------------------- */

/**
 * Caller-input failures.
 *
 * Kept apart from `no-route`: an unroutable pair means the request made sense
 * and the network could not serve it, which is worth showing as "no route
 * today". A negative amount or a 400% slippage is our caller's bug and must not
 * render as a market condition.
 */
function invalidRequest(message: string): InterchainError {
  return new InterchainError("invalid-request", message);
}

/**
 * Translate a venue's "I cannot price this" into `no-route`.
 *
 * Both venues answer an unpriceable request with an HTTP error whose body
 * carries the reason, and {@link LcdClient} discards non-2xx bodies — so the
 * status is all we have:
 *
 * - SQS answers **400** for an unknown denom or an unroutable pair
 *   (`{"message":"denom is not a valid chain denom (unope)"}`), which
 *   `LcdClient` classifies as fatal and reports as `lcd-unreachable`.
 * - poolmanager answers **500** with a gRPC status for "denom does not exist in
 *   the pool" and for a missing pool id. `LcdClient` retries and falls back
 *   first, so by the time we see it every endpoint has been tried.
 *
 * A node that is genuinely broken also answers 500, so this conflates the two.
 * The original error is kept as `cause` and the message names both readings.
 */
function asNoRoute(error: unknown, message: string): unknown {
  if (!isInterchainError(error) || error.code !== "lcd-unreachable") return error;
  const status = error.httpStatus;
  if (status === 400 || status === 404 || status === 500) {
    return new InterchainError("no-route", message, {
      cause: error,
      chainId: error.chainId,
      endpoint: error.endpoint,
      httpStatus: status,
    });
  }
  // A timeout or a dead host stays `lcd-unreachable`: the pair may well be
  // routable and the user should retry, not pick a different pair.
  return error;
}

/* -------------------------------------------------------------------------- *
 * Small parsing helpers
 * -------------------------------------------------------------------------- */

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A uint as a decimal string.
 *
 * Accepts a JSON number as well as a string: SQS reports pool ids as numbers
 * (`"id":1400`) while the LCD reports them as strings (`"id":"1"`). Numbers are
 * only accepted when they are safe integers, so a pool id past 2^53 fails
 * loudly instead of being silently rounded.
 */
function asUintString(value: unknown): string | null {
  if (typeof value === "string") {
    return /^[0-9]+$/.test(value) ? value : null;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  return null;
}

/** A decimal fraction such as `"0.008000000000000000"` or `"-0.00006"`. */
function asDecimalString(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? toPlainDecimal(value) : null;
  }
  if (typeof value !== "string") return null;
  return /^-?[0-9]*\.?[0-9]+$/.test(value.trim()) ? value.trim() : null;
}

/**
 * Render a number without exponent notation.
 *
 * `String(1e-7)` is `"1e-7"`, which no CosmWasm `Decimal` parser accepts, so
 * anything that reaches a memo goes through here.
 */
function toPlainDecimal(value: number): string {
  const plain = String(value);
  if (!/e/i.test(plain)) return plain;
  // toFixed caps at 100 places, which is well past Decimal's 18.
  return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}

/** Substitute `{pool_id}` into a path template. */
function fillPoolPath(template: string, poolId: string): string {
  return template.replace("{pool_id}", encodeURIComponent(poolId));
}

function resolvePaths(overrides?: Partial<OsmosisSwapPaths>): OsmosisSwapPaths {
  return overrides ? { ...OSMOSIS_SWAP_PATHS, ...overrides } : OSMOSIS_SWAP_PATHS;
}

/* -------------------------------------------------------------------------- *
 * Amount / percentage arithmetic
 * -------------------------------------------------------------------------- */

/** Parse a base-unit amount, rejecting anything that is not a non-negative integer. */
function parseAmount(value: string, label: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw invalidRequest(`${label} must be a non-negative integer string, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** Validate a percentage and scale it to an integer at {@link PERCENT_DECIMALS}. */
function scalePercent(percent: number, label: string): bigint {
  if (!Number.isFinite(percent) || percent < 0) {
    throw invalidRequest(`${label} must be a finite percentage >= 0, got ${percent}`);
  }
  if (percent > 100) {
    throw invalidRequest(`${label} must be <= 100, got ${percent}`);
  }
  return BigInt(Math.round(percent * 10 ** PERCENT_DECIMALS));
}

/**
 * Reduce an amount by a slippage tolerance, rounding down.
 *
 * Rounding down is deliberate: the result becomes a floor the chain enforces,
 * and rounding up would put the floor above what the quote promised.
 *
 * @param amount - Base units as a decimal string.
 * @param slippagePercent - Tolerance as a percentage, `1` for 1%.
 * @returns Base units as a decimal string.
 * @throws {@link InterchainError} `invalid-request` when either argument is not usable.
 */
export function applySlippage(amount: string, slippagePercent: number): string {
  const value = parseAmount(amount, "amount");
  const scaled = scalePercent(slippagePercent, "slippagePercent");
  const kept = FULL_PERCENT_SCALED - scaled;
  return ((value * kept) / FULL_PERCENT_SCALED).toString();
}

/**
 * `numerator / denominator` as a `number`, via `BigInt`.
 *
 * Amounts can exceed `Number.MAX_SAFE_INTEGER`, so the division happens in
 * integers and only the ratio — a display value bounded by the price — is
 * converted. Returns `null` on a zero denominator.
 */
function ratioOf(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) return null;
  const SCALE = 10n ** 18n;
  return Number((numerator * SCALE) / denominator) / 1e18;
}

/* -------------------------------------------------------------------------- *
 * XCS slippage forms
 * -------------------------------------------------------------------------- */

/**
 * Build the `twap` form of the XCS `slippage` field.
 *
 * The contract compares the swap against a time-weighted average price over
 * `window_seconds` and aborts if the result is worse than
 * `slippage_percentage`. Prefer this over
 * {@link minOutputFromQuote} when the packet may sit in a relayer queue: an
 * absolute minimum computed now goes stale, a TWAP tolerance does not.
 *
 * @param percent - Tolerance as a percentage, `20` for the README's 20%.
 * @param windowSeconds - TWAP window. Defaults to {@link DEFAULT_TWAP_WINDOW_SECONDS}.
 * @returns Exactly `{"twap":{"slippage_percentage":"…","window_seconds":N}}`.
 * @throws {@link InterchainError} `invalid-request` on a percentage outside `[0, 100]`
 *   or a window that is not a non-negative integer.
 */
export function slippageToTwapParams(
  percent: number,
  windowSeconds: number = DEFAULT_TWAP_WINDOW_SECONDS,
): XcsTwapSlippage {
  // Validate through the same path as everything else, then render the
  // percentage as a plain decimal: the contract parses it as a Decimal and
  // rejects exponent notation.
  scalePercent(percent, "percent");
  if (!Number.isInteger(windowSeconds) || windowSeconds < 0) {
    throw invalidRequest(
      `windowSeconds must be a non-negative integer, got ${windowSeconds}`,
    );
  }
  return {
    twap: {
      slippage_percentage: toPlainDecimal(percent),
      window_seconds: windowSeconds,
    },
  };
}

/**
 * Build the `min_output_amount` form of the XCS `slippage` field from a quote.
 *
 * @param quote - A quote from {@link quoteOsmosisSwap} or any {@link SwapQuote}.
 * @param slippagePercent - Recompute the floor at this tolerance. Omit to use
 *   {@link SwapQuote.minReceived}, which the quote already derived.
 * @returns Exactly `{"min_output_amount":"…"}`.
 * @throws {@link InterchainError} `invalid-request` when the quote's amounts are not
 *   integer strings, or the tolerance is out of range.
 */
export function minOutputFromQuote(
  quote: SwapQuote,
  slippagePercent?: number,
): XcsMinOutputSlippage {
  if (slippagePercent === undefined) {
    // Re-parse rather than trust: `minReceived` may have come from a caller's
    // own SwapQuote, not from this module.
    parseAmount(quote.minReceived, "quote.minReceived");
    return { min_output_amount: quote.minReceived };
  }
  return {
    min_output_amount: applySlippage(quote.outputAmount, slippagePercent),
  };
}

/* -------------------------------------------------------------------------- *
 * Response parsing
 * -------------------------------------------------------------------------- */

function malformed(what: string): InterchainError {
  return new InterchainError("malformed-response", `Osmosis: ${what}`);
}

/**
 * Parse `{"token_out_amount":"22411"}` from a single-pool estimate.
 *
 * @throws {@link InterchainError} `malformed-response`.
 */
export function parseSinglePoolEstimate(body: unknown): string {
  const row = asRecord(body);
  const amount = row ? asUintString(row.token_out_amount) : null;
  if (amount === null) {
    throw malformed("single-pool estimate has no token_out_amount");
  }
  return amount;
}

/**
 * Parse `{"liquidity":[{"denom":"…","amount":"…"}]}` into its denoms.
 *
 * Entries missing a denom are dropped rather than failing the whole response:
 * a pool with one unreadable asset is still usable evidence about the others.
 *
 * @throws {@link InterchainError} `malformed-response` when `liquidity` is
 *   absent or not an array.
 */
export function parsePoolDenoms(body: unknown): readonly string[] {
  const row = asRecord(body);
  const list = row ? asArray(row.liquidity) : null;
  if (list === null) {
    throw malformed("total_pool_liquidity has no liquidity array");
  }
  const denoms: string[] = [];
  for (const entry of list) {
    const coin = asRecord(entry);
    const denom = coin ? asNonEmptyString(coin.denom) : null;
    if (denom !== null) denoms.push(denom);
  }
  return denoms;
}

/**
 * Parse `{"spot_price":"0.0226…"}`.
 *
 * @returns The fraction as a string, or `null` when the field is missing —
 *   a missing spot price only costs us the price-impact figure, so it is not
 *   worth failing a quote over.
 */
export function parseSpotPrice(body: unknown): string | null {
  const row = asRecord(body);
  return row ? asDecimalString(row.spot_price) : null;
}

/** Parse `{"taker_fee":"0.008…"}`. `null` when absent, for the same reason. */
export function parseTakerFee(body: unknown): string | null {
  const row = asRecord(body);
  return row ? asDecimalString(row.taker_fee) : null;
}

/**
 * Pull a pool's spread factor (LP fee) out of a pool document.
 *
 * Every pool type spells it differently and new types keep appearing, so this
 * probes the known spellings and returns `null` rather than failing:
 * - balancer / stableswap: `pool.pool_params.swap_fee`
 * - concentrated liquidity: `pool.spread_factor`
 * - cosmwasm pools: no fee in the document at all; the contract holds it.
 *
 * Defensive by design — the shape is not in the verified spec.
 */
export function parsePoolSpreadFactor(body: unknown): string | null {
  const envelope = asRecord(body);
  const pool = envelope ? asRecord(envelope.pool) ?? asRecord(envelope) : null;
  if (pool === null) return null;
  const params = asRecord(pool.pool_params);
  if (params) {
    const fee = asDecimalString(params.swap_fee);
    if (fee !== null) return fee;
  }
  return asDecimalString(pool.spread_factor);
}

function parsePoolLeg(value: unknown): OsmosisPoolLeg | null {
  const row = asRecord(value);
  if (row === null) return null;
  const poolId = asUintString(row.id) ?? asUintString(row.pool_id);
  const tokenOutDenom = asNonEmptyString(row.token_out_denom);
  if (poolId === null || tokenOutDenom === null) return null;
  const poolType = typeof row.type === "number" && Number.isFinite(row.type)
    ? row.type
    : null;
  return {
    poolId,
    tokenOutDenom,
    spreadFactor: asDecimalString(row.spread_factor),
    takerFee: asDecimalString(row.taker_fee),
    poolType,
  };
}

/** Normalised shape of an SQS `/router/quote` response. */
export interface OsmosisRouterQuote {
  readonly inDenom: string;
  readonly inAmount: string;
  readonly outAmount: string;
  readonly splits: readonly OsmosisRouteSplit[];
  /** Total fee as a decimal fraction, `"0.008"` = 0.8%. `null` when absent. */
  readonly effectiveFeeFraction: string | null;
  /**
   * Price impact as the router reports it: a decimal fraction that is
   * **negative** when the trade moves the price against the user. Fees are not
   * included — SQS reports them separately in `effective_fee`, which is what
   * lets a quote show impact and fee as two numbers.
   */
  readonly priceImpactFraction: string | null;
  /** `in_base_out_quote_spot_price`: output units per input unit. */
  readonly spotPrice: string | null;
}

/**
 * Parse an SQS `/router/quote` or `/router/custom-direct-quote` body.
 *
 * Verified shape (2026-09-06):
 * ```json
 * {"amount_in":{"denom":"uosmo","amount":"1000000"},
 *  "amount_out":"22518",
 *  "route":[{"pools":[{"id":1400,"type":2,"spread_factor":"0.0",
 *                     "token_out_denom":"ibc/…","taker_fee":"0.008"}],
 *            "in_amount":"1000000","out_amount":"22518"}],
 *  "effective_fee":"0.008000000000000000",
 *  "price_impact":"-0.000060651677841116",
 *  "in_base_out_quote_spot_price":"0.022700973626332612"}
 * ```
 *
 * @throws {@link InterchainError} `malformed-response` when the amounts or the
 *   route array are missing; `no-route` when the router answered with an empty
 *   route, which is how it reports "priceable pair, but not at this size".
 */
export function parseRouterQuote(body: unknown): OsmosisRouterQuote {
  const row = asRecord(body);
  if (row === null) throw malformed("router quote is not an object");

  const amountIn = asRecord(row.amount_in);
  const inDenom = amountIn ? asNonEmptyString(amountIn.denom) : null;
  const inAmount = amountIn ? asUintString(amountIn.amount) : null;
  const outAmount = asUintString(row.amount_out);
  if (inDenom === null || inAmount === null || outAmount === null) {
    throw malformed("router quote is missing amount_in or amount_out");
  }

  const routes = asArray(row.route);
  if (routes === null) throw malformed("router quote has no route array");

  const splits: OsmosisRouteSplit[] = [];
  for (const entry of routes) {
    const split = asRecord(entry);
    if (split === null) continue;
    const pools = asArray(split.pools);
    if (pools === null) continue;
    const legs: OsmosisPoolLeg[] = [];
    for (const pool of pools) {
      const leg = parsePoolLeg(pool);
      // A leg we cannot read makes the whole split unusable: a route with a
      // hole in it would misreport which pools the funds pass through.
      if (leg === null) {
        legs.length = 0;
        break;
      }
      legs.push(leg);
    }
    if (legs.length === 0) continue;
    splits.push({
      pools: legs,
      inAmount: asUintString(split.in_amount) ?? inAmount,
      outAmount: asUintString(split.out_amount) ?? outAmount,
    });
  }

  if (splits.length === 0) {
    throw new InterchainError(
      "no-route",
      `Osmosis router returned no usable route for ${inDenom}`,
    );
  }

  return {
    inDenom,
    inAmount,
    outAmount,
    splits,
    effectiveFeeFraction: asDecimalString(row.effective_fee),
    priceImpactFraction: asDecimalString(row.price_impact),
    spotPrice: asDecimalString(row.in_base_out_quote_spot_price),
  };
}

/**
 * Parse an SQS `/router/routes` body.
 *
 * Verified shape (2026-09-06) — note the **PascalCase** keys, which no other
 * Osmosis endpoint uses, and the numeric `ID`:
 * ```json
 * {"Routes":[{"Pools":[{"ID":1135,"TokenInDenom":"uosmo","TokenOutDenom":"ibc/…"}],
 *             "IsCanonicalOrderboolRoute":false}]}
 * ```
 * Both spellings are accepted anyway, in case the casing is normalised later.
 *
 * @throws {@link InterchainError} `malformed-response` when no route array is
 *   present under either spelling.
 */
export function parseRouterRoutes(
  body: unknown,
  tokenInDenom: string,
  tokenOutDenom: string,
): readonly OsmosisPoolRoute[] {
  const row = asRecord(body);
  const list = row ? asArray(row.Routes) ?? asArray(row.routes) : null;
  if (list === null) throw malformed("router routes has no Routes array");

  const out: OsmosisPoolRoute[] = [];
  for (const entry of list) {
    const route = asRecord(entry);
    if (route === null) continue;
    const pools = asArray(route.Pools) ?? asArray(route.pools);
    if (pools === null) continue;
    const legs: OsmosisRouteLeg[] = [];
    for (const pool of pools) {
      const leg = asRecord(pool);
      if (leg === null) continue;
      const poolId = asUintString(leg.ID) ?? asUintString(leg.id);
      const inDenom =
        asNonEmptyString(leg.TokenInDenom) ?? asNonEmptyString(leg.token_in_denom);
      const outDenom =
        asNonEmptyString(leg.TokenOutDenom) ?? asNonEmptyString(leg.token_out_denom);
      if (poolId === null || inDenom === null || outDenom === null) {
        legs.length = 0;
        break;
      }
      legs.push({ poolId, tokenInDenom: inDenom, tokenOutDenom: outDenom });
    }
    if (legs.length === 0) continue;
    const last = legs[legs.length - 1];
    const first = legs[0];
    if (first === undefined || last === undefined) continue;
    out.push({
      pools: legs,
      tokenInDenom: first.tokenInDenom,
      tokenOutDenom: last.tokenOutDenom,
    });
  }
  // The router occasionally returns routes for a related pair; keep only the
  // ones that actually start and end where the caller asked.
  return out.filter(
    (route) =>
      route.tokenInDenom === tokenInDenom && route.tokenOutDenom === tokenOutDenom,
  );
}

/* -------------------------------------------------------------------------- *
 * Route discovery
 * -------------------------------------------------------------------------- */

/**
 * Find pool routes between two denoms.
 *
 * **Prefer the router.** Osmosis's own router does a graph search over every
 * pool with live liquidity, splits orders, and knows which pools are worth
 * routing through. What this function does without one is much simpler: it
 * tests the caller's {@link OsmosisPoolSearch.candidatePoolIds} for a pool that
 * holds both denoms and returns those single-leg routes. There is no multi-hop
 * search and no liquidity ranking, because the chain exposes no pool-by-denom
 * index — the only alternative is enumerating every pool (3,578 at the time of
 * writing), which is not something a browser service worker should do on a
 * quote. Treat the LCD-only path as a degraded fallback for when the host will
 * not talk to the SQS host, not as a router.
 *
 * @param search - Denom pair, plus a router or a candidate list.
 * @param lcd - The Osmosis chain LCD, used only in the router-less path.
 * @returns Routes in the venue's preference order, capped at
 *   {@link OsmosisPoolSearch.maxRoutes}. Empty when nothing was found.
 * @throws {@link InterchainError} `no-route` when neither a router nor a
 *   candidate list was supplied, `malformed-response` on an unreadable body.
 */
export async function findOsmosisPools(
  search: OsmosisPoolSearch,
  lcd: LcdClient,
): Promise<readonly OsmosisPoolRoute[]> {
  const paths = resolvePaths(search.paths);
  const limit = search.maxRoutes ?? DEFAULT_MAX_ROUTES;

  if (search.router) {
    const body = await search.router.getJson(paths.routerRoutes, {
      ...search.request,
      query: {
        tokenIn: search.tokenInDenom,
        tokenOutDenom: search.tokenOutDenom,
      },
    });
    return parseRouterRoutes(body, search.tokenInDenom, search.tokenOutDenom).slice(
      0,
      limit,
    );
  }

  const candidates = search.candidatePoolIds ?? [];
  if (candidates.length === 0) {
    throw new InterchainError(
      "no-route",
      "Osmosis pool search needs either a router client or candidatePoolIds: " +
        "the chain LCD has no pool-by-denom index",
      { chainId: lcd.chainId },
    );
  }

  const routes: OsmosisPoolRoute[] = [];
  for (const poolId of candidates) {
    if (routes.length >= limit) break;
    let denoms: readonly string[];
    try {
      denoms = parsePoolDenoms(
        await lcd.getJson(fillPoolPath(paths.totalPoolLiquidity, poolId), search.request),
      );
    } catch {
      // One unreadable or missing pool must not sink the search; the caller's
      // candidate list is a guess by construction.
      continue;
    }
    if (denoms.includes(search.tokenInDenom) && denoms.includes(search.tokenOutDenom)) {
      routes.push({
        pools: [
          {
            poolId,
            tokenInDenom: search.tokenInDenom,
            tokenOutDenom: search.tokenOutDenom,
          },
        ],
        tokenInDenom: search.tokenInDenom,
        tokenOutDenom: search.tokenOutDenom,
      });
    }
  }
  return routes;
}

/* -------------------------------------------------------------------------- *
 * Quoting
 * -------------------------------------------------------------------------- */

function assertOsmosisChain(lcd: LcdClient, params: OsmosisSwapQuoteParams): void {
  if (params.allowAnyChainId === true) return;
  const known = OSMOSIS_CHAIN_ID_PREFIXES.some((prefix) =>
    lcd.chainId.startsWith(prefix),
  );
  if (!known) {
    throw new InterchainError(
      "unsupported-chain",
      `${lcd.chainId} is not an Osmosis chain; poolmanager swaps are Osmosis-only`,
      { chainId: lcd.chainId },
    );
  }
}

function validateQuoteParams(params: OsmosisSwapQuoteParams): {
  readonly amount: bigint;
  readonly slippagePercent: number;
} {
  if (asNonEmptyString(params.tokenInDenom) === null) {
    throw invalidRequest("tokenInDenom is required");
  }
  if (asNonEmptyString(params.tokenOutDenom) === null) {
    throw invalidRequest("tokenOutDenom is required");
  }
  if (params.tokenInDenom === params.tokenOutDenom) {
    throw invalidRequest(
      `tokenInDenom and tokenOutDenom are both ${params.tokenInDenom}; there is nothing to swap`,
    );
  }
  const amount = parseAmount(params.tokenInAmount, "tokenInAmount");
  if (amount === 0n) throw invalidRequest("tokenInAmount must be greater than zero");
  const slippagePercent = params.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT;
  scalePercent(slippagePercent, "slippagePercent");
  return { amount, slippagePercent };
}

/** The split that carries the most input; the one worth showing as "the" route. */
function largestSplit(splits: readonly OsmosisRouteSplit[]): OsmosisRouteSplit | null {
  let best: OsmosisRouteSplit | null = null;
  let bestAmount = -1n;
  for (const split of splits) {
    const value = /^[0-9]+$/.test(split.inAmount) ? BigInt(split.inAmount) : 0n;
    if (value > bestAmount) {
      bestAmount = value;
      best = split;
    }
  }
  return best;
}

function toSwapPoolHops(legs: readonly OsmosisPoolLeg[]): readonly SwapPoolHop[] {
  return legs.map((leg) => ({ poolId: leg.poolId, tokenOutDenom: leg.tokenOutDenom }));
}

/**
 * Ask the SQS router for a quote.
 *
 * `route` forces a specific path through `/router/custom-direct-quote`, whose
 * `poolID` and `tokenOutDenom` are positional comma-separated lists.
 */
async function quoteViaRouter(
  params: OsmosisSwapQuoteParams,
  router: LcdClient,
  paths: OsmosisSwapPaths,
): Promise<OsmosisRouterQuote> {
  const tokenIn = `${params.tokenInAmount}${params.tokenInDenom}`;
  const forced = params.route;
  const path = forced ? paths.routerCustomDirectQuote : paths.routerQuote;
  const query: Record<string, string | number | boolean | undefined> = {
    tokenIn,
    tokenOutDenom: forced
      ? forced.map((hop) => hop.tokenOutDenom).join(",")
      : params.tokenOutDenom,
  };
  if (forced) {
    query.poolID = forced.map((hop) => hop.poolId).join(",");
  } else if (params.singleRoute === true) {
    query.singleRoute = true;
  }

  try {
    return parseRouterQuote(await router.getJson(path, { ...params.request, query }));
  } catch (error) {
    throw asNoRoute(
      error,
      `Osmosis router cannot price ${params.tokenInDenom} -> ${params.tokenOutDenom}`,
    );
  }
}

/** Fee and spot-price data for one leg, gathered from the chain. */
interface LegFacts {
  readonly spreadFactor: string | null;
  readonly takerFee: string | null;
  readonly spotPrice: string | null;
}

/**
 * Read a leg's fees and spot price.
 *
 * Every field is optional: a quote is still useful without them, so each query
 * failure degrades one number rather than the whole call.
 */
async function readLegFacts(
  poolId: string,
  tokenInDenom: string,
  tokenOutDenom: string,
  lcd: LcdClient,
  paths: OsmosisSwapPaths,
  request: LcdRequestOptions | undefined,
): Promise<LegFacts> {
  const [pool, taker, spot] = await Promise.all([
    lcd.getJson(fillPoolPath(paths.pool, poolId), request).then(
      (body) => parsePoolSpreadFactor(body),
      () => null,
    ),
    lcd
      .getJson(paths.tradingPairTakerFee, {
        ...request,
        query: { denom_0: tokenInDenom, denom_1: tokenOutDenom },
      })
      .then((body) => parseTakerFee(body), () => null),
    lcd
      .getJson(fillPoolPath(paths.spotPrice, poolId), {
        ...request,
        query: { base_asset_denom: tokenInDenom, quote_asset_denom: tokenOutDenom },
      })
      .then((body) => parseSpotPrice(body), () => null),
  ]);
  return { spreadFactor: pool, takerFee: taker, spotPrice: spot };
}

/** What the poolmanager path produces before it is shaped into a quote. */
interface PoolmanagerQuote {
  readonly outAmount: string;
  readonly legs: readonly OsmosisPoolLeg[];
  readonly spotPrice: string | null;
  readonly feeFraction: string | null;
  readonly priceImpactPercent: number;
  readonly warnings: readonly string[];
}

/**
 * Quote a known route by chaining single-pool estimates.
 *
 * One `single_pool_swap_exact_amount_in` per leg, feeding each leg's output
 * into the next. `EstimateSwapExactAmountIn` would do this in one call but is
 * unreachable over REST (see the module header), so the chain of calls is the
 * only way to price a multi-hop route against the chain itself.
 */
async function quoteViaPoolmanager(
  route: readonly OsmosisRouteLeg[],
  params: OsmosisSwapQuoteParams,
  lcd: LcdClient,
  paths: OsmosisSwapPaths,
): Promise<PoolmanagerQuote> {
  const warnings: string[] = [];
  const legs: OsmosisPoolLeg[] = [];
  let amount = params.tokenInAmount;

  // Fees and spot prices are per-leg and independent of the running amount, so
  // they are gathered in parallel while the estimates run in sequence.
  const factsPromise = Promise.all(
    route.map((leg) =>
      readLegFacts(leg.poolId, leg.tokenInDenom, leg.tokenOutDenom, lcd, paths, params.request),
    ),
  );

  for (const leg of route) {
    let body: unknown;
    try {
      body = await lcd.getJson(
        fillPoolPath(paths.estimateSinglePoolSwapExactAmountIn, leg.poolId),
        {
          ...params.request,
          query: {
            token_in: `${amount}${leg.tokenInDenom}`,
            token_out_denom: leg.tokenOutDenom,
          },
        },
      );
    } catch (error) {
      throw asNoRoute(
        error,
        `Osmosis pool ${leg.poolId} cannot swap ${leg.tokenInDenom} -> ${leg.tokenOutDenom} ` +
          "(the pool may not hold both denoms, or every REST endpoint failed)",
      );
    }
    amount = parseSinglePoolEstimate(body);
    legs.push({
      poolId: leg.poolId,
      tokenOutDenom: leg.tokenOutDenom,
      spreadFactor: null,
      takerFee: null,
      poolType: null,
    });
  }

  const facts = await factsPromise;

  // Compose the legs' fees. Poolmanager takes the taker fee off the input and
  // the pool then takes its spread factor off what is left, so within a leg the
  // two surviving fractions multiply, and so do the legs. `null` means "not
  // reported" and is skipped, which understates the fee — hence the warning.
  //
  // Checked against pool 1 on 2026-09-06: spot 0.0226377 x 1e6 uosmo, taker
  // 0.008, spread 0.002 predicts 22411.7, and the chain's own estimate was
  // 22411 — so the single-pool estimate has both fees already deducted, which
  // is what lets price impact be read off the residual below.
  let survivingValue = 1;
  let anyFee = false;
  let missingFee = false;
  // Spot price across the route is the product of the per-leg prices, each of
  // which is output units per input unit for that leg.
  let spotProduct = 1;
  let anySpot = false;
  let missingSpot = false;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const fact = facts[i];
    if (leg === undefined || fact === undefined) continue;
    legs[i] = { ...leg, spreadFactor: fact.spreadFactor, takerFee: fact.takerFee };

    const spread = fact.spreadFactor === null ? null : Number(fact.spreadFactor);
    const taker = fact.takerFee === null ? null : Number(fact.takerFee);
    if (spread === null && taker === null) {
      missingFee = true;
    } else {
      anyFee = true;
      survivingValue *= (1 - (spread ?? 0)) * (1 - (taker ?? 0));
      if (spread === null || taker === null) missingFee = true;
    }

    if (fact.spotPrice === null) {
      missingSpot = true;
    } else {
      const value = Number(fact.spotPrice);
      if (Number.isFinite(value) && value > 0) {
        anySpot = true;
        spotProduct *= value;
      } else {
        missingSpot = true;
      }
    }
  }

  if (missingFee) {
    warnings.push(
      "Some pool fees could not be read; the reported fee is a lower bound.",
    );
  }

  const feeFraction = anyFee ? toPlainDecimal(1 - survivingValue) : null;
  const spotPrice = anySpot && !missingSpot ? toPlainDecimal(spotProduct) : null;

  // Price impact is what is left after fees: the venue's effective rate divided
  // by the fee-adjusted spot rate. This mirrors how SQS reports the two, so a
  // poolmanager quote and a router quote mean the same thing by "impact".
  let priceImpactPercent = 0;
  const effective = ratioOf(BigInt(amount), parseAmount(params.tokenInAmount, "tokenInAmount"));
  if (spotPrice !== null && effective !== null && spotProduct > 0) {
    const expected = spotProduct * (anyFee ? survivingValue : 1);
    if (expected > 0) priceImpactPercent = (1 - effective / expected) * 100;
  } else {
    warnings.push("Spot price unavailable; price impact is reported as 0.");
  }

  return { outAmount: amount, legs, spotPrice, feeFraction, priceImpactPercent, warnings };
}

/**
 * Price a swap on Osmosis.
 *
 * Venue selection, in order:
 * 1. {@link OsmosisSwapQuoteParams.router} present — ask the SQS router. With
 *    {@link OsmosisSwapQuoteParams.route} it asks `custom-direct-quote` for
 *    exactly that path, otherwise `quote` for the best one it can find.
 * 2. No router but a {@link OsmosisSwapQuoteParams.route} — chain single-pool
 *    poolmanager estimates along it.
 * 3. Neither — {@link findOsmosisPools} over
 *    {@link OsmosisSwapQuoteParams.candidatePoolIds}, then estimate each
 *    candidate and keep the best. Fails with `no-route` if no candidates were
 *    supplied, because the chain cannot search for pools by denom.
 *
 * `minReceived` is always derived here from
 * {@link OsmosisSwapQuoteParams.slippagePercent}; neither venue applies a
 * tolerance for us. It is a floor for the caller to enforce — this package does
 * not sign, so nothing here can bind the chain to it. The XCS memo builder
 * turns it into `min_output_amount`, or use {@link slippageToTwapParams}.
 *
 * @param params - The swap, the tolerance, and the venue clients.
 * @param lcd - The Osmosis chain LCD. Used for poolmanager quoting and pool
 *   discovery; a router-only quote still uses its `chainId` for the Osmosis check.
 * @throws {@link InterchainError} `unsupported-chain` when `lcd` is not
 *   Osmosis, `invalid-request` when the request itself is unusable,
 *   `no-route` when the pair cannot be priced,
 *   `slippage-exceeded` when the output is below
 *   {@link OsmosisSwapQuoteParams.minOutputAmount}, `malformed-response` when a
 *   venue answered with a shape the spec does not describe, and
 *   `lcd-unreachable` / `aborted` straight from {@link LcdClient}.
 */
export async function quoteOsmosisSwap(
  params: OsmosisSwapQuoteParams,
  lcd: LcdClient,
): Promise<OsmosisSwapQuote> {
  assertOsmosisChain(lcd, params);
  const { slippagePercent } = validateQuoteParams(params);
  const paths = resolvePaths(params.paths);
  const warnings: string[] = [];

  if (params.route !== undefined) {
    if (params.route.length === 0) {
      throw invalidRequest("route was supplied but is empty");
    }
    const last = params.route[params.route.length - 1];
    if (last === undefined || last.tokenOutDenom !== params.tokenOutDenom) {
      throw invalidRequest(
        `route ends in ${last?.tokenOutDenom ?? "nothing"}, not ${params.tokenOutDenom}`,
      );
    }
  }

  let quote: OsmosisSwapQuote;

  if (params.router) {
    const router = await quoteViaRouter(params, params.router, paths);
    const best = largestSplit(router.splits);
    if (router.splits.length > 1) {
      warnings.push(
        `Router split this order across ${router.splits.length} routes; ` +
          "SwapQuote.route shows the largest one, see splits for all of them.",
      );
    }
    // SQS signs price impact so that a trade moving the price against the user
    // is negative. SwapQuote.priceImpact is a cost, so it is positive there;
    // flip the sign rather than take an absolute value, so a rare favourable
    // quote still reads as favourable.
    const impactFraction =
      router.priceImpactFraction === null ? null : Number(router.priceImpactFraction);
    const priceImpact =
      impactFraction !== null && Number.isFinite(impactFraction)
        ? -impactFraction * 100
        : 0;
    const feeFraction =
      router.effectiveFeeFraction === null ? null : Number(router.effectiveFeeFraction);
    if (router.effectiveFeeFraction === null) {
      warnings.push("Router did not report a fee; poolFee is reported as 0.");
    }
    quote = {
      inputDenom: params.tokenInDenom,
      inputAmount: params.tokenInAmount,
      outputDenom: params.tokenOutDenom,
      outputAmount: router.outAmount,
      priceImpact,
      poolFee: feeFraction !== null && Number.isFinite(feeFraction) ? feeFraction * 100 : 0,
      minReceived: applySlippage(router.outAmount, slippagePercent),
      slippagePercent,
      route: best ? toSwapPoolHops(best.pools) : [],
      source: "router",
      splits: router.splits,
      spotPrice: router.spotPrice,
      effectiveFeeFraction: router.effectiveFeeFraction,
      warnings,
      fetchedAt: Date.now(),
    };
  } else {
    const routes = params.route
      ? [routeFromHops(params.tokenInDenom, params.route)]
      : await findOsmosisPools(
          {
            tokenInDenom: params.tokenInDenom,
            tokenOutDenom: params.tokenOutDenom,
            candidatePoolIds: params.candidatePoolIds,
            maxRoutes: params.maxRoutes,
            paths: params.paths,
            request: params.request,
          },
          lcd,
        );

    if (routes.length === 0) {
      throw new InterchainError(
        "no-route",
        `No Osmosis pool found for ${params.tokenInDenom} -> ${params.tokenOutDenom} ` +
          "among the supplied candidates",
        { chainId: lcd.chainId },
      );
    }

    let best: PoolmanagerQuote | null = null;
    let lastError: unknown;
    for (const candidate of routes) {
      try {
        const priced = await quoteViaPoolmanager(candidate.pools, params, lcd, paths);
        if (best === null || BigInt(priced.outAmount) > BigInt(best.outAmount)) {
          best = priced;
        }
      } catch (error) {
        // Keep going: candidates are guesses, and one dead pool should not
        // hide a live one. Only if every candidate fails do we surface it.
        lastError = error;
      }
    }
    if (best === null) {
      throw isInterchainError(lastError)
        ? lastError
        : new InterchainError(
            "no-route",
            `No Osmosis route priced ${params.tokenInDenom} -> ${params.tokenOutDenom}`,
            { chainId: lcd.chainId, cause: lastError },
          );
    }

    const feeFraction = best.feeFraction === null ? null : Number(best.feeFraction);
    quote = {
      inputDenom: params.tokenInDenom,
      inputAmount: params.tokenInAmount,
      outputDenom: params.tokenOutDenom,
      outputAmount: best.outAmount,
      priceImpact: best.priceImpactPercent,
      poolFee: feeFraction !== null && Number.isFinite(feeFraction) ? feeFraction * 100 : 0,
      minReceived: applySlippage(best.outAmount, slippagePercent),
      slippagePercent,
      route: toSwapPoolHops(best.legs),
      source: "poolmanager",
      splits: [
        { pools: best.legs, inAmount: params.tokenInAmount, outAmount: best.outAmount },
      ],
      spotPrice: best.spotPrice,
      effectiveFeeFraction: best.feeFraction,
      warnings: [...warnings, ...best.warnings],
      fetchedAt: Date.now(),
    };
  }

  if (params.minOutputAmount !== undefined) {
    const floor = parseAmount(params.minOutputAmount, "minOutputAmount");
    if (BigInt(quote.outputAmount) < floor) {
      throw new InterchainError(
        "slippage-exceeded",
        `Osmosis quoted ${quote.outputAmount} ${params.tokenOutDenom}, ` +
          `below the requested minimum of ${params.minOutputAmount}`,
        { chainId: lcd.chainId },
      );
    }
  }

  return quote;
}

/**
 * Turn a caller's `SwapPoolHop[]` into a route with per-leg input denoms.
 *
 * A `SwapPoolHop` only names the denom leaving each pool, so each leg's input
 * is the previous leg's output — which is what makes the hop list a valid route
 * description in the first place.
 */
function routeFromHops(
  tokenInDenom: string,
  hops: readonly SwapPoolHop[],
): OsmosisPoolRoute {
  const legs: OsmosisRouteLeg[] = [];
  let inDenom = tokenInDenom;
  for (const hop of hops) {
    legs.push({
      poolId: hop.poolId,
      tokenInDenom: inDenom,
      tokenOutDenom: hop.tokenOutDenom,
    });
    inDenom = hop.tokenOutDenom;
  }
  return { pools: legs, tokenInDenom, tokenOutDenom: inDenom };
}
