/**
 * ICS20 memo builders and inspection.
 *
 * The `memo` field of an ICS20 transfer is the only way one signature on the
 * source chain can drive work on chains further along the path: packet-forward-
 * middleware acts on a `forward` key, ibc-hooks acts on a `wasm` key. Both
 * middlewares fail closed on a memo they cannot parse, and "fail closed" is not
 * benign — for PFM the tokens stop on the intermediate chain credited to the
 * literal address `pfm`, which nobody holds a key for. A memo typo is a burned
 * transfer, so every builder here validates its inputs and throws
 * {@link InterchainError} `invalid-memo` rather than emitting something it is
 * not sure about, and nothing here ever truncates.
 *
 * This module never signs and never sends. It returns strings the caller puts
 * in `MsgTransfer.memo`; the signature is produced by zunia-core.
 *
 * Shapes come from `INTERCHAIN-SPEC.md` (the PFM README, the Osmosis
 * x/ibc-hooks README and the crosschain-swaps README). Where a shape is not
 * covered there it is modelled defensively and the comment says so.
 */

import { utf8ToBytes } from "./base64.js";
import {
  InterchainError,
  TRANSFER_PORT,
  type JsonObject,
  type JsonValue,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

/**
 * The receiver every intermediate PFM hop must carry.
 *
 * It is deliberately not a valid bech32 address on any chain. PFM decides to
 * forward from the memo, not from the receiver; the invalid receiver is the
 * safety net, because if forwarding is never attempted the transfer cannot be
 * credited to a real account the sender does not control. Not configurable:
 * `"pfm"` is the convention the middleware's own README uses, and a per-call
 * override would be a foot-gun with no upside.
 */
export const PFM_INTERMEDIATE_RECEIVER = "pfm";

/** PFM timeout when the caller does not pick one. Matches the README example. */
export const DEFAULT_PFM_TIMEOUT = "10m";

/** PFM retries when the caller does not pick one. Matches the README example. */
export const DEFAULT_PFM_RETRIES = 2;

/**
 * Default of the Cosmos SDK auth param `MaxMemoCharacters`, which bounds the
 * memo of a *transaction*, not of an ICS20 packet.
 *
 * Exported so a host that puts a memo built here into a transaction rather than
 * into a packet can pass it as {@link MemoLimits.warnBytes}. It is not the
 * default: a two-hop forward memo already exceeds it, so applying it to packet
 * memos would warn on almost every route and train users to ignore warnings.
 */
export const TX_MEMO_MAX_BYTES = 256;

/**
 * Ceiling applied to packet memos by default.
 *
 * TODO-VERIFY: ibc-go bounds the transfer packet memo far above the
 * transaction memo limit, and 32 KiB is the figure its transfer module uses
 * from memory — INTERCHAIN-SPEC.md says nothing about memo length. Treat it as
 * a *default* rather than a fact: a host that knows its chain's real limit
 * should pass {@link MemoLimits.maxBytes}, so a wrong constant here is a config
 * change and not a code change.
 */
export const PACKET_MEMO_MAX_BYTES = 32_768;

/**
 * Most forward hops a builder will emit.
 *
 * PFM imposes no protocol limit, but each hop multiplies the timeout and the
 * number of ways a transfer can strand, and the router caps routes at three.
 * Override with {@link ForwardMemoOptions.maxHops} if a host really needs more.
 */
export const MAX_FORWARD_HOPS = 8;

/** Nesting depth {@link validateMemo} will walk before giving up. */
const MAX_INSPECT_DEPTH = 16;

/** Nesting depth a caller-supplied JSON value may have. */
const MAX_JSON_DEPTH = 32;

/** Longest address string any builder accepts. Real bech32 tops out far below. */
const MAX_ADDRESS_LENGTH = 512;

/**
 * Go `time.ParseDuration` grammar, restricted to non-negative values.
 *
 * PFM parses `timeout` with Go's duration parser, which accepts concatenated
 * components ("1h30m"). Both spellings of the micro sign are allowed because Go
 * accepts `us`, `µs` and `μs`.
 */
const GO_DURATION = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|s|m|h))+$/;

/** ICS-24 identifier charset, used for channel and port ids. */
const IBC_IDENTIFIER = /^[a-zA-Z0-9._+#[\]<>-]{2,128}$/;

/** Unsigned decimal integer, e.g. an amount in base units. */
const UINT_DECIMAL = /^\d+$/;

/** Non-negative decimal, e.g. a slippage percentage. No exponent notation. */
const DECIMAL = /^\d+(?:\.\d+)?$/;

/**
 * Whether a string holds whitespace, a control character, or an invisible
 * character that would make two different addresses look identical.
 *
 * Written as a scan rather than a regex so the ranges are legible: everything
 * up to and including the space, DEL, the C1 block, NBSP, the Unicode line and
 * paragraph separators, and a byte-order mark. Any of those in an address means
 * a paste went wrong or someone is trying to make one address render as
 * another.
 */
function hasWhitespaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20) return true; // C0 controls and the space
    if (code === 0x7f) return true; // DEL
    if (code >= 0x80 && code <= 0xa0) return true; // C1 controls and NBSP
    if (code === 0x2028 || code === 0x2029) return true; // line/paragraph separator
    if (code === 0xfeff) return true; // byte-order mark
  }
  return false;
}

/** PFM's `forward` object keys. Anything else is unexpected and gets flagged. */
const FORWARD_KEYS: ReadonlySet<string> = new Set([
  "receiver",
  "port",
  "channel",
  "timeout",
  "retries",
  "next",
]);

/* -------------------------------------------------------------------------- *
 * Shared option types
 * -------------------------------------------------------------------------- */

/**
 * Byte-length bounds for a memo.
 *
 * Two thresholds, because a memo has two audiences: the chain, which rejects
 * the transaction outright past its limit, and the user, who should be told
 * when a memo is unusually large before signing. Builders enforce
 * {@link maxBytes} by throwing; {@link warnBytes} only ever produces a string
 * in {@link MemoInspection.warnings}. Nothing in this module truncates a memo —
 * a truncated forward memo is a valid-looking memo that sends funds nowhere.
 */
