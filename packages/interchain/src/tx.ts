/**
 * The transaction pipeline: everything around signing, and none of signing.
 *
 * This module gathers what the signer needs before it can build sign bytes
 * (account number, sequence, gas, fee) and it handles what the signer produced
 * afterwards (broadcast, inclusion polling). It never holds a private key, never
 * derives one, and never produces a signature. Signing stays in zunia-core
 * (Rust/WASM/FFI); this package only moves JSON.
 *
 * # The gap this module makes visible
 *
 * Today the platform cannot broadcast a real transaction, and the reason is not
 * this file. `zunia-core/crates/cosmos` already implements `UnsignedTx`, `Fee`,
 * `SignerData`, both sign modes and the full `Msg` enum — including
 * `IbcTransfer { …, memo }` and `ExecuteContract` — but the bindings expose only
 * one hard-coded builder:
 *
 * - `zunia-core/crates/wasm/src/lib.rs` → `build_bank_send_direct(…)`, thirteen
 *   flat scalar arguments, `MsgSend` only, `SIGN_MODE_DIRECT` only.
 * - `zunia-core/crates/ffi/src/lib.rs` → `zunia_build_bank_send_direct(…)`, same
 *   restriction.
 * - `zunia-core/packages/npm` is an empty `.gitkeep`, so the extension falls
 *   back to `zunia-extension/lib/kernel.ts` (`createLocalKernel`), which has no
 *   transaction builder at all.
 *
 * What is missing is a single generic export on both bindings, roughly
 * `build_unsigned_tx(request_json: &str) -> String` (sign bytes, hex), that
 * deserialises the payload {@link buildUnsignedTxRequest} produces into
 * `UnsignedTx` + `SignerData` and calls `UnsignedTx::sign_bytes`. Until that
 * lands, `zunia-extension/lib/provider-handler.ts:317` keeps returning a mock
 * hash: `broadcast()` below is ready, but nothing upstream of it can produce
 * signed bytes for anything other than a bank send.
 *
 * {@link buildUnsignedTxRequest} is written against the Rust structs as they
 * exist now (snake_case field names, `u64` values as decimal strings), so that
 * widening the binding is additive and does not reshape this payload.
 *
 * # Two notes on how this module talks to the network
 *
 * 1. Reads go through {@link LcdClient}, as everywhere else in this package.
 * 2. Simulate and broadcast are POSTs, and {@link LcdClient} is GET-only, so
 *    they take an `LcdPostClient` instead. That port and its transport live in
 *    `lcd.ts` with every other `fetch` in the package; `LcdClientHandle`
 *    already satisfies it, so a host that built its client with
 *    `createLcdClient` passes the same object here.
 */

import { encodeBase64, utf8ToBytes } from "./base64.js";
import type { LcdPostClient } from "./lcd.js";
// The SDK's `MaxMemoCharacters` default. One definition, in the module that
// also has to respect it when building packet memos.
import { TX_MEMO_MAX_BYTES } from "./memo.js";
import {
  InterchainError,
  isInterchainError,
  type AccountInfo,
  type BroadcastResult,
  type BuiltMsg,
  type ChainInfoLike,
  type Coin,
  type FeeEstimate,
  type JsonObject,
  type LcdClient,
  type LcdRequestOptions,
  type PubKeyInfo,
  type TxStatus,
  type TxStatusState,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

/**
 * Safety multiplier applied to simulated gas.
 *
 * 1.4 rather than the more common 1.3: simulation runs against the state at the
 * head of the chain, and by the time the transaction is included that state has
 * moved. A CosmWasm execution or an IBC transfer that touches a newly created
 * store entry costs more than the simulation said.
 */
export const DEFAULT_GAS_ADJUSTMENT = 1.4;

/** How deep account wrappers nest: `…VestingAccount → base_vesting_account → base_account`. */
const MAX_ACCOUNT_NESTING = 4;

/** Keys a wrapper account nests the real `BaseAccount` under, in unwrap order. */
const ACCOUNT_NESTING_KEYS = ["base_account", "base_vesting_account"] as const;

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_MAX_POLL_INTERVAL_MS = 8_000;
const DEFAULT_POLL_BACKOFF = 1.5;

/**
 * Rejects anything that could escape the URL path.
 *
 * A bech32 checksum check belongs in zunia-core, not here; this only has to
 * guarantee that `/cosmos/auth/v1beta1/accounts/${address}` addresses an
 * account and not `../../..`. Note the underscore: Safrochain's prefix is
 * `addr_safro`, which is one prefix and not `addr` plus `safro`, so the
 * character class must include `_` and the separator is the last `1`.
 */
const SAFE_ADDRESS = /^[A-Za-z0-9_-]+1[A-Za-z0-9]{6,}$/;

/** Cosmos transaction hashes are SHA-256 of the tx bytes, hex, 64 characters. */
const TX_HASH = /^[0-9A-Fa-f]{64}$/;

/* -------------------------------------------------------------------------- *
 * JSON narrowing
 * -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Normalise a uint64 field to a canonical decimal string.
 *
 * The wire type is a string, but nodes and gateways disagree: some emit a JSON
 * number, some pad (`"007"`), and proto-JSON omits the field entirely when it
 * is zero. Anything that is not a non-negative integer returns `null` so the
 * caller can decide between "absent, use 0" and "present but wrong, malformed".
 */
function asUint(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  return text.replace(/^0+(?=\d)/, "");
}

function malformed(chainId: string, detail: string): InterchainError {
  return new InterchainError("malformed-response", `${chainId}: ${detail}`, {
    chainId,
  });
}

/** The gRPC-gateway error shape: `{ code, message, details }`. */
function serverMessage(body: unknown): string {
  const row = asRecord(body);
  if (!row) return "";
  return asString(row["message"]) ?? asString(row["error"]) ?? "";
}

/* -------------------------------------------------------------------------- *
 * Accounts
 * -------------------------------------------------------------------------- */

/** Per-call knobs for {@link getAccount}. */
export interface GetAccountOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * Caching is off by default and should stay off.
   *
   * A cached `sequence` produces a signature the chain rejects with code 32 the
   * moment the user sends two transactions in a row. Set this only for a
   * read-only view that never signs.
   */
  readonly cacheTtlMs?: number;
}

/**
 * True when the public key the node reports is an Ethermint `ethsecp256k1` key.
 *
 * The signer needs this: it selects the `Any` type URL and the Amino registry
 * name in `SignerData`, and both are part of the signed bytes. Matching on the
 * type URL rather than on a chain-id allowlist means a new Ethermint chain
 * works without a code change.
 */
export function isEthSecp256k1PubKey(pubKey: PubKeyInfo | null): boolean {
  if (!pubKey) return false;
  return /ethsecp256k1/i.test(pubKey.typeUrl);
}

/**
 * Read an account's number, sequence and public key.
 *
 * This is the single most common source of silent signing failures, for two
 * reasons, and both are handled here:
 *
 * 1. **Wrappers.** `BaseAccount` is what the signer needs, but chains hand it
 *    back inside `ModuleAccount`, `EthAccount` (Ethermint and Injective, under
 *    different type URLs), `BaseVestingAccount`, and the
 *    `Continuous/Delayed/Periodic/PermanentLocked` vesting family, which nests
 *    twice: `base_vesting_account.base_account`. Reading `account_number` off
 *    the outer object yields `undefined`, which becomes 0, which produces a
 *    signature over the wrong sign doc.
 * 2. **Absence.** An address that has never received funds is not an error. The
 *    node answers 404, or 200 with a gRPC `NotFound`, and the correct result is
 *    `accountNumber: "0", sequence: "0"` — that is what the chain will assign,
 *    and a first transaction signed with those values is valid.
 *
 * The returned {@link AccountInfo.pubKey} is informational: it identifies the
 * key *algorithm* so the signer can set `eth_key_type`. It is not key material
 * and must not be used as such — the signer derives its own public key.
 *
 * @throws {@link InterchainError} `malformed-response` when a field is present
 *   but not a uint64, `lcd-unreachable` when no endpoint answered.
 */