export interface MemoLimits {
  /** Hard ceiling in UTF-8 bytes. Default {@link PACKET_MEMO_MAX_BYTES}. */
  readonly maxBytes?: number;
  /**
   * Advisory threshold in UTF-8 bytes. Defaults to {@link maxBytes}, i.e. no
   * advisory warning. Set it to {@link TX_MEMO_MAX_BYTES} when the memo is
   * going into a transaction rather than into an ICS20 packet.
   */
  readonly warnBytes?: number;
}

/** Outcome of measuring a memo against {@link MemoLimits}. */
export interface MemoLengthReport {
  /** UTF-8 byte length. Chains count bytes, not UTF-16 code units. */
  readonly byteLength: number;
  readonly maxBytes: number;
  readonly warnBytes: number;
  readonly exceedsMax: boolean;
  readonly exceedsWarn: boolean;
  /** Human-readable note when a threshold is crossed, else `null`. */
  readonly warning: string | null;
}

/* -------------------------------------------------------------------------- *
 * Internal helpers
 * -------------------------------------------------------------------------- */

function fail(message: string): InterchainError {
  return new InterchainError("invalid-memo", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reject anything `JSON.stringify` would quietly rewrite.
 *
 * `NaN` and `Infinity` become `null`, `undefined` inside an array becomes
 * `null`, a `Date` becomes a string, and a `bigint` throws with a message that
 * says nothing about which field was wrong. Each of those turns a caller's bug
 * into a memo the middleware accepts and misreads, so they are caught here
 * along with the path that produced them.
 */
function assertJsonValue(
  value: unknown,
  path: string,
  seen: Set<object>,
  depth: number,
): void {
  if (depth > MAX_JSON_DEPTH) {
    throw fail(`${path} nests deeper than ${MAX_JSON_DEPTH} levels`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw fail(`${path} is ${String(value)}, which JSON encodes as null`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw fail(`${path} is a ${typeof value}, which has no JSON encoding`);
  }

  const node: object = value;
  if (seen.has(node)) throw fail(`${path} is part of a reference cycle`);
  seen.add(node);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      if (item === undefined) {
        throw fail(`${path}[${i}] is undefined, which JSON encodes as null`);
      }
      assertJsonValue(item, `${path}[${i}]`, seen, depth + 1);
    }
  } else {
    const proto: unknown = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      throw fail(`${path} is a class instance, not a plain JSON object`);
    }
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      // An `undefined` property is how a caller spells "omit this optional
      // field"; JSON.stringify drops it, which is the wire behaviour we want.
      if (item === undefined) continue;
      assertJsonValue(item, `${path}.${key}`, seen, depth + 1);
    }
  }

  seen.delete(node);
}

/** Validate a caller-supplied object and narrow it to {@link JsonObject}. */
function assertJsonObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw fail(`${label} must be a JSON object`);
  assertJsonValue(value, label, new Set<object>(), 0);
  // Safe after assertJsonValue: every reachable value is JSON-encodable.
  return value as JsonObject;
}

/**
 * Validate an address-like string.
 *
 * Deliberately not trimmed: silently accepting a pasted address with a trailing
 * newline would turn what the user reviewed into something else. Also
 * deliberately not bech32-checked — a receiver may be a contract, and prefixes
 * in this registry are not all `[a-z]+` (Safrochain uses `addr_safro`).
 */
function assertAddress(value: unknown, label: string): string {
  if (typeof value !== "string") throw fail(`${label} must be a string`);
  if (value.length === 0) throw fail(`${label} must not be empty`);
  if (value.length > MAX_ADDRESS_LENGTH) {
    throw fail(`${label} is longer than ${MAX_ADDRESS_LENGTH} characters`);
  }
  if (hasWhitespaceOrControl(value)) {
    throw fail(`${label} contains whitespace or a control character`);
  }
  return value;
}

/**
 * Validate an ICS-24 identifier (a channel or port id).
 *
 * Not normalised. The three implementations this package replaces normalise
 * `42` to `channel-42` at their UI boundary; doing it again inside a memo
 * builder would hide a caller passing the wrong thing entirely.
 */
function assertIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw fail(`${label} must be a string`);
  if (!IBC_IDENTIFIER.test(value)) {
    throw fail(`${label} is not a valid IBC identifier: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertTimeout(value: unknown, label: string): string {
  if (typeof value !== "string") throw fail(`${label} must be a duration string`);
  if (!GO_DURATION.test(value) || !/[1-9]/.test(value)) {
    throw fail(
      `${label} is not a positive Go duration, e.g. "10m": ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Validate PFM `retries`.
 *
 * TODO-VERIFY: PFM decodes it into a `uint8`, so anything outside 0-255 is
 * rejected by the middleware rather than clamped. That is the middleware's Go
 * type, read from memory; INTERCHAIN-SPEC.md only says "an integer".
 */
function assertRetries(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw fail(`${label} must be an integer`);
  }
  if (value < 0 || value > 255) throw fail(`${label} must be between 0 and 255`);
  return value;
}

/** Abbreviate an address for a one-line summary. Full values stay in the struct. */
function short(address: string): string {
  return address.length > 22 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address;
}

/* -------------------------------------------------------------------------- *
 * Byte length
 * -------------------------------------------------------------------------- */

/** UTF-8 byte length of a memo. Chains count bytes; `String.length` counts units. */
export function memoByteLength(memo: string): number {
  return utf8ToBytes(memo).length;
}

/**
 * Measure a memo against {@link MemoLimits} without throwing.
 *
 * Use this before showing a memo on a signing screen. Builders take the
 * throwing path instead; this one exists so a UI can warn rather than fail.
 */
export function checkMemoBytes(memo: string, limits: MemoLimits = {}): MemoLengthReport {
  const maxBytes = limits.maxBytes ?? PACKET_MEMO_MAX_BYTES;
  const warnBytes = limits.warnBytes ?? maxBytes;
  const byteLength = memoByteLength(memo);
  const exceedsMax = byteLength > maxBytes;
  const exceedsWarn = byteLength > warnBytes;

  let warning: string | null = null;
  if (exceedsMax) {
    warning = `Memo is ${byteLength} bytes, over the ${maxBytes}-byte limit. It will be rejected, not shortened.`;
  } else if (exceedsWarn) {
    warning =
      `Memo is ${byteLength} bytes, over the ${warnBytes}-byte advisory threshold. ` +
      `It is within the ${maxBytes}-byte limit, but a chain applying a tighter ` +
      `transaction memo limit would reject it.`;
  }

  return { byteLength, maxBytes, warnBytes, exceedsMax, exceedsWarn, warning };
}

function assertWithinLimit(memo: string, limits: MemoLimits): string {
  const report = checkMemoBytes(memo, limits);
  if (report.exceedsMax) {
    throw fail(
      `Memo is ${report.byteLength} bytes, over the ${report.maxBytes}-byte limit. ` +
        `Shorten the route, not the memo: a truncated forward memo still parses as ` +
        `text and sends the funds nowhere.`,
    );
  }
  return memo;
}

/* -------------------------------------------------------------------------- *
 * Packet-forward-middleware
 * -------------------------------------------------------------------------- */

/** One packet-forward-middleware hop, in execution order. */
export interface ForwardHop {
  /** Channel on the chain this hop leaves from, e.g. `channel-42`. */
  readonly channelId: string;
  /** Port on that channel. Defaults to {@link TRANSFER_PORT}. */
  readonly port?: string;
  /** Go duration for this hop. Defaults to the memo-wide timeout. */
  readonly timeout?: string;
  /** Retries for this hop, 0-255. Defaults to the memo-wide retries. */
  readonly retries?: number;
}

/** Options for {@link buildForwardMemo} and {@link buildForwardMemoJson}. */
export interface ForwardMemoOptions extends MemoLimits {
  /** Go duration applied to every hop without its own. Default `"10m"`. */
  readonly timeout?: string;
  /** Retries applied to every hop without its own. Default `2`. */
  readonly retries?: number;
  /**
   * Memo delivered with the final packet, nested under the last hop's `next`.
   *
   * This is how a forward chains into something else: pass the result of
   * {@link buildWasmHookMemoJson} to run a contract on the destination chain
   * once the last hop lands.
   */
  readonly next?: JsonObject;
  /** Hop-count ceiling. Default {@link MAX_FORWARD_HOPS}. */
  readonly maxHops?: number;
}

/**
 * Build the packet-forward-middleware memo as a JSON object.
 *
 * Prefer {@link buildForwardMemo} unless the result is being nested into
 * another memo (`next_memo` on a crosschain swap, say).
 *
 * @param hops - Hops after the transfer the user signs, in execution order.
 *   `hops[0]` is the channel the *first destination chain* forwards over.
 * @param finalReceiver - Address that receives the funds at the end of the
 *   chain. Only the last hop carries it; every earlier hop gets
 *   {@link PFM_INTERMEDIATE_RECEIVER}.
 * @throws {@link InterchainError} `invalid-memo` on an empty hop list, a bad
 *   identifier, a timeout that is not a Go duration, retries outside 0-255, or
 *   a `finalReceiver` equal to the intermediate sentinel.
 */
export function buildForwardMemoJson(
  hops: readonly ForwardHop[],
  finalReceiver: string,
  options: ForwardMemoOptions = {},
): JsonObject {
  if (!Array.isArray(hops) || hops.length === 0) {
    throw fail("A forward memo needs at least one hop");
  }
  const maxHops = options.maxHops ?? MAX_FORWARD_HOPS;
  if (hops.length > maxHops) {
    throw fail(`A forward memo may not have more than ${maxHops} hops, got ${hops.length}`);
  }

  const receiver = assertAddress(finalReceiver, "finalReceiver");
  if (receiver === PFM_INTERMEDIATE_RECEIVER) {
    throw fail(
      `finalReceiver must not be "${PFM_INTERMEDIATE_RECEIVER}": that is the ` +
        `intermediate sentinel and no key controls it`,
    );
  }

  const defaultTimeout = assertTimeout(
    options.timeout ?? DEFAULT_PFM_TIMEOUT,
    "options.timeout",
  );
  const defaultRetries = assertRetries(
    options.retries ?? DEFAULT_PFM_RETRIES,
    "options.retries",
  );
  const tail =
    options.next === undefined ? undefined : assertJsonObject(options.next, "options.next");

  // Built inside out: the innermost `forward` is the last hop, so each earlier
  // hop wraps what has been built so far in its own `next`.
  let next: JsonObject | undefined = tail;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (hop === undefined || !isRecord(hop)) throw fail(`hops[${i}] must be an object`);

    const forward: JsonObject = {
      // Key order follows the middleware README so a diff against it is trivial.
      receiver: i === hops.length - 1 ? receiver : PFM_INTERMEDIATE_RECEIVER,
      port: assertIdentifier(hop.port ?? TRANSFER_PORT, `hops[${i}].port`),
      channel: assertIdentifier(hop.channelId, `hops[${i}].channelId`),
      timeout:
        hop.timeout === undefined
          ? defaultTimeout
          : assertTimeout(hop.timeout, `hops[${i}].timeout`),
      retries:
        hop.retries === undefined
          ? defaultRetries
          : assertRetries(hop.retries, `hops[${i}].retries`),
      // Dropped by JSON.stringify when undefined, which is what the last hop
      // wants when the caller passed no trailing memo.
      next,
    };
    next = { forward };
  }

  // Assigned at least once, because `hops` is non-empty.
  if (next === undefined) throw fail("A forward memo needs at least one hop");
  return next;
}

/**
 * Build the packet-forward-middleware memo.
 *
 * `next` is emitted as a nested JSON **object**, not as the escaped JSON string
 * PFM also accepts. The object form is what the middleware README shows and it
 * is the only form that stays reviewable: in the string form each extra hop
 * doubles the backslashes ahead of it, so a three-hop memo is unreadable on a
 * signing screen, and a single escaping mistake produces a memo PFM treats as
 * opaque text — the packet is then delivered to the literal receiver `pfm` on
 * the intermediate chain and the funds are gone.
 *
 * @example One hop
 * ```json
 * {"forward":{"receiver":"osmo1...","port":"transfer","channel":"channel-42","timeout":"10m","retries":2}}
 * ```
 * @throws {@link InterchainError} `invalid-memo`; see {@link buildForwardMemoJson}.
 */
export function buildForwardMemo(
  hops: readonly ForwardHop[],
  finalReceiver: string,
  options: ForwardMemoOptions = {},
): string {
  return assertWithinLimit(
    JSON.stringify(buildForwardMemoJson(hops, finalReceiver, options)),
    options,
  );
}