export async function getAccount(
  lcd: LcdClient,
  chainId: string,
  address: string,
  options: GetAccountOptions = {},
): Promise<AccountInfo> {
  if (!SAFE_ADDRESS.test(address)) {
    throw new InterchainError(
      "malformed-response",
      `${chainId}: ${address || "(empty)"} is not a usable bech32 address`,
      { chainId },
    );
  }

  const request: LcdRequestOptions = {
    cacheTtlMs: options.cacheTtlMs ?? 0,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  let body: unknown;
  try {
    body = await lcd.getJson(
      `/cosmos/auth/v1beta1/accounts/${address}`,
      request,
    );
  } catch (error) {
    if (isAccountNotFound(error)) return emptyAccount(address);
    throw error;
  }

  return parseAccount(body, chainId, address);
}

/**
 * Narrow an `/cosmos/auth/v1beta1/accounts/{addr}` body to {@link AccountInfo}.
 *
 * Exported so a host that already fetched the body (a batch read, a cached
 * response) can reuse the unwrapping without a second request.
 */
export function parseAccount(
  body: unknown,
  chainId: string,
  address: string,
): AccountInfo {
  const root = asRecord(body);
  if (!root) throw malformed(chainId, "account response is not an object");

  // A gateway that answers 200 with a gRPC status instead of an HTTP error.
  const statusCode = root["code"];
  if (typeof statusCode === "number" && statusCode !== 0) {
    if (statusCode === 5 || notFoundText(serverMessage(root))) {
      return emptyAccount(address);
    }
    throw malformed(
      chainId,
      `account query failed with code ${statusCode}: ${serverMessage(root)}`,
    );
  }

  // A few gateways answer a missing account with an explicit null rather than
  // an error status.
  if ("account" in root && root["account"] === null) return emptyAccount(address);

  // `account` is the SDK ≥0.40 shape. `info` is `/account_info/{addr}` on
  // SDK ≥0.47. `result.value` is the legacy amino REST shape, still served by a
  // few archive gateways. Falling through to the root itself costs nothing and
  // covers a proxy that unwrapped the envelope for us.
  const envelope =
    asRecord(root["account"]) ??
    asRecord(root["info"]) ??
    asRecord(asRecord(root["result"])?.["value"]) ??
    asRecord(root["result"]) ??
    root;

  const base = unwrapBaseAccount(envelope);
  if (!base) throw malformed(chainId, "account response has no account object");

  const accountNumber = readUint(base, "account_number", chainId);
  const sequence = readUint(base, "sequence", chainId);

  return {
    address: asString(base["address"]) ?? address,
    accountNumber,
    sequence,
    pubKey: parsePubKey(base["pub_key"] ?? base["public_key"]),
  };
}

/**
 * Descend through account wrappers until the object carrying the signer fields
 * is reached.
 *
 * Descent stops as soon as a level has `account_number` or `sequence`, so a
 * chain that flattens its wrapper (some forks do) is read from the outer object
 * rather than from a nested stub.
 */
function unwrapBaseAccount(
  start: Record<string, unknown>,
): Record<string, unknown> | null {
  let row: Record<string, unknown> = start;
  for (let depth = 0; depth < MAX_ACCOUNT_NESTING; depth++) {
    if ("account_number" in row || "sequence" in row) return row;
    let next: Record<string, unknown> | null = null;
    for (const key of ACCOUNT_NESTING_KEYS) {
      const candidate = asRecord(row[key]);
      if (candidate) {
        next = candidate;
        break;
      }
    }
    if (!next) break;
    row = next;
  }
  // No signer fields anywhere. Legal for a never-seen account, so long as the
  // object at least looks like an account.
  return "address" in row || "@type" in row || "type" in row ? row : null;
}

function readUint(
  row: Record<string, unknown>,
  key: string,
  chainId: string,
): string {
  const raw = row[key];
  // Proto-JSON omits a zero uint64, and so does an account that has never
  // signed. Absent means zero; present-but-unparseable means the endpoint lied.
  if (raw === undefined || raw === null || raw === "") return "0";
  const value = asUint(raw);
  if (value === null) {
    throw malformed(chainId, `${key} is not a uint64: ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Read a public key in either spelling.
 *
 * Proto-JSON is `{ "@type": "/cosmos.crypto.secp256k1.PubKey", "key": "…" }`;
 * the legacy amino REST shape is
 * `{ "type": "tendermint/PubKeySecp256k1", "value": "…" }`. Whichever the node
 * used is passed through verbatim — normalising the two names would throw away
 * the only signal that distinguishes an Ethermint key.
 */
function parsePubKey(value: unknown): PubKeyInfo | null {
  const row = asRecord(value);
  if (!row) return null;
  const typeUrl = asString(row["@type"]) ?? asString(row["type"]);
  const key = asString(row["key"]) ?? asString(row["value"]);
  if (!typeUrl || !key) return null;
  return { typeUrl, key };
}

function emptyAccount(address: string): AccountInfo {
  return { address, accountNumber: "0", sequence: "0", pubKey: null };
}

function notFoundText(text: string): boolean {
  return /not found|does not exist|unknown address|key not found/i.test(text);
}

/**
 * True when an error means "this address has no account yet".
 *
 * Nodes disagree: SDK ≥0.46 answers HTTP 404, older ones answer 400 or 500 with
 * `rpc error: code = NotFound`. `lcd.ts` reports a 404 as `lcd-unreachable`
 * with `httpStatus` set, which is why the status is checked before the text.
 */
function isAccountNotFound(error: unknown): boolean {
  if (!isInterchainError(error)) return false;
  if (error.httpStatus === 404) return true;
  if (error.httpStatus === 400 || error.httpStatus === 501) {
    return notFoundText(error.message);
  }
  return false;
}

/* -------------------------------------------------------------------------- *
 * Simulation
 * -------------------------------------------------------------------------- */

/** Per-call knobs for {@link simulate}. */
export interface SimulateOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Per-call knobs for {@link broadcast}. Same shape as {@link SimulateOptions}. */
export type BroadcastOptions = SimulateOptions;

/**
 * Ask the chain what a transaction would cost.
 *
 * `tx_bytes` must be a complete `TxRaw`, signature field included. Simulation
 * does not verify the signature, but it does decode the transaction, so the
 * signature has to be *present* and the right length — 64 zero bytes is the
 * conventional placeholder, and producing it is the kernel's job, not this
 * package's.
 *
 * @param txBytes - The `TxRaw`, as bytes or already base64-encoded.
 * @returns `gas_info.gas_used`, a decimal string. Feed it to
 *   {@link estimateFee}; it is a measurement, not a limit.
 * @throws {@link TxRejectedError} when the chain rejected the simulated
 *   transaction and said why (a stale sequence shows up here first).
 */
export async function simulate(
  lcd: LcdPostClient,
  chainId: string,
  txBytes: string | Uint8Array,
  options: SimulateOptions = {},
): Promise<string> {
  const encoded =
    typeof txBytes === "string" ? txBytes : encodeBase64(txBytes);

  let body: unknown;
  try {
    body = await lcd.postJson(
      "/cosmos/tx/v1beta1/simulate",
      { tx_bytes: encoded },
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      },
    );
  } catch (error) {
    // A rejected simulation arrives as HTTP 400 with the failure text in the
    // body; the transport folded that text into the message. Re-map it so the
    // caller gets the same taxonomy it would get from a failed broadcast.
    if (isInterchainError(error) && error.httpStatus === 400) {
      const failure = classifyTxFailure(1, error.message);
      // Only re-map when the text actually named a cause. A generic 400 is
      // better reported as the transport error it was.
      if (failure && failure.kind !== "unknown") {
        throw new TxRejectedError(failure, { chainId, cause: error });
      }
    }
    throw error;
  }

  const root = asRecord(body);
  const gasInfo = asRecord(root?.["gas_info"]);
  const gasUsed = asUint(gasInfo?.["gas_used"]);
  if (gasUsed === null) {
    throw malformed(chainId, "simulate response has no gas_info.gas_used");
  }
  return gasUsed;
}

/* -------------------------------------------------------------------------- *
 * Fees
 * -------------------------------------------------------------------------- */

/** Which tier of {@link GasPriceStep} to charge. */
export type FeeSpeed = "low" | "average" | "high";

/** Overrides for {@link estimateFee}. */
export interface FeeEstimateOptions {
  /** Multiplier on simulated gas. Default {@link DEFAULT_GAS_ADJUSTMENT}. */
  readonly gasAdjustment?: number;
  /**
   * Gas price in fee-denom base units per gas unit, overriding the chain's
   * {@link GasPriceStep}. Needed for chains whose registry entry has no step
   * and for a user-set custom price.
   */
  readonly gasPrice?: number;
  /** Fee denom, overriding `chain.feeMinimalDenom`. For a fee-grant in another token. */
  readonly feeDenom?: string;
  /** Floor on the gas limit, for chains with a high fixed overhead. */
  readonly minGasLimit?: string;
  /** Fee-grant payer. */
  readonly payer?: string;
  /** Fee-grant granter. */
  readonly granter?: string;
}

/**
 * Turn simulated gas into a fee the chain will accept.
 *
 * Both computations round **up**, and the direction is not arbitrary. A
 * validator's `minimum-gas-prices` check is `fee >= ceil(gasLimit * minPrice)`
 * evaluated at `CheckTx`, before anything is executed. One base unit short and
 * the transaction is rejected outright with code 13 — the user has already
 * signed, the sequence has not moved, and the whole flow has to restart. One
 * base unit over costs the user a fraction of a cent. Rounding down optimises
 * the wrong side of that trade.
 *
 * All arithmetic is on `bigint`. Gas prices like `0.0000000000000000001`
 * (18-decimal fee tokens) and `25000000000` (aevmos) both appear in the
 * registry, and neither survives a round trip through float multiplication.
 *
 * @param gasUsed - `gas_info.gas_used` from {@link simulate}, a decimal string.
 * @throws {@link InterchainError} `unsupported-chain` when neither the chain nor
 *   {@link FeeEstimateOptions.gasPrice} supplies a price. Guessing one is how a
 *   wallet ships transactions that are rejected on half the network.
 */
export function estimateFee(
  gasUsed: string,
  chain: ChainInfoLike,
  speed: FeeSpeed = "average",
  options: FeeEstimateOptions = {},
): FeeEstimate {
  const simulated = asUint(gasUsed);
  if (simulated === null) {
    throw new InterchainError(
      "malformed-response",
      `${chain.chainId}: simulated gas ${JSON.stringify(gasUsed)} is not a uint64`,
      { chainId: chain.chainId },
    );
  }

  const gasAdjustment = options.gasAdjustment ?? DEFAULT_GAS_ADJUSTMENT;
  if (!Number.isFinite(gasAdjustment) || gasAdjustment <= 0) {
    throw new InterchainError(
      "malformed-response",
      `${chain.chainId}: gas adjustment ${gasAdjustment} is not a positive number`,
      { chainId: chain.chainId },
    );
  }

  const gasPrice = options.gasPrice ?? chain.gasPriceStep?.[speed];
  if (gasPrice === undefined || !Number.isFinite(gasPrice) || gasPrice < 0) {
    throw new InterchainError(
      "unsupported-chain",
      `${chain.chainId} publishes no ${speed} gas price; supply one explicitly`,
      { chainId: chain.chainId },
    );
  }

  const adjustment = toRational(gasAdjustment);
  let gasLimit = ceilDiv(BigInt(simulated) * adjustment.num, adjustment.den);

  const floor = asUint(options.minGasLimit ?? "0");
  if (floor === null) {
    throw new InterchainError(
      "malformed-response",
      `${chain.chainId}: minimum gas limit ${JSON.stringify(options.minGasLimit)} is not a uint64`,
      { chainId: chain.chainId },
    );
  }
  if (BigInt(floor) > gasLimit) gasLimit = BigInt(floor);
  // `Fee::new` in zunia-core rejects a zero gas limit, and so does every chain.
  if (gasLimit < 1n) gasLimit = 1n;

  const price = toRational(gasPrice);
  const feeAmount = ceilDiv(gasLimit * price.num, price.den);
  const denom = options.feeDenom ?? chain.feeMinimalDenom;

  return {
    // A zero-fee chain gets an empty amount list rather than a `0denom` coin:
    // `sdk.Coins` validation rejects a zero coin on several chains.
    amount: feeAmount === 0n ? [] : [{ denom, amount: feeAmount.toString() }],
    gasLimit: gasLimit.toString(),
    gasPrice,
    simulatedGas: simulated,
    gasAdjustment,
    ...(options.payer === undefined ? {} : { payer: options.payer }),
    ...(options.granter === undefined ? {} : { granter: options.granter }),
  };
}

/**
 * Exact rational form of a non-negative JS number.
 *
 * `Number.prototype.toString` is round-trip exact and switches to exponent
 * notation outside 1e-7…1e21, which is squarely inside the range of real gas
 * prices, so the exponent has to be expanded rather than assumed away.
 */
function toRational(value: number): { num: bigint; den: bigint } {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value.toString());
  if (!match) {
    throw new InterchainError(
      "malformed-response",
      `${value} cannot be represented exactly`,
    );
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  const shift = exponent - fraction.length;
  const digits = BigInt(`${whole}${fraction}`);
  return shift >= 0
    ? { num: digits * 10n ** BigInt(shift), den: 1n }
    : { num: digits, den: 10n ** BigInt(-shift) };
}

/** Integer division rounding away from zero. `den` is always positive here. */
function ceilDiv(num: bigint, den: bigint): bigint {
  return (num + den - 1n) / den;
}

/* -------------------------------------------------------------------------- *
 * Broadcast
 * -------------------------------------------------------------------------- */

/**
 * Broadcast modes still supported upstream.
 *
 * `BROADCAST_MODE_BLOCK` was removed in cosmos-sdk 0.47 and is deliberately not
 * offered: on the nodes that still accept it, it holds the HTTP connection open
 * for a whole block, which an MV3 service worker will not survive.
 */
export type BroadcastMode = "sync" | "async";

const BROADCAST_MODES: Record<BroadcastMode, string> = {
  sync: "BROADCAST_MODE_SYNC",
  async: "BROADCAST_MODE_ASYNC",
};

/** Why a transaction was rejected, in terms a UI can act on. */
export type TxFailureKind =
  | "insufficient-fee"
  | "insufficient-funds"
  | "sequence-mismatch"
  | "out-of-gas"
  | "already-in-mempool"
  | "unauthorized"
  | "tx-timeout"
  | "unknown";

/**
 * A decoded SDK error.
 *
 * `InterchainErrorCode` has one member for the whole class of transaction
 * rejections, `tx-rejected`, because a host only has to decide "show the error
 * and offer to retry" at that level. Which rejection it was, and whether
 * re-signing can help, lives here.
 */
export interface TxFailure {
  readonly kind: TxFailureKind;
  /** The SDK result code, verbatim. */
  readonly code: number;
  /** The SDK codespace, `"sdk"` for the core module errors. */
  readonly codespace: string;
  /** Actionable, user-facing, one sentence. */
  readonly message: string;
  /** The node's own text, developer-facing. */
  readonly rawLog: string;
  /**
   * True when re-signing with corrected inputs can succeed: refetch the
   * sequence, raise the gas limit, raise the fee. False when the transaction
   * cannot work as written.
   */
  readonly retryable: boolean;
  /** Parsed out of an `account sequence mismatch` log, when present. */
  readonly expectedSequence: string | null;
}

/**
 * An {@link InterchainError} that carries a decoded {@link TxFailure}.
 *
 * The `code` is `tx-rejected`: the chain answered and refused the transaction,
 * which is neither a network failure nor a contract failure and needs its own
 * UI copy. `name` stays `InterchainError` so {@link isInterchainError} keeps
 * working across two copies of this package.
 */
export class TxRejectedError extends InterchainError {
  readonly failure: TxFailure;

  constructor(
    failure: TxFailure,
    details: { readonly chainId?: string; readonly cause?: unknown } = {},
  ) {
    super("tx-rejected", failure.message, details);
    this.failure = failure;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Type guard for {@link TxRejectedError}, duplicate-copy safe. */
export function isTxRejectedError(value: unknown): value is TxRejectedError {
  if (!isInterchainError(value)) return false;
  const failure = (value as { failure?: unknown }).failure;
  return (
    typeof failure === "object" &&
    failure !== null &&
    typeof (failure as { kind?: unknown }).kind === "string"
  );
}

/** {@link BroadcastResult} plus the decoded rejection, when there was one. */
export interface TxBroadcast extends BroadcastResult {
  readonly codespace: string;
  /** `null` when {@link BroadcastResult.code} is 0. */
  readonly failure: TxFailure | null;
}

/**
 * Submit signed transaction bytes.
 *
 * **Code 0 does not mean the transaction succeeded.** In `sync` mode the node
 * has run `CheckTx` and put the transaction in its mempool, nothing more. It
 * can still fail during `DeliverTx`, and it can still be evicted and never
 * included. Confirmation is {@link waitForTx}.
 *
 * A rejection is returned, not thrown. The transaction hash is deterministic
 * over the signed bytes, so it exists even for a rejected transaction, and it
 * is the one identifier the user and a support engineer can both look up —
 * throwing would discard it. Read {@link TxBroadcast.failure}, or
 * {@link BroadcastResult.success}, to branch.
 *
 * @param txBytesBase64 - A signed `TxRaw`, base64. Produced by zunia-core; this
 *   package cannot produce it (see the module header).
 */
export async function broadcast(
  lcd: LcdPostClient,
  chainId: string,
  txBytesBase64: string,
  mode: BroadcastMode = "sync",
  options: BroadcastOptions = {},
): Promise<TxBroadcast> {
  const body = await lcd.postJson(
    "/cosmos/tx/v1beta1/txs",
    { tx_bytes: txBytesBase64, mode: BROADCAST_MODES[mode] },
    {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    },
  );
  return parseBroadcastResponse(body, chainId);
}

/**
 * Narrow a `/cosmos/tx/v1beta1/txs` body to {@link TxBroadcast}.
 *
 * Exported for hosts that broadcast through their own transport — a dApp-
 * supplied RPC, a Ledger bridge — and still want the same taxonomy.
 */
export function parseBroadcastResponse(
  body: unknown,
  chainId: string,
): TxBroadcast {
  const root = asRecord(body);
  if (!root) throw malformed(chainId, "broadcast response is not an object");
  // Some gateways unwrap the envelope; accept either shape.
  const response = asRecord(root["tx_response"]) ?? root;

  const txHash = asString(response["txhash"]) ?? asString(response["hash"]);
  if (!txHash) {
    throw malformed(chainId, "broadcast response has no txhash");
  }

  // Proto-JSON omits `code` when it is 0, which is the success case.
  const rawCode = response["code"];
  const code = typeof rawCode === "number" ? rawCode : 0;
  const codespace = asString(response["codespace"]) ?? "";
  const rawLog = asString(response["raw_log"]) ?? "";
  const height = asUint(response["height"]);
  const gasUsed = asUint(response["gas_used"]);
  const gasWanted = asUint(response["gas_wanted"]);

  return {
    txHash: txHash.toUpperCase(),
    code,
    success: code === 0,
    rawLog,
    codespace,
    failure: classifyTxFailure(code, rawLog, codespace),
    ...(height === null ? {} : { height }),
    ...(gasUsed === null ? {} : { gasUsed }),
    ...(gasWanted === null ? {} : { gasWanted }),
  };
}

/**
 * Decode an SDK result code plus log into something a UI can say out loud.
 *
 * Numeric codes are only meaningful within a codespace — code 5 is
 * `insufficient funds` in `sdk` and something else entirely in `wasm` — so the
 * numeric table is consulted only for the core codespace, and the log text is
 * always consulted as a second opinion. Text matching is not elegant, but the
 * log is the only place a wrapped error keeps its cause.
 *
 * @returns `null` when `code` is 0.
 */
export function classifyTxFailure(
  code: number,
  rawLog: string,
  codespace = "sdk",
): TxFailure | null {
  if (code === 0) return null;

  const core = codespace === "" || codespace === "sdk";
  let kind: TxFailureKind = core ? (SDK_CODES[code] ?? "unknown") : "unknown";
  if (kind === "unknown") kind = kindFromLog(rawLog);

  const expected = /expected\s+(\d+)/i.exec(rawLog);
  return {
    kind,
    code,
    codespace,
    message: FAILURE_MESSAGES[kind],
    rawLog,
    retryable: RETRYABLE.has(kind),
    expectedSequence:
      kind === "sequence-mismatch" ? (expected?.[1] ?? null) : null,
  };
}

/** `cosmos-sdk/types/errors`, the codes a wallet actually meets. */
const SDK_CODES: Readonly<Record<number, TxFailureKind>> = {
  4: "unauthorized",
  5: "insufficient-funds",
  11: "out-of-gas",
  13: "insufficient-fee",
  19: "already-in-mempool",
  30: "tx-timeout",
  32: "sequence-mismatch",
};

function kindFromLog(rawLog: string): TxFailureKind {
  if (/account sequence mismatch/i.test(rawLog)) return "sequence-mismatch";
  if (/insufficient fee/i.test(rawLog)) return "insufficient-fee";
  if (/insufficient funds|insufficient account balance/i.test(rawLog)) {
    return "insufficient-funds";
  }
  if (/out of gas/i.test(rawLog)) return "out-of-gas";
  if (/tx already exists in cache|already in mempool/i.test(rawLog)) {
    return "already-in-mempool";
  }
  if (/signature verification failed|unauthorized/i.test(rawLog)) {
    return "unauthorized";
  }
  if (/timeout height|tx timeout/i.test(rawLog)) return "tx-timeout";
  return "unknown";
}

const FAILURE_MESSAGES: Readonly<Record<TxFailureKind, string>> = {
  "insufficient-fee":
    "The fee is below what this chain's validators accept. Raise the fee and sign again.",
  "insufficient-funds":
    "The account does not hold enough to cover the amount plus the fee.",
  "sequence-mismatch":
    "Another transaction from this account is still pending. Refresh the account and sign again.",
  "out-of-gas":
    "The transaction ran out of gas. Raise the gas limit and sign again.",
  "already-in-mempool":
    "This exact transaction is already waiting to be included. Do not send it again.",
  unauthorized:
    "The chain rejected the signature. The account's key or sequence has changed since it was signed.",
  "tx-timeout":
    "The transaction's timeout height passed before it was included. Nothing was spent; sign again.",
  unknown: "The chain rejected the transaction.",
};

/** Kinds where re-signing with corrected inputs is worth offering. */
const RETRYABLE: ReadonlySet<TxFailureKind> = new Set<TxFailureKind>([
  "insufficient-fee",
  "sequence-mismatch",
  "out-of-gas",
  "tx-timeout",
]);

/* -------------------------------------------------------------------------- *
 * Inclusion
 * -------------------------------------------------------------------------- */

/** Per-call knobs for {@link getTxStatus}. */
export interface TxStatusOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Polling knobs for {@link waitForTx}. */
export interface WaitForTxOptions extends TxStatusOptions {
  /** Total budget before giving up and returning what is known. Default 60000. */
  readonly deadlineMs?: number;
  /** First gap between polls. Default 1500, roughly one block. */
  readonly pollIntervalMs?: number;
  /** Ceiling on the gap. Default 8000. */
  readonly maxPollIntervalMs?: number;
  /** Growth per poll. Default 1.5. */
  readonly backoffFactor?: number;
  /** Injected for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injected for tests. Defaults to a `setTimeout` promise. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Look a transaction up once.
 *
 * A hash the node has not indexed yet is {@link TxStatusState} `not-found`, not
 * an error: for the first few seconds after a broadcast that is the normal
 * answer, and on a load-balanced endpoint it can persist while one node catches
 * up. Showing it as a failure is how a wallet tells a user their money vanished
 * when it did not.
 */
export async function getTxStatus(
  lcd: LcdClient,
  chainId: string,
  txHash: string,
  options: TxStatusOptions = {},
): Promise<TxStatus> {
  const hash = txHash.trim();
  if (!TX_HASH.test(hash)) {
    throw new InterchainError(
      "malformed-response",
      `${chainId}: ${hash || "(empty)"} is not a transaction hash`,
      { chainId },
    );
  }
  // Uppercase because that is what the tx service indexes on; several LCDs 404
  // a lowercase hash that they would otherwise find.
  const upper = hash.toUpperCase();

  let body: unknown;
  try {
    body = await lcd.getJson(`/cosmos/tx/v1beta1/txs/${upper}`, {
      cacheTtlMs: 0,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
  } catch (error) {
    if (isTxNotFound(error)) return notFoundStatus(upper);
    throw error;
  }

  return parseTxStatus(body, chainId, upper);
}

/** Narrow a `/cosmos/tx/v1beta1/txs/{hash}` body to {@link TxStatus}. */
export function parseTxStatus(
  body: unknown,
  chainId: string,
  txHash: string,
): TxStatus {
  const root = asRecord(body);
  if (!root) throw malformed(chainId, "tx response is not an object");

  const statusCode = root["code"];
  const response = asRecord(root["tx_response"]);
  if (!response) {
    // A gateway that reports NotFound as a 200 body rather than an HTTP status.
    if (typeof statusCode === "number" && statusCode !== 0) {
      if (statusCode === 5 || notFoundText(serverMessage(root))) {
        return notFoundStatus(txHash);
      }
      throw malformed(
        chainId,
        `tx query failed with code ${statusCode}: ${serverMessage(root)}`,
      );
    }
    throw malformed(chainId, "tx response has no tx_response");
  }

  const rawCode = response["code"];
  const code = typeof rawCode === "number" ? rawCode : 0;
  const height = asUint(response["height"]);
  // Height 0 means the node knows the hash but has not committed it in a block.
  const included = height !== null && height !== "0";
  const state: TxStatusState = !included
    ? "pending"
    : code === 0
      ? "success"
      : "failed";

  return {
    txHash: (asString(response["txhash"]) ?? txHash).toUpperCase(),
    state,
    code: included ? code : null,
    height: included ? height : null,
    rawLog: asString(response["raw_log"]),
    timestamp: asString(response["timestamp"]),
    gasUsed: asUint(response["gas_used"]),
    gasWanted: asUint(response["gas_wanted"]),
  };
}

function notFoundStatus(txHash: string): TxStatus {
  return {
    txHash,
    state: "not-found",
    code: null,
    height: null,
    rawLog: null,
    timestamp: null,
    gasUsed: null,
    gasWanted: null,
  };
}

function isTxNotFound(error: unknown): boolean {
  if (!isInterchainError(error)) return false;
  if (error.httpStatus === 404) return true;
  // Older gateways report an unindexed hash as 400 or 500 with the reason in
  // the body, which `lcd.ts` folds into the message.
  if (error.httpStatus === 400 || error.httpStatus === 500) {
    return notFoundText(error.message);
  }
  return false;
}

/**
 * Poll until the transaction is included, or the deadline passes.
 *
 * Returns rather than throws when the deadline passes: the transaction may
 * still be included afterwards, and the caller usually wants to keep the hash
 * on screen with a "still pending" label rather than show an error. The
 * returned state distinguishes the three outcomes — `success`, `failed` with
 * the SDK code, `not-found`/`pending` for "no answer yet".
 *
 * Transient endpoint failures during the wait are swallowed and retried on the
 * next tick; a node that goes down mid-wait is not evidence about the
 * transaction. `reads-disabled` and `aborted` propagate immediately, because
 * both mean the caller no longer wants the answer.
 */
export async function waitForTx(
  lcd: LcdClient,
  chainId: string,
  txHash: string,
  options: WaitForTxOptions = {},
): Promise<TxStatus> {
  const hash = txHash.trim();
  // Checked once here rather than per poll, so a bad hash fails immediately
  // instead of being mistaken for a flaky endpoint and retried to the deadline.
  if (!TX_HASH.test(hash)) {
    throw new InterchainError(
      "malformed-response",
      `${chainId}: ${hash || "(empty)"} is not a transaction hash`,
      { chainId },
    );
  }

  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.deadlineMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  const maxInterval = options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
  const backoff = options.backoffFactor ?? DEFAULT_POLL_BACKOFF;
  let interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let last: TxStatus = notFoundStatus(hash.toUpperCase());

  for (;;) {
    if (options.signal?.aborted === true) {
      throw new InterchainError("aborted", `${chainId}: wait cancelled`, {
        chainId,
      });
    }

    try {
      last = await getTxStatus(lcd, chainId, hash, options);
      if (last.state === "success" || last.state === "failed") return last;
    } catch (error) {
      if (!isInterchainError(error)) throw error;
      // An endpoint that is down or lying says nothing about the transaction;
      // try again next tick. Anything else means the caller is done waiting.
      if (
        error.code !== "lcd-unreachable" &&
        error.code !== "malformed-response"
      ) {
        throw error;
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) return last;
    await sleep(Math.max(1, Math.min(interval, maxInterval, remaining)));
    interval = Math.ceil(interval * backoff);
  }
}

/* -------------------------------------------------------------------------- *
 * The hand-off to zunia-core
 * -------------------------------------------------------------------------- */

/** Which sign document the kernel should produce. */
export type SignModeName = "direct" | "amino";

/**
 * `SignerData` in `zunia-core/crates/cosmos/src/tx.rs`.
 *
 * Field names are snake_case and `u64` values are decimal strings, matching
 * what a serde deserialiser over that struct expects. `public_key` is hex
 * because that is the encoding `build_bank_send_direct` already takes for
 * `public_key_hex`.
 *
 * TODO-VERIFY: the Rust `Msg` enum derives no `Serialize`/`Deserialize` today
 * and no binding consumes this payload yet, so the exact serde tagging is a
 * proposal rather than something upstream confirmed. Nothing broadcasts until
 * `crates/wasm` and `crates/ffi` grow a generic `build_unsigned_tx`, and that
 * binding and this shape have to be agreed together.
 */
export interface UnsignedTxSigner {
  readonly chain_id: string;
  readonly account_number: string;
  readonly sequence: string;
  /** Compressed secp256k1 public key, 33 bytes, hex, no `0x`. */
  readonly public_key: string;
  /** True on Ethermint chains: changes the pubkey type URL inside the signed bytes. */
  readonly eth_key_type: boolean;
}

/** `Fee` in `zunia-core/crates/cosmos/src/tx.rs`. Empty strings mean "no fee grant". */
export interface UnsignedTxFee {
  readonly amount: readonly Coin[];
  readonly gas_limit: string;
  readonly payer: string;
  readonly granter: string;
}

/**
 * One message for the kernel's `Msg` enum.
 *
 * `type_url` selects the variant; `value` is proto-JSON with the same
 * snake_case field names the Rust variant uses, so the mapping is mechanical.
 * Three of them need care on the caller's side, because proto-JSON is not the
 * same as the Rust field type:
 *
 * - `MsgExecuteContract.msg` is `Vec<u8>` holding raw JSON — proto-JSON encodes
 *   `bytes` as **base64**, so `value.msg` is the base64 of the contract message
 *   (this is what `jsonToBase64` in `./base64.js` produces).
 * - `MsgVote.option` is an enum: the proto-JSON spelling is the full name,
 *   `"VOTE_OPTION_YES"`, not `"yes"` and not `1`.
 * - `MsgTransfer.timeout_height` is an object,
 *   `{ revision_number, revision_height }`, and `timeout_timestamp` is
 *   nanoseconds since the epoch as a decimal string.
 */
export interface UnsignedTxMsg {
  readonly type_url: string;
  readonly value: JsonObject;
}

/** `UnsignedTx` in `zunia-core/crates/cosmos/src/tx.rs`. */
export interface UnsignedTxBody {
  readonly msgs: readonly UnsignedTxMsg[];
  readonly fee: UnsignedTxFee;
  readonly memo: string;
  /** `0` disables the timeout, matching the Rust default. */
  readonly timeout_height: string;
}

/**
 * The complete payload the Rust kernel needs to produce sign bytes.
 *
 * Nothing in this object is secret. It is exactly what a signing prompt shows
 * the user, and it is safe to log.
 */
export interface UnsignedTxRequest {
  readonly sign_mode: SignModeName;
  readonly signer: UnsignedTxSigner;
  readonly tx: UnsignedTxBody;
}

/** Inputs to {@link buildUnsignedTxRequest}. */
export interface UnsignedTxRequestInput {
  readonly chainId: string;
  /** From {@link getAccount}. Supplies `account_number` and `sequence`. */
  readonly account: AccountInfo;
  /** The signer's own compressed public key, hex. Derived locally, never from the LCD. */
  readonly publicKeyHex: string;
  /** At least one. The kernel rejects an empty message list. */
  readonly msgs: readonly BuiltMsg[];
  /** From {@link estimateFee}. */
  readonly fee: FeeEstimate;
  /** ICS20 and PFM memos live on the message, not here; this is the tx memo. */
  readonly memo?: string;
  /** Block height after which the tx is invalid. `"0"` (the default) disables it. */
  readonly timeoutHeight?: string;
  /** Default `direct`. Ledger and older dApps need `amino`. */
  readonly signMode?: SignModeName;
  /**
   * Ethermint key type. Defaults to what {@link getAccount} reported, via
   * {@link isEthSecp256k1PubKey} — an account that has never signed reports no
   * key, so an Ethermint chain's first transaction must set this explicitly.
   */
  readonly ethKeyType?: boolean;
}

/**
 * Assemble the JSON the Rust kernel needs to build sign bytes.
 *
 * This function is the boundary. Everything to its left is network I/O and
 * arithmetic; everything to its right is `zunia-core`. It produces no
 * signature, touches no key, and the payload it returns is inert.
 *
 * Validation here mirrors the checks `UnsignedTx::new` and `Fee::new` already
 * perform in Rust, on purpose: catching an over-long memo before the user is
 * shown a signing prompt is much better than catching it after they approved
 * one. The memo limit is counted in **bytes**, not characters — the SDK's
 * `MaxMemoCharacters` is applied to `len(memo)` on a Go string, and Rust
 * matches it with `memo.len()`, so an emoji costs four.
 *
 * @throws {@link InterchainError} `invalid-memo` when the memo exceeds
 *   {@link TX_MEMO_MAX_BYTES}; `invalid-request` for any other malformed input.
 *   Neither code is a good fit — see the note on {@link TxFailure}.
 */
export function buildUnsignedTxRequest(
  input: UnsignedTxRequestInput,
): UnsignedTxRequest {
  const chainId = input.chainId.trim();
  if (!chainId) {
    throw invalidRequest("chain id is empty", input.chainId);
  }
  if (input.msgs.length === 0) {
    throw invalidRequest("a transaction needs at least one message", chainId);
  }

  const memo = input.memo ?? "";
  if (utf8ToBytes(memo).length > TX_MEMO_MAX_BYTES) {
    throw new InterchainError(
      "invalid-memo",
      `${chainId}: memo is longer than ${TX_MEMO_MAX_BYTES} bytes`,
      { chainId },
    );
  }

  const publicKey = input.publicKeyHex.trim().replace(/^0x/i, "").toLowerCase();
  // 33 bytes, compressed. The kernel writes these bytes straight into the
  // pubkey `Any`, and an uncompressed or truncated key yields an address the
  // chain does not associate with the signature.
  if (!/^[0-9a-f]{66}$/.test(publicKey)) {
    throw invalidRequest(
      "public key must be 33 compressed bytes as hex",
      chainId,
    );
  }

  const gasLimit = asUint(input.fee.gasLimit);
  if (gasLimit === null || gasLimit === "0") {
    throw invalidRequest(
      `gas limit ${JSON.stringify(input.fee.gasLimit)} must be a positive uint64`,
      chainId,
    );
  }

  const accountNumber = asUint(input.account.accountNumber);
  const sequence = asUint(input.account.sequence);
  if (accountNumber === null || sequence === null) {
    throw invalidRequest(
      "account number and sequence must be decimal uint64 strings",
      chainId,
    );
  }

  const timeoutHeight = asUint(input.timeoutHeight ?? "0");
  if (timeoutHeight === null) {
    throw invalidRequest("timeout height must be a uint64", chainId);
  }

  for (const msg of input.msgs) {
    if (!msg.typeUrl.startsWith("/")) {
      throw invalidRequest(
        `message type url ${JSON.stringify(msg.typeUrl)} must start with "/"`,
        chainId,
      );
    }
  }

  return {
    sign_mode: input.signMode ?? "direct",
    signer: {
      chain_id: chainId,
      account_number: accountNumber,
      sequence,
      public_key: publicKey,
      eth_key_type:
        input.ethKeyType ?? isEthSecp256k1PubKey(input.account.pubKey),
    },
    tx: {
      msgs: input.msgs.map((msg) => ({
        type_url: msg.typeUrl,
        value: msg.value,
      })),
      fee: {
        amount: input.fee.amount.map((coin) => ({
          denom: coin.denom,
          amount: coin.amount,
        })),
        gas_limit: gasLimit,
        payer: input.fee.payer ?? "",
        granter: input.fee.granter ?? "",
      },
      memo,
      timeout_height: timeoutHeight,
    },
  };
}

/**
 * Caller-input failure: the developer handed us something the kernel will
 * refuse. Never the chain's fault and never retryable.
 */
function invalidRequest(detail: string, chainId: string): InterchainError {
  return new InterchainError("invalid-request", `${chainId}: ${detail}`, {
    chainId,
  });
}