/* -------------------------------------------------------------------------- *
 * ibc-hooks
 * -------------------------------------------------------------------------- */

/**
 * The ICS20 receiver an ibc-hooks transfer must carry.
 *
 * ibc-hooks accepts a receiver of `""` or one equal to the contract address
 * (INTERCHAIN-SPEC.md §2). This returns the contract address, because it is the
 * only one of the two that is reliably sendable: ibc-go's
 * `MsgTransfer.ValidateBasic` rejects a blank receiver before the packet is
 * ever built. It is also the value explorers display, so the packet reads as
 * "sent to the contract", which is what happens.
 *
 * TODO-VERIFY: the `ValidateBasic` claim is from memory, not from the spec. If
 * it is wrong the choice is still safe — the contract address is unambiguously
 * legal — and only the stated reason changes.
 *
 * Call this rather than passing an address by hand. The receiver of the
 * *transfer* and the `receiver` inside a swap message are different fields
 * holding different values, and confusing them is the easiest way to lose a
 * swap.
 */
export function wasmHookReceiver(contract: string): string {
  return assertAddress(contract, "contract");
}

/**
 * Whether an ICS20 receiver satisfies the ibc-hooks rule for a contract.
 *
 * Both legal values return true, so a receiver produced elsewhere can be
 * checked without being forced to match {@link wasmHookReceiver}.
 */
export function isWasmHookReceiverValid(receiver: string, contract: string): boolean {
  return receiver === "" || receiver === contract;
}

/**
 * Build the ibc-hooks memo as a JSON object.
 *
 * Every rule the middleware checks is enforced here, because the middleware
 * enforces them by erroring the packet:
 *
 * - the memo is a JSON object carrying a `wasm` key;
 * - `wasm` has **exactly** the two entries `contract` and `msg`;
 * - `msg` is a JSON object.
 *
 * The remaining rule — that the ICS20 receiver is `""` or the contract address
 * — is not visible from here; use {@link wasmHookReceiver} to satisfy it.
 *
 * @throws {@link InterchainError} `invalid-memo` if any rule is violated.
 */
export function buildWasmHookMemoJson(contract: string, msg: JsonObject): JsonObject {
  const address = assertAddress(contract, "contract");
  const body = assertJsonObject(msg, "msg");

  // A CosmWasm ExecuteMsg is a serde enum: it names exactly one variant, so an
  // empty object can never execute. Rejecting it here costs nothing and saves a
  // packet that would error on arrival.
  if (Object.keys(body).length === 0) {
    throw fail("msg is empty; a CosmWasm ExecuteMsg must name a variant");
  }

  const memo: JsonObject = { wasm: { contract: address, msg: body } };

  // Re-read what was just built through the same parser validateMemo uses.
  // Cheap, and it means the "exactly two keys" rule is checked against the
  // emitted object rather than against the intent.
  if (readWasmHook(memo.wasm) === null) {
    throw fail("Constructed wasm memo failed its own validation");
  }
  return memo;
}

/**
 * Build the ibc-hooks memo.
 *
 * Sender derivation on the destination chain is
 * `Bech32(Hash("ibc-wasm-hook-intermediary" || channelID || sender))`, so the
 * user needs no account on the destination chain, and the contract's execution
 * gas is paid by the relayer as part of packet processing rather than by the
 * user.
 *
 * @throws {@link InterchainError} `invalid-memo`; see {@link buildWasmHookMemoJson}.
 */
export function buildWasmHookMemo(
  contract: string,
  msg: JsonObject,
  limits: MemoLimits = {},
): string {
  return assertWithinLimit(JSON.stringify(buildWasmHookMemoJson(contract, msg)), limits);
}

/* -------------------------------------------------------------------------- *
 * Osmosis crosschain-swaps
 * -------------------------------------------------------------------------- */

/**
 * Slippage protection for an `osmosis_swap`.
 *
 * The contract accepts one of two shapes, and the discriminants below are the
 * wire keys so there is nothing to translate:
 * `{"twap":{"slippage_percentage":"20","window_seconds":10}}` or
 * `{"min_output_amount":"100"}`.
 */
export type XcsSlippage =
  | {
      readonly kind: "twap";
      /**
       * Percent as a decimal string, `"20"` meaning 20%. Range 0-100.
       *
       * Confirmed against swaprouter's `calculate_min_output_from_twap`, which
       * does `percentage_impact.div(Uint128::new(100))` before applying it, so
       * the wire value is a percentage and not a 0-1 fraction. Sending `"0.05"`
       * intending 5% would set a 0.05% tolerance and fail on any real move.
       */
      readonly slippagePercentage: string;
      /**
       * TWAP window in seconds.
       *
       * Optional on the contract (`window: Option<u64>`), which falls back to
       * `unwrap_or(3600)`. Omit to take that default rather than guessing a
       * window: a short window on a thin pool reads a noisier price.
       */
      readonly windowSeconds?: number;
    }
  | {
      readonly kind: "min_output_amount";
      /** Minimum output in base units, as a decimal string. */
      readonly minOutputAmount: string;
    };

/**
 * What the contract does when the swap succeeds but the outbound delivery
 * fails.
 *
 * Prefer `local_recovery_addr`. With `do_nothing` the swapped funds sit in the
 * crosschain-swaps contract with no recorded owner, so there is nobody for
 * `{"recover":{}}` to pay them to — they are stranded permanently. With a
 * recovery address the same failure leaves a claimable balance the wallet can
 * surface and recover. The difference costs one field.
 */
export type XcsFailedDelivery =
  | { readonly kind: "local_recovery_addr"; readonly address: string }
  | { readonly kind: "do_nothing" };

/** Inputs for {@link buildXcsSwapMemo}. */
export interface XcsSwapParams {
  /**
   * The crosschain-swaps contract on Osmosis.
   *
   * Must come from host config and be checked on-chain. The addresses seen in
   * Osmosis governance and docs are unverified candidates, and hardcoding one
   * here would send funds to whatever that address later becomes.
   */
  readonly contract: string;
  /** Denom to swap into, as Osmosis names it. */
  readonly outputDenom: string;
  /**
   * Who receives the swap output.
   *
   * This is **not** the ICS20 receiver of the transfer — that one must be
   * {@link wasmHookReceiver}(contract). This is the address the contract sends
   * the swapped tokens to, on whichever chain it resolves for that address.
   */
  readonly receiver: string;
  readonly slippage: XcsSlippage;
  readonly onFailedDelivery: XcsFailedDelivery;
  /**
   * Memo carried by the packet the contract sends onward, for chaining a
   * forward after the swap. Pass the result of {@link buildForwardMemoJson}.
   */
  readonly nextMemo?: JsonObject | null;
}

function slippageJson(slippage: XcsSlippage): JsonObject {
  if (!isRecord(slippage)) throw fail("slippage must be an object");
  if (slippage.kind === "twap") {
    const percentage: unknown = slippage.slippagePercentage;
    if (typeof percentage !== "string" || !DECIMAL.test(percentage)) {
      throw fail('slippage.slippagePercentage must be a decimal string, e.g. "20"');
    }
    // A percentage on a 0-100 scale: swaprouter divides by 100 before use.
    if (Number(percentage) > 100) {
      throw fail("slippage.slippagePercentage must be between 0 and 100");
    }
    const window: unknown = slippage.windowSeconds;
    // Optional on the contract, which defaults to 3600. Omitting the key is
    // therefore meaningfully different from sending one, so only emit it when
    // the caller actually chose a window.
    if (window === undefined) {
      return { twap: { slippage_percentage: percentage } };
    }
    if (typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0) {
      throw fail("slippage.windowSeconds must be a positive integer when given");
    }
    return { twap: { slippage_percentage: percentage, window_seconds: window } };
  }
  if (slippage.kind === "min_output_amount") {
    const amount: unknown = slippage.minOutputAmount;
    if (typeof amount !== "string" || !UINT_DECIMAL.test(amount)) {
      throw fail("slippage.minOutputAmount must be an integer string in base units");
    }
    return { min_output_amount: amount };
  }
  throw fail(`Unknown slippage kind: ${JSON.stringify((slippage as { kind?: unknown }).kind)}`);
}

function failedDeliveryJson(action: XcsFailedDelivery): JsonValue {
  if (!isRecord(action)) throw fail("onFailedDelivery must be an object");
  if (action.kind === "do_nothing") return "do_nothing";
  if (action.kind === "local_recovery_addr") {
    return { local_recovery_addr: assertAddress(action.address, "onFailedDelivery.address") };
  }
  throw fail(
    `Unknown onFailedDelivery kind: ${JSON.stringify((action as { kind?: unknown }).kind)}`,
  );
}

/**
 * Build the Osmosis crosschain-swaps memo as a JSON object.
 *
 * It is an ibc-hooks memo whose `msg` is `{"osmosis_swap":{...}}`, so it
 * inherits every rule {@link buildWasmHookMemoJson} enforces.
 *
 * @throws {@link InterchainError} `invalid-memo` on a malformed slippage,
 *   failure action, address or next memo.
 */
export function buildXcsSwapMemoJson(params: XcsSwapParams): JsonObject {
  if (!isRecord(params)) throw fail("params must be an object");
  const contract = assertAddress(params.contract, "contract");
  const outputDenom: unknown = params.outputDenom;
  if (typeof outputDenom !== "string" || outputDenom.length === 0) {
    throw fail("outputDenom must be a non-empty string");
  }
  if (hasWhitespaceOrControl(outputDenom)) {
    throw fail("outputDenom contains whitespace or a control character");
  }
  const receiver = assertAddress(params.receiver, "receiver");
  const nextMemo =
    params.nextMemo === undefined || params.nextMemo === null
      ? null
      : assertJsonObject(params.nextMemo, "nextMemo");

  const swap: JsonObject = {
    // Key order follows the crosschain-swaps README example.
    output_denom: outputDenom,
    slippage: slippageJson(params.slippage),
    receiver,
    on_failed_delivery: failedDeliveryJson(params.onFailedDelivery),
    // TODO-VERIFY: emitted even when absent. The README example spells it
    // `null`, and we have not verified that the contract's field carries a
    // serde default, so
    // omitting the key risks a deserialisation error on arrival.
    next_memo: nextMemo,
  };

  return buildWasmHookMemoJson(contract, { osmosis_swap: swap });
}

/**
 * Build the Osmosis crosschain-swaps memo.
 *
 * The transfer that carries it must set its ICS20 receiver to
 * {@link wasmHookReceiver}(params.contract) — not to
 * {@link XcsSwapParams.receiver}, which is where the *output* goes.
 *
 * @throws {@link InterchainError} `invalid-memo`; see {@link buildXcsSwapMemoJson}.
 */
export function buildXcsSwapMemo(params: XcsSwapParams, limits: MemoLimits = {}): string {
  return assertWithinLimit(JSON.stringify(buildXcsSwapMemoJson(params)), limits);
}

/* -------------------------------------------------------------------------- *
 * Inspection
 * -------------------------------------------------------------------------- */

/**
 * What a memo will do, as far as we can prove.
 *
 * - `empty` — no memo.
 * - `plain-text` — not a JSON object. Inert: PFM and ibc-hooks both unmarshal
 *   the memo into a map and look for a key, so text, numbers and arrays reach
 *   neither. Exchange deposit memos land here.
 * - `forward` — packet-forward-middleware will move the funds on.
 * - `wasm` — ibc-hooks will call a contract on arrival.
 * - `xcs` — that contract call is an Osmosis crosschain swap.
 * - `unknown` — a JSON object we could not fully account for. Never treat this
 *   as safe: it may be middleware we do not model, or a `forward` we could not
 *   read.
 */
export type MemoKind = "empty" | "plain-text" | "forward" | "wasm" | "xcs" | "unknown";

/** One hop read out of a forward memo. */
export interface ForwardHopInfo {
  readonly receiver: string;
  readonly port: string;
  readonly channelId: string;
  /** `null` when the hop omits it and PFM's own default applies. */
  readonly timeout: string | null;
  /** `null` when the hop omits it and PFM's own default applies. */
  readonly retries: number | null;
}

/** The forward chain read out of a memo. */
export interface ForwardMemoInfo {
  /** Hops in execution order. */
  readonly hops: readonly ForwardHopInfo[];
  /** Receiver on the last hop: where the funds actually end up. */
  readonly finalReceiver: string;
  /** True when the last hop carries a further memo. */
  readonly hasNextMemo: boolean;
}

/** The ibc-hooks call read out of a memo. */
export interface WasmHookInfo {
  readonly contract: string;
  readonly msg: JsonObject;
  /** Top-level keys of `msg`. A CosmWasm ExecuteMsg names exactly one. */
  readonly msgKeys: readonly string[];
}

/** The crosschain swap read out of a memo. */
export interface XcsSwapInfo {
  readonly contract: string;
  readonly outputDenom: string;
  readonly receiver: string;
  readonly slippage: XcsSlippage;
  readonly onFailedDelivery: XcsFailedDelivery;
  readonly hasNextMemo: boolean;
}

/**
 * A classified memo.
 *
 * {@link forward}, {@link wasm} and {@link xcs} report what could be read, not
 * a verdict — they may be populated while {@link kind} is `unknown`, when part
 * of the memo parsed and part did not. Branch on {@link kind}.
 */
export interface MemoInspection {
  readonly kind: MemoKind;
  /** One line for a signing screen. Plain, factual, safe to render verbatim. */
  readonly summary: string;
  /** UTF-8 byte length of the memo as given. */
  readonly byteLength: number;
  /** Things worth showing before the user approves. Not errors. */
  readonly warnings: readonly string[];
  /** True when a `forward` object appears anywhere in the memo. */
  readonly requiresPfm: boolean;
  /** True when a `wasm` object appears anywhere in the memo. */
  readonly requiresIbcHooks: boolean;
  readonly forward: ForwardMemoInfo | null;
  readonly wasm: WasmHookInfo | null;
  readonly xcs: XcsSwapInfo | null;
}

/** Options for {@link validateMemo}. */
export interface ValidateMemoOptions extends MemoLimits {
  /**
   * The ICS20 receiver the transfer carrying this memo will use.
   *
   * When given, a `wasm` memo is cross-checked against it: ibc-hooks only runs
   * when the receiver is `""` or the contract address, and a mismatch means the
   * hook is skipped and the funds simply land at whatever the receiver is.
   */
  readonly receiver?: string;
}

/** Non-throwing read of an ibc-hooks `wasm` object. `null` when a rule fails. */
function readWasmHook(value: unknown): WasmHookInfo | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  // The middleware's own rule: exactly two entries, `contract` and `msg`.
  if (keys.length !== 2) return null;
  if (!keys.includes("contract") || !keys.includes("msg")) return null;
  const contract: unknown = value.contract;
  const msg: unknown = value.msg;
  if (typeof contract !== "string" || contract.length === 0) return null;
  if (!isRecord(msg)) return null;
  // Came from JSON.parse, or from a builder that already validated it.
  return { contract, msg: msg as JsonObject, msgKeys: Object.keys(msg) };
}

function readSlippage(value: unknown): XcsSlippage | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  if (keys[0] === "twap") {
    const twap: unknown = value.twap;
    if (!isRecord(twap)) return null;
    const percentage: unknown = twap.slippage_percentage;
    const window: unknown = twap.window_seconds;
    if (typeof percentage !== "string" || !DECIMAL.test(percentage)) return null;
    if (typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0) return null;
    return { kind: "twap", slippagePercentage: percentage, windowSeconds: window };
  }
  if (keys[0] === "min_output_amount") {
    const amount: unknown = value.min_output_amount;
    if (typeof amount !== "string" || !UINT_DECIMAL.test(amount)) return null;
    return { kind: "min_output_amount", minOutputAmount: amount };
  }
  return null;
}

function readFailedDelivery(value: unknown): XcsFailedDelivery | null {
  if (value === "do_nothing") return { kind: "do_nothing" };
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "local_recovery_addr") {
      const address: unknown = value.local_recovery_addr;
      if (typeof address === "string" && address.length > 0) {
        return { kind: "local_recovery_addr", address };
      }
    }
  }
  return null;
}

function readXcsSwap(hook: WasmHookInfo): XcsSwapInfo | null {
  if (hook.msgKeys.length !== 1 || hook.msgKeys[0] !== "osmosis_swap") return null;
  const swap: unknown = hook.msg.osmosis_swap;
  if (!isRecord(swap)) return null;
  const outputDenom: unknown = swap.output_denom;
  const receiver: unknown = swap.receiver;
  if (typeof outputDenom !== "string" || outputDenom.length === 0) return null;
  if (typeof receiver !== "string" || receiver.length === 0) return null;
  const slippage = readSlippage(swap.slippage);
  if (slippage === null) return null;
  const onFailedDelivery = readFailedDelivery(swap.on_failed_delivery);
  if (onFailedDelivery === null) return null;
  const nextMemo: unknown = swap.next_memo;
  return {
    contract: hook.contract,
    outputDenom,
    receiver,
    slippage,
    onFailedDelivery,
    hasNextMemo: nextMemo !== undefined && nextMemo !== null,
  };
}

/** Result of walking a chain of nested `forward` objects. */
interface ForwardWalk {
  readonly info: ForwardMemoInfo | null;
  /** Memo left over after the last hop, or `undefined` when there is none. */
  readonly tail: unknown;
  /** Why the walk stopped short, or `null` when it completed. */
  readonly problem: string | null;
}

function stopped(problem: string): ForwardWalk {
  return { info: null, tail: undefined, problem };
}

function walkForward(root: Record<string, unknown>, warnings: string[]): ForwardWalk {
  const hops: ForwardHopInfo[] = [];
  let node: unknown = root;
  let tail: unknown;

  for (let depth = 0; depth <= MAX_INSPECT_DEPTH; depth++) {
    // PFM also accepts `next` as an escaped JSON string. We never emit that
    // form, but a memo built elsewhere may use it, so it is parsed here rather
    // than reported as unreadable.
    if (typeof node === "string") {
      try {
        node = JSON.parse(node) as unknown;
      } catch {
        return stopped("a nested memo is a string that is not JSON");
      }
      warnings.push("Memo uses the escaped-string form for a nested hop.");
    }
    if (!isRecord(node)) return stopped("a nested memo is not a JSON object");

    const forward: unknown = node.forward;
    if (forward === undefined) {
      // Not a hop: this is the memo delivered with the final packet.
      tail = node;
      break;
    }
    if (Object.keys(node).length !== 1) {
      return stopped("a forward memo carries other top-level keys alongside `forward`");
    }
    if (!isRecord(forward)) return stopped("`forward` is not a JSON object");

    const receiver: unknown = forward.receiver;
    const port: unknown = forward.port;
    const channel: unknown = forward.channel;
    if (typeof receiver !== "string" || receiver.length === 0) {
      return stopped("a hop has no `receiver`");
    }
    if (typeof port !== "string" || !IBC_IDENTIFIER.test(port)) {
      return stopped("a hop has no valid `port`");
    }
    if (typeof channel !== "string" || !IBC_IDENTIFIER.test(channel)) {
      return stopped("a hop has no valid `channel`");
    }

    let timeout: string | null = null;
    const rawTimeout: unknown = forward.timeout;
    if (rawTimeout !== undefined && rawTimeout !== null) {
      if (typeof rawTimeout === "string") {
        if (!GO_DURATION.test(rawTimeout)) {
          return stopped("a hop `timeout` is not a Go duration");
        }
        timeout = rawTimeout;
      } else if (
        typeof rawTimeout === "number" &&
        Number.isSafeInteger(rawTimeout) &&
        rawTimeout >= 0
      ) {
        // Defensive, not in the spec: older PFM builders encoded the timeout as
        // an integer count of nanoseconds, and some still do.
        timeout = `${rawTimeout}ns`;
        warnings.push("A hop timeout uses the legacy integer-nanoseconds form.");
      } else {
        return stopped("a hop `timeout` is neither a duration nor an integer");
      }
    }

    let retries: number | null = null;
    const rawRetries: unknown = forward.retries;
    if (rawRetries !== undefined && rawRetries !== null) {
      if (
        typeof rawRetries !== "number" ||
        !Number.isInteger(rawRetries) ||
        rawRetries < 0 ||
        rawRetries > 255
      ) {
        return stopped("a hop `retries` is not an integer in 0-255");
      }
      retries = rawRetries;
    }

    for (const key of Object.keys(forward)) {
      if (!FORWARD_KEYS.has(key)) {
        warnings.push(`Forward hop carries an unrecognised field \`${key}\`.`);
      }
    }

    hops.push({ receiver, port, channelId: channel, timeout, retries });

    const next: unknown = forward.next;
    if (next === undefined || next === null) {
      tail = undefined;
      break;
    }
    if (depth === MAX_INSPECT_DEPTH) {
      return stopped(`memo nests more than ${MAX_INSPECT_DEPTH} levels`);
    }
    node = next;
  }

  const last = hops[hops.length - 1];
  if (last === undefined) return stopped("no forward hop could be read");

  return {
    info: { hops, finalReceiver: last.receiver, hasNextMemo: tail !== undefined },
    tail,
    problem: null,
  };
}

function describeSlippage(slippage: XcsSlippage): string {
  return slippage.kind === "twap"
    ? `up to ${slippage.slippagePercentage}% off the ${slippage.windowSeconds}s average price`
    : `at least ${slippage.minOutputAmount} base units out`;
}

function describeForward(info: ForwardMemoInfo): string {
  const channels = info.hops.map((hop) => hop.channelId).join(", then ");
  const count = info.hops.length === 1 ? "one more hop" : `${info.hops.length} more hops`;
  return `On arrival, forwards ${count} (${channels}) and pays ${short(info.finalReceiver)}.`;
}

const UNKNOWN_SUMMARY =
  "Unrecognised memo. Zunia cannot tell what this will do on arrival; approve only if you trust the source.";

const DO_NOTHING_WARNING =
  "The swap sets on_failed_delivery to do_nothing: if the swap succeeds but delivery fails, the funds cannot be recovered.";

/**
 * Classify a memo string.
 *
 * This is a security control for the signing screen: before a user approves a
 * transfer, they should be told what its memo will actually do. It is therefore
 * conservative — anything that cannot be fully accounted for comes back as
 * `unknown`, never as safe — and it never throws, so a hostile memo cannot
 * break the screen that is supposed to describe it.
 *
 * @param memo - The memo exactly as it will be signed.
 * @returns A classification. See {@link MemoInspection}.
 */
export function validateMemo(
  memo: string,
  options: ValidateMemoOptions = {},
): MemoInspection {
  // Hosts pass this straight from a dApp request, so a non-string is possible
  // however well-typed the call site looks.
  const text = typeof memo === "string" ? memo : "";
  const warnings: string[] = [];
  const lengthReport = checkMemoBytes(text, options);
  if (lengthReport.warning !== null) warnings.push(lengthReport.warning);

  const base = {
    byteLength: lengthReport.byteLength,
    requiresPfm: false,
    requiresIbcHooks: false,
    forward: null,
    wasm: null,
    xcs: null,
  } as const;

  if (text.trim().length === 0) {
    return { ...base, kind: "empty", summary: "No memo.", warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // PFM and ibc-hooks both unmarshal the memo into a JSON object and look for
    // a key; anything that is not valid JSON reaches neither.
    return {
      ...base,
      kind: "plain-text",
      summary: "Plain text memo. No IBC middleware reads it.",
      warnings,
    };
  }

  if (!isRecord(parsed)) {
    // Same reasoning: a JSON scalar or array does not unmarshal into the map
    // the middlewares read, so it is as inert as free text. Exchange deposit
    // memos are usually bare digits and land here.
    return {
      ...base,
      kind: "plain-text",
      summary: "Memo is JSON but not an object, so no IBC middleware reads it.",
      warnings,
    };
  }

  const hasForward = parsed.forward !== undefined;
  const hasWasm = parsed.wasm !== undefined;

  if (hasForward && hasWasm) {
    // Both middlewares would claim this packet and we cannot say which wins on
    // a given chain's middleware stack, so we refuse to describe it.
    warnings.push("Memo carries both `forward` and `wasm` at the top level.");
    return {
      ...base,
      kind: "unknown",
      summary: UNKNOWN_SUMMARY,
      warnings,
      requiresPfm: true,
      requiresIbcHooks: true,
    };
  }

  if (hasForward) return inspectForward(parsed, base, warnings);
  if (hasWasm) return inspectWasm(parsed, base, warnings, options);

  // A JSON object with no key we model. Other middleware exists (IBC callbacks,
  // async-icq, chain-specific hooks) and we cannot enumerate it, so this is
  // reported as unknown rather than as inert.
  warnings.push(`Memo is a JSON object with unrecognised keys: ${Object.keys(parsed).join(", ")}.`);
  return { ...base, kind: "unknown", summary: UNKNOWN_SUMMARY, warnings };
}

/** Fields every {@link validateMemo} return shares, filled in before branching. */
type InspectionBase = Pick<
  MemoInspection,
  "byteLength" | "requiresPfm" | "requiresIbcHooks" | "forward" | "wasm" | "xcs"
>;

function inspectForward(
  parsed: Record<string, unknown>,
  base: InspectionBase,
  warnings: string[],
): MemoInspection {
  const walk = walkForward(parsed, warnings);
  if (walk.info === null) {
    warnings.push(`Forward memo could not be read: ${walk.problem ?? "unknown reason"}.`);
    return { ...base, kind: "unknown", summary: UNKNOWN_SUMMARY, warnings, requiresPfm: true };
  }

  const info = walk.info;
  for (let i = 0; i < info.hops.length - 1; i++) {
    const hop = info.hops[i];
    if (hop !== undefined && hop.receiver !== PFM_INTERMEDIATE_RECEIVER) {
      warnings.push(
        `Hop ${i + 1} names a real receiver (${short(hop.receiver)}) instead of "${PFM_INTERMEDIATE_RECEIVER}".`,
      );
    }
  }
  if (info.finalReceiver === PFM_INTERMEDIATE_RECEIVER) {
    warnings.push(
      `The final receiver is "${PFM_INTERMEDIATE_RECEIVER}", which is not a real address. The funds would be unrecoverable.`,
    );
  }

  let summary = describeForward(info);

  if (walk.tail === undefined) {
    return { ...base, kind: "forward", summary, warnings, requiresPfm: true, forward: info };
  }

  // The last hop carries a further memo. Only a wasm hook is modelled; a tail
  // we cannot read makes the whole memo unclassifiable, because it decides what
  // happens to the funds at the end of the path.
  const tail = walk.tail;
  if (!isRecord(tail) || tail.wasm === undefined) {
    warnings.push("The memo delivered after the last hop is not one Zunia recognises.");
    return {
      ...base,
      kind: "unknown",
      summary: UNKNOWN_SUMMARY,
      warnings,
      requiresPfm: true,
      forward: info,
    };
  }

  const hook = readWasmHook(tail.wasm);
  if (hook === null) {
    warnings.push("The contract call after the last hop does not follow the ibc-hooks rules.");
    return {
      ...base,
      kind: "unknown",
      summary: UNKNOWN_SUMMARY,
      warnings,
      requiresPfm: true,
      requiresIbcHooks: true,
      forward: info,
    };
  }

  const swap = readXcsSwap(hook);
  if (swap === null && hook.msgKeys.length === 1 && hook.msgKeys[0] === "osmosis_swap") {
    warnings.push("The swap after the last hop could not be read.");
    return {
      ...base,
      kind: "unknown",
      summary: UNKNOWN_SUMMARY,
      warnings,
      requiresPfm: true,
      requiresIbcHooks: true,
      forward: info,
      wasm: hook,
    };
  }

  if (swap === null) {
    summary += ` Then calls contract ${short(hook.contract)} with ${hook.msgKeys.join(", ")}.`;
  } else {
    summary += ` Then swaps to ${swap.outputDenom} (${describeSlippage(swap.slippage)}) and pays ${short(swap.receiver)}.`;
    if (swap.onFailedDelivery.kind === "do_nothing") warnings.push(DO_NOTHING_WARNING);
  }

  return {
    ...base,
    kind: swap === null ? "forward" : "xcs",
    summary,
    warnings,
    requiresPfm: true,
    requiresIbcHooks: true,
    forward: info,
    wasm: hook,
    xcs: swap,
  };
}

function inspectWasm(
  parsed: Record<string, unknown>,
  base: InspectionBase,
  warnings: string[],
  options: ValidateMemoOptions,
): MemoInspection {
  if (Object.keys(parsed).length !== 1) {
    warnings.push("Memo carries other top-level keys alongside `wasm`.");
    return { ...base, kind: "unknown", summary: UNKNOWN_SUMMARY, warnings, requiresIbcHooks: true };
  }

  const hook = readWasmHook(parsed.wasm);
  if (hook === null) {
    warnings.push(
      "The `wasm` object does not have exactly the two fields `contract` and `msg` with an object `msg`, so ibc-hooks will error the packet.",
    );
    return { ...base, kind: "unknown", summary: UNKNOWN_SUMMARY, warnings, requiresIbcHooks: true };
  }

  if (options.receiver !== undefined && !isWasmHookReceiverValid(options.receiver, hook.contract)) {
    warnings.push(
      "The transfer receiver is neither empty nor the contract address, so ibc-hooks will not run this call.",
    );
  }
  if (hook.msgKeys.length !== 1) {
    warnings.push("The contract message does not name exactly one ExecuteMsg variant.");
  }

  const swap = readXcsSwap(hook);
  if (swap === null) {
    if (hook.msgKeys.length === 1 && hook.msgKeys[0] === "osmosis_swap") {
      warnings.push("The memo claims to be a crosschain swap but its fields could not be read.");
      return {
        ...base,
        kind: "unknown",
        summary: UNKNOWN_SUMMARY,
        warnings,
        requiresIbcHooks: true,
        wasm: hook,
      };
    }
    return {
      ...base,
      kind: "wasm",
      summary: `On arrival, calls contract ${short(hook.contract)} with ${hook.msgKeys.join(", ")}.`,
      warnings,
      requiresIbcHooks: true,
      wasm: hook,
    };
  }

  let summary = `On arrival, swaps to ${swap.outputDenom} (${describeSlippage(swap.slippage)}) and pays ${short(swap.receiver)}.`;
  if (swap.onFailedDelivery.kind === "do_nothing") {
    summary += " Recovery is off.";
    warnings.push(DO_NOTHING_WARNING);
  } else {
    summary += ` Recovery address ${short(swap.onFailedDelivery.address)}.`;
  }
  if (swap.slippage.kind === "min_output_amount" && swap.slippage.minOutputAmount === "0") {
    warnings.push("Minimum output is 0, which accepts any price.");
  }
  if (swap.hasNextMemo) summary += " The output is then forwarded on.";

  return {
    ...base,
    kind: "xcs",
    summary,
    warnings,
    requiresIbcHooks: true,
    wasm: hook,
    xcs: swap,
  };
}
