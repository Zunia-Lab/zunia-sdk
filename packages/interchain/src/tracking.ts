/**
 * Packet tracking: telling the user where their funds actually are.
 *
 * A cross-chain send is one signature and then a sequence of packets that other
 * people's relayers move. Between "signed" and "arrived" the user can only see a
 * spinner unless something reads the chains back, so this module reconstructs
 * the whole journey from public LCD reads:
 *
 * 1. {@link extractPacketsFromTx} reads the `send_packet` / `ibc_transfer`
 *    events out of the transaction the user signed.
 * 2. {@link getPacketStatus} asks the destination chain whether the packet was
 *    received and the source chain whether it was acknowledged or timed out.
 * 3. {@link trackRoute} walks every hop of a {@link RoutePlan}, chaining from
 *    each hop's receive transaction to the packet the intermediate chain
 *    forwarded, so a UI can say "hop 2 of 3, relayed, waiting for
 *    acknowledgement" instead of "pending".
 *
 * The four failure modes are kept apart because the user's next action differs:
 * a timeout and an error acknowledgement both refund on the source chain and
 * need no action, a stalled packet is safe but needs a relayer, and a failed
 * delivery *after* a successful crosschain-swap leaves funds inside the Osmosis
 * contract that only the `local_recovery_addr` can pull out — see
 * {@link buildXcsRecoverMsg}.
 *
 * This module reads and parses. It never signs: {@link buildXcsRecoverMsg}
 * returns a {@link BuiltMsg} for zunia-core to encode and sign, and nothing here
 * ever sees a key.
 *
 * ## What is verified and what is not
 *
 * TODO-VERIFY: INTERCHAIN-SPEC.md verifies the memo shapes, the crosschain-swaps
 * `ExecuteMsg` (including `{"recover":{}}` as the recovery call), denom traces
 * and the CW721/ICS721 messages. It does **not** cover IBC event names or
 * Cosmos SDK transaction-response shapes. Everything in this file that touches
 * an event name (`send_packet`, `recv_packet`, `write_acknowledgement`,
 * `acknowledge_packet`, `timeout_packet`, `ibc_transfer`,
 * `fungible_token_packet`) follows ibc-go convention and is therefore modelled
 * defensively: every field is optional, every unknown shape degrades to
 * `unknown` status rather than throwing, and a chain that indexes none of this
 * simply reports less.
 */

import { bytesToUtf8, decodeBase64Utf8 } from "./base64.js";
import { lcdEndpointsFromChain } from "./lcd.js";
import { buildExecuteContractMsg } from "./nft.js";
import {
  InterchainError,
  isInterchainError,
  type BuiltMsg,
  type ChainRegistry,
  type JsonObject,
  type LcdClient,
  type LcdClientFactory,
  type LcdRequestOptions,
  type PacketHopTrace,
  type PacketStatus,
  type PacketTrace,
  type RouteHopKind,
  type RoutePlan,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * JSON narrowing
 * -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * A uint64 field as the LCD spells it.
 *
 * Sequences and heights are strings on the wire, but a few proxies re-serialise
 * them as numbers, so both are accepted and normalised to a decimal string.
 */
function asUint(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? trimmed : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

function nonNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/* -------------------------------------------------------------------------- *
 * Event decoding
 * -------------------------------------------------------------------------- */

/** Plausible event type / attribute key: no spaces, no punctuation soup. */
const IDENTIFIER = /^[A-Za-z0-9_.\-/]{1,128}$/;
/** Control characters that no attribute value legitimately contains. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/**
 * Decode an attribute key that may or may not be base64.
 *
 * Cosmos SDK ≤ 0.46 typed ABCI attribute keys and values as `bytes`, so the
 * REST layer emitted them base64-encoded; 0.47 changed them to `string` and
 * they come through in the clear. Rather than guess which SDK answered, both
 * spellings are indexed and lookups use the plain name.
 *
 * Returns `null` when the input is not base64 of a plausible key, which is the
 * common case for an already-plain key: `packet_sequence` contains `_`, which
 * is not in the standard base64 alphabet, so decoding rejects it outright.
 */
function decodeKeyCandidate(raw: string): string | null {
  if (raw.length === 0) return null;
  try {
    const decoded = decodeBase64Utf8(raw);
    return IDENTIFIER.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Decode an attribute value that is base64 because its key was.
 *
 * Looser than {@link decodeKeyCandidate}: values are JSON blobs, bech32
 * addresses and acknowledgement strings, so only control characters disqualify
 * a decode.
 */
function decodeValueCandidate(raw: string): string | null {
  if (raw.length === 0) return "";
  try {
    const decoded = decodeBase64Utf8(raw);
    return CONTROL_CHARS.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * Decode a lowercase hex string to text.
 *
 * ibc-go emits `packet_data_hex` alongside (and on some versions instead of)
 * `packet_data`. Returns `null` for anything that is not even-length hex of
 * valid UTF-8.
 */
function hexToText(raw: string): string | null {
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    return bytesToUtf8(bytes);
  } catch {
    return null;
  }
}

/** One transaction event, with its attributes flattened and decoded. */
export interface DecodedTxEvent {
  /** Event type, preferring the decoded spelling, e.g. `send_packet`. */
  readonly type: string;
  /** Every spelling seen for the type, so a match can accept either. */
  readonly types: readonly string[];
  /** Attributes by name. First occurrence wins; packet events never repeat keys. */
  readonly attributes: ReadonlyMap<string, string>;
  /** Index of the message that emitted this event, when the node reports it. */
  readonly msgIndex: number | null;
}

/** Read one attribute, or `null` when the event does not carry it. */
function attr(event: DecodedTxEvent, key: string): string | null {
  const value = event.attributes.get(key);
  return value === undefined || value === "" ? null : value;
}

function eventIs(event: DecodedTxEvent, type: string): boolean {
  return event.types.includes(type);
}

function decodeEvent(raw: unknown): DecodedTxEvent | null {
  const row = asRecord(raw);
  if (!row) return null;
  const rawType = asString(row.type);
  if (rawType === null || rawType === "") return null;

  const decodedType = decodeKeyCandidate(rawType);
  const types = decodedType === null || decodedType === rawType
    ? [rawType]
    : [rawType, decodedType];

  const attributes = new Map<string, string>();
  for (const entry of asArray(row.attributes)) {
    const pair = asRecord(entry);
    if (!pair) continue;
    const key = asString(pair.key);
    if (key === null || key === "") continue;
    const value = asString(pair.value) ?? "";
    if (!attributes.has(key)) attributes.set(key, value);
    const plainKey = decodeKeyCandidate(key);
    if (plainKey !== null && plainKey !== key && !attributes.has(plainKey)) {
      attributes.set(plainKey, decodeValueCandidate(value) ?? value);
    }
  }

  const msgIndexAttr = attributes.get("msg_index");
  const msgIndex =
    typeof row.msg_index === "number" && Number.isSafeInteger(row.msg_index)
      ? row.msg_index
      : msgIndexAttr !== undefined && /^\d+$/.test(msgIndexAttr)
        ? Number.parseInt(msgIndexAttr, 10)
        : null;

  return { type: decodedType ?? rawType, types, attributes, msgIndex };
}

/** Events that came from one message, so a packet can be paired with its transfer. */
interface EventGroup {
  readonly msgIndex: number | null;
  readonly events: readonly DecodedTxEvent[];
}

/**
 * Unwrap `{ "tx_response": … }` or accept a bare `tx_response` row.
 *
 * `/cosmos/tx/v1beta1/txs/{hash}` returns the envelope; the rows inside a tx
 * search response are bare. Both are handed to this module.
 */
function txResponseOf(body: unknown): Record<string, unknown> | null {
  const row = asRecord(body);
  if (!row) return null;
  const nested = asRecord(row.tx_response);
  return nested ?? row;
}

function eventGroupsOf(txResponse: Record<string, unknown>): readonly EventGroup[] {
  const groups: EventGroup[] = [];

  // SDK ≤ 0.47 shape: `logs[].events`, already grouped by message.
  for (const log of asArray(txResponse.logs)) {
    const row = asRecord(log);
    if (!row) continue;
    const events = asArray(row.events).map(decodeEvent).filter(nonNull);
    if (events.length === 0) continue;
    const msgIndex =
      typeof row.msg_index === "number" && Number.isSafeInteger(row.msg_index)
        ? row.msg_index
        : null;
    groups.push({ msgIndex, events });
  }

  // Flat shape: base64 attributes on ≤ 0.46, plain plus a `msg_index`
  // attribute on ≥ 0.47, and the only shape at all on ≥ 0.50 where `logs` is
  // empty for successful transactions.
  const flat = asArray(txResponse.events).map(decodeEvent).filter(nonNull);
  if (flat.length > 0) {
    const byIndex = new Map<number | null, DecodedTxEvent[]>();
    for (const event of flat) {
      const bucket = byIndex.get(event.msgIndex);
      if (bucket) bucket.push(event);
      else byIndex.set(event.msgIndex, [event]);
    }
    for (const [msgIndex, events] of byIndex) groups.push({ msgIndex, events });
  }

  return groups;
}

/**
 * Every event in a transaction response, from whichever shape it uses.
 *
 * Exported because status detection and packet extraction both need it, and
 * because a host debugging a weird chain wants to see what was actually parsed.
 */
export function decodeTxEvents(body: unknown): readonly DecodedTxEvent[] {
  const txResponse = txResponseOf(body);
  if (!txResponse) return [];
  return eventGroupsOf(txResponse).flatMap((group) => group.events);
}

/* -------------------------------------------------------------------------- *
 * Packet extraction
 * -------------------------------------------------------------------------- */

/**
 * ICS20 packet data.
 *
 * Not in the verified spec, so every field is nullable. ICS20 v2 moved the
 * denom and amount into a `tokens` array; both spellings are read and the
 * first token wins, because a wallet-built transfer only ever carries one.
 */
export interface Ics20PacketData {
  readonly denom: string | null;
  readonly amount: string | null;
  readonly sender: string | null;
  readonly receiver: string | null;
  /** The memo that drives packet-forward-middleware and ibc-hooks. */
  readonly memo: string | null;
}

/** The `ibc_transfer` event, when the source transaction emitted one. */
export interface IbcTransferSummary {
  readonly sender: string | null;
  readonly receiver: string | null;
  readonly denom: string | null;
  readonly amount: string | null;
  readonly memo: string | null;
}

/** A packet identity: everything needed to look the packet up on either chain. */
export interface PacketRef {
  /** Packet sequence as a decimal string. */
  readonly sequence: string;
  readonly sourcePort: string;
  readonly sourceChannelId: string;
  readonly destPort: string;
  /** May be `""` when the node did not report it; lookups then drop the filter. */
  readonly destChannelId: string;
  /** `revision-height`, or `null` when the packet has no height timeout. */
  readonly timeoutHeight?: string | null;
  /** Unix nanoseconds as a decimal string; `"0"` means no timestamp timeout. */
  readonly timeoutTimestamp?: string | null;
}

/** A `send_packet` event, with whatever context the transaction carried. */
export interface ExtractedPacket extends PacketRef {
  readonly timeoutHeight: string | null;
  readonly timeoutTimestamp: string | null;
  readonly connectionId: string | null;
  /** Parsed ICS20 payload, `null` when the packet is not ICS20 or was not indexed. */
  readonly data: Ics20PacketData | null;
  /** The raw `packet_data` JSON, for diagnostics. */
  readonly rawData: string | null;
  readonly transfer: IbcTransferSummary | null;
  /** Transaction that emitted the event, when the response carried the hash. */
  readonly txHash: string | null;
  readonly height: string | null;
  /** Block time, RFC 3339. */
  readonly timestamp: string | null;
}

/**
 * Parse an ICS20 packet payload.
 *
 * @returns `null` when the payload is not a JSON object. A JSON object missing
 *   every known field still returns a record of nulls, because a partially
 *   understood packet is more useful than none.
 */
export function parseIcs20PacketData(raw: string): Ics20PacketData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const row = asRecord(parsed);
  if (!row) return null;

  // ICS20 v2 nests the token: { tokens: [{ denom: { base, trace }, amount }] }.
  // TODO-VERIFY: defensive, and not covered by INTERCHAIN-SPEC.md.
  let denom = asString(row.denom);
  let amount = asUint(row.amount) ?? asString(row.amount);
  if (denom === null || amount === null) {
    const token = asRecord(asArray(row.tokens)[0]);
    if (token) {
      amount = amount ?? asUint(token.amount) ?? asString(token.amount);
      const nested = asRecord(token.denom);
      denom = denom ?? asString(token.denom) ?? (nested ? asString(nested.base) : null);
    }
  }

  return {
    denom,
    amount,
    sender: asString(row.sender),
    receiver: asString(row.receiver),
    memo: asString(row.memo),
  };
}

function packetDataOf(event: DecodedTxEvent): string | null {
  const direct = attr(event, "packet_data");
  if (direct !== null) return direct;
  const hex = attr(event, "packet_data_hex");
  return hex === null ? null : hexToText(hex);
}

function transferSummaryOf(event: DecodedTxEvent): IbcTransferSummary {
  return {
    sender: attr(event, "sender"),
    receiver: attr(event, "receiver"),
    denom: attr(event, "denom"),
    amount: attr(event, "amount"),
    memo: attr(event, "memo"),
  };
}

function packetKey(ref: PacketRef): string {
  return `${ref.sourcePort}/${ref.sourceChannelId}/${ref.sequence}`;
}

/** Fill nulls in `base` from `extra`; the first sighting keeps precedence. */
function mergePacket(base: ExtractedPacket, extra: ExtractedPacket): ExtractedPacket {
  return {
    sequence: base.sequence,
    sourcePort: base.sourcePort,
    sourceChannelId: base.sourceChannelId,
    destPort: base.destPort || extra.destPort,
    destChannelId: base.destChannelId || extra.destChannelId,
    timeoutHeight: base.timeoutHeight ?? extra.timeoutHeight,
    timeoutTimestamp: base.timeoutTimestamp ?? extra.timeoutTimestamp,
    connectionId: base.connectionId ?? extra.connectionId,
    data: base.data ?? extra.data,
    rawData: base.rawData ?? extra.rawData,
    transfer: base.transfer ?? extra.transfer,
    txHash: base.txHash ?? extra.txHash,
    height: base.height ?? extra.height,
    timestamp: base.timestamp ?? extra.timestamp,
  };
}

/**
 * Every outgoing packet in a transaction, in emission order.
 *
 * Accepts the `/cosmos/tx/v1beta1/txs/{hash}` envelope or a bare `tx_response`
 * row from a tx search, and reads both the `logs[].events` and flat `events`
 * shapes with either base64 or plain attribute encoding. Duplicates across the
 * two shapes are merged, so a response carrying both yields one packet per
 * `send_packet` event.
 *
 * Packets without a sequence or a source channel are dropped: they cannot be
 * looked up later, so reporting them would only produce a permanently `unknown`
 * hop.
 *
 * @param body - Parsed LCD JSON. Anything unexpected yields an empty array
 *   rather than throwing; an unindexed transaction is normal, not an error.
 */
export function extractPacketsFromTx(body: unknown): readonly ExtractedPacket[] {
  const txResponse = txResponseOf(body);
  if (!txResponse) return [];

  const txHash = asString(txResponse.txhash);
  const height = asUint(txResponse.height);
  const timestamp = asString(txResponse.timestamp);

  const order: string[] = [];
  const found = new Map<string, ExtractedPacket>();

  for (const group of eventGroupsOf(txResponse)) {
    // `ibc_transfer` carries the human-readable sender/receiver/amount and sits
    // in the same message as the `send_packet` it describes. Pair them by
    // ordinal within the message: a single MsgTransfer emits one of each.
    const transfers = group.events.filter((event) => eventIs(event, "ibc_transfer"));
    let sendIndex = 0;

    for (const event of group.events) {
      if (!eventIs(event, "send_packet")) continue;
      const sequence = asUint(attr(event, "packet_sequence"));
      const sourceChannelId = attr(event, "packet_src_channel");
      const ordinal = sendIndex;
      sendIndex += 1;
      if (sequence === null || sourceChannelId === null) continue;

      const rawData = packetDataOf(event);
      const transferEvent = transfers[ordinal] ?? (transfers.length === 1 ? transfers[0] : undefined);
      const packet: ExtractedPacket = {
        sequence,
        sourcePort: attr(event, "packet_src_port") ?? "transfer",
        sourceChannelId,
        destPort: attr(event, "packet_dst_port") ?? "transfer",
        destChannelId: attr(event, "packet_dst_channel") ?? "",
        timeoutHeight: attr(event, "packet_timeout_height"),
        timeoutTimestamp: asUint(attr(event, "packet_timeout_timestamp")),
        connectionId: attr(event, "packet_connection") ?? attr(event, "connection_id"),
        data: rawData === null ? null : parseIcs20PacketData(rawData),
        rawData,
        transfer: transferEvent === undefined ? null : transferSummaryOf(transferEvent),
        txHash,
        height,
        timestamp,
      };

      const key = packetKey(packet);
      const existing = found.get(key);
      if (existing) found.set(key, mergePacket(existing, packet));
      else {
        found.set(key, packet);
        order.push(key);
      }
    }
  }

  return order.map((key) => found.get(key)).filter(nonNull);
}

/* -------------------------------------------------------------------------- *
 * Acknowledgements
 * -------------------------------------------------------------------------- */

/** A parsed ICS04 acknowledgement. */
export interface PacketAck {
  /** True for `{"result": …}`, false for `{"error": …}`. */
  readonly ok: boolean;
  /** Error text, developer-facing. `null` on success. */
  readonly error: string | null;
  /** Base64 result payload, `null` on failure. */
  readonly result: string | null;
}

/**
 * Parse an acknowledgement string.
 *
 * The ICS04 envelope is `{"result":"<base64>"}` or `{"error":"<text>"}`. Not in
 * the verified spec, so an unrecognised shape returns `null` and the caller
 * keeps the status it already had rather than inventing a failure.
 */
export function parsePacketAcknowledgement(raw: string): PacketAck | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    // Some nodes hand back the base64 of the JSON rather than the JSON.
    const decoded = decodeValueCandidate(trimmed);
    if (decoded === null || decoded === trimmed) return null;
    return parsePacketAcknowledgement(decoded);
  }
  const row = asRecord(parsed);
  if (!row) return null;
  const error = asString(row.error);
  if (error !== null && error !== "") {
    return { ok: false, error, result: null };
  }
  if ("result" in row) {
    return { ok: true, error: null, result: asString(row.result) };
  }
  return null;
}

/**
 * Decide whether a delivery succeeded from the events of one transaction.
 *
 * Three signals, in order of reliability: the `packet_ack` on a
 * `write_acknowledgement`, and the transfer module's `fungible_token_packet`
 * `error` / `success` attributes, which is what the source chain has to work
 * with when it processes the acknowledgement.
 */
function readAckOutcome(events: readonly DecodedTxEvent[]): PacketAck | null {
  for (const event of events) {
    if (!eventIs(event, "write_acknowledgement")) continue;
    const raw = attr(event, "packet_ack") ?? mapHex(attr(event, "packet_ack_hex"));
    if (raw !== null) {
      const parsed = parsePacketAcknowledgement(raw);
      if (parsed) return parsed;
    }
  }
  for (const event of events) {
    if (!eventIs(event, "fungible_token_packet")) continue;
    const error = attr(event, "error");
    if (error !== null) return { ok: false, error, result: null };
    const raw = attr(event, "acknowledgement");
    if (raw !== null) {
      const parsed = parsePacketAcknowledgement(raw);
      if (parsed) return parsed;
    }
    const success = attr(event, "success");
    if (success !== null) {
      return { ok: success !== "false", error: null, result: null };
    }
  }
  return null;
}

function mapHex(raw: string | null): string | null {
  return raw === null ? null : hexToText(raw);
}

/* -------------------------------------------------------------------------- *
 * Timing
 * -------------------------------------------------------------------------- */

/**
 * How long each kind of hop should take, and when to call it stuck.
 *
 * Relayers normally land a packet inside a block or two. The defaults are
 * deliberately generous: a false "stalled" badge costs more user trust than a
 * spinner that runs a minute longer than it should.
 */
export interface HopTimingProfile {
  /** A plain ICS20 hop, sent to acknowledged. */
  readonly transferSeconds: number;
  /** A packet-forward-middleware hop, executed by the intermediate chain. */
  readonly forwardSeconds: number;
  /** A contract call inside packet processing; it adds little on its own. */
  readonly swapSeconds: number;
  /** A hop is stalled once it runs this many times over its estimate. */
  readonly stalledFactor: number;
  /** Floor for the stall threshold, so a fast hop does not alarm early. */
  readonly minStalledSeconds: number;
}

/** Defaults for {@link HopTimingProfile}: five minutes before escalating. */
export const DEFAULT_HOP_TIMING: HopTimingProfile = Object.freeze({
  transferSeconds: 60,
  forwardSeconds: 60,
  swapSeconds: 20,
  stalledFactor: 4,
  minStalledSeconds: 300,
});

function timingOf(overrides?: Partial<HopTimingProfile>): HopTimingProfile {
  return overrides ? { ...DEFAULT_HOP_TIMING, ...overrides } : DEFAULT_HOP_TIMING;
}

/** Expected duration of one hop, in seconds. */
export function estimateHopSeconds(
  kind: RouteHopKind,
  timing?: Partial<HopTimingProfile>,
): number {
  const profile = timingOf(timing);
  if (kind === "forward") return profile.forwardSeconds;
  if (kind === "swap") return profile.swapSeconds;
  return profile.transferSeconds;
}

/**
 * Expected end-to-end duration of a plan, in seconds.
 *
 * Offered so a caller can sanity-check {@link RoutePlan.estimatedDurationSeconds}
 * against the same profile the stall heuristic uses; the router owns the number
 * the user is shown before signing.
 */
export function estimateRouteSeconds(
  hops: readonly { readonly kind: RouteHopKind }[],
  timing?: Partial<HopTimingProfile>,
): number {
  return hops.reduce((total, hop) => total + estimateHopSeconds(hop.kind, timing), 0);
}

/** Age at which a hop stops being slow and starts being stuck, in seconds. */
export function hopStallThresholdSeconds(
  kind: RouteHopKind,
  timing?: Partial<HopTimingProfile>,
): number {
  const profile = timingOf(timing);
  return Math.max(
    profile.minStalledSeconds,
    estimateHopSeconds(kind, profile) * profile.stalledFactor,
  );
}

/** Input to {@link isHopStalled}. */
export interface StallCheck {
  readonly status: PacketStatus;
  readonly kind: RouteHopKind;
  /** Seconds since the hop started. `null` when the start time is unknown. */
  readonly elapsedSeconds: number | null;
  readonly timing?: Partial<HopTimingProfile>;
  /** Explicit threshold in seconds, overriding {@link hopStallThresholdSeconds}. */
  readonly stalledAfterSeconds?: number;
}

/**
 * Whether a hop has been waiting long enough to escalate.
 *
 * Only in-flight hops can stall. `received` is excluded on purpose: the funds
 * have landed on the destination and a late acknowledgement changes nothing the
 * user can act on, so flagging it would send them chasing a non-problem.
 */
export function isHopStalled(check: StallCheck): boolean {
  if (check.elapsedSeconds === null) return false;
  if (check.status !== "pending" && check.status !== "relayed" && check.status !== "unknown") {
    return false;
  }
  const threshold =
    check.stalledAfterSeconds ?? hopStallThresholdSeconds(check.kind, check.timing);
  return check.elapsedSeconds > threshold;
}

/* -------------------------------------------------------------------------- *
 * Status
 * -------------------------------------------------------------------------- */

/**
 * Why a transfer stopped, when it did.
 *
 * Kept separate from {@link PacketStatus} because the status says where the
 * packet is and this says what the user must do:
 *
 * - `timeout` — the packet expired before a relayer delivered it. The escrow is
 *   released on the source chain. Nothing to do.
 * - `ack-error` — the destination rejected the packet (a bad ibc-hooks memo, a
 *   missing receiver). Refunded on the source chain. Nothing to do.
 * - `stalled` — no relayer has touched it. The funds are safe and the packet is
 *   still live; the user waits or asks for a relayer.
 * - `swap-delivery-failed` — a crosschain-swap executed but the outbound
 *   transfer did not land. The output sits in the Osmosis contract and only the
 *   `local_recovery_addr` can pull it out, with `{"recover":{}}`.
 */
export type PacketFailureKind = "timeout" | "ack-error" | "stalled" | "swap-delivery-failed";

/** Terminal statuses: nothing further will happen to this packet. */
export function isTerminalPacketStatus(status: PacketStatus): boolean {
  return status === "acknowledged" || status === "timeout" || status === "failed";
}

/** The two chains a packet crosses. */
export interface PacketEndpoints {
  /** Chain the packet left. Always required: it holds the escrow. */
  readonly source: LcdClient;
  /**
   * Chain the packet is bound for. Optional because a route can pass through a
   * chain with no usable REST endpoint; the source side alone still resolves
   * every terminal status, just without the receive transaction hash.
   */
  readonly destination?: LcdClient | null;
}

/** Knobs for {@link getPacketStatus}. */
export interface PacketStatusOptions {
  readonly signal?: AbortSignal;
  /** Rows to ask for per search. The filters are exact, so a few suffice. */
  readonly limit?: number;
  /** Passed through to every LCD read (cache TTL, timeout). */
  readonly request?: LcdRequestOptions;
  /**
   * Query the destination chain. Set false for a cheap poll that only needs to
   * know whether the packet finished; the receive transaction and any forwarded
   * packets are then not reported.
   */
  readonly probeDestination?: boolean;
  /** Injected for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** What the chains say about one packet. */
export interface PacketStatusReport {
  readonly status: PacketStatus;
  readonly failure: PacketFailureKind | null;
  /** Transaction that delivered the packet on the destination chain. */
  readonly receiveTxHash: string | null;
  /** Transaction in which the source chain processed the acknowledgement. */
  readonly ackTxHash: string | null;
  /** Transaction in which the source chain processed the timeout. */
  readonly timeoutTxHash: string | null;
  /** Block time of the receive, RFC 3339. */
  readonly receivedAt: string | null;
  /** Block time of the acknowledgement or timeout, RFC 3339. */
  readonly completedAt: string | null;
  /** Error acknowledgement text. Developer-facing; never rendered raw. */
  readonly error: string | null;
  /** True when the source chain has already returned the escrow. */
  readonly fundsRefunded: boolean;
  /**
   * Packets the receiving transaction sent onward, which is how a
   * packet-forward or crosschain-swap hop is found. Empty unless the
   * destination was probed and the receive transaction was located.
   */
  readonly onwardPackets: readonly ExtractedPacket[];
  /** Which probes could not run. Diagnostics only. */
  readonly notes: readonly string[];
}

const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Re-throw the errors that must never be swallowed.
 *
 * `aborted` is the caller cancelling and `reads-disabled` is a settings prompt;
 * turning either into "status unknown" would lie about the chain. Every other
 * failure means this endpoint could not answer, which is what an unindexed
 * public LCD looks like, so tracking degrades instead of failing.
 */
function rethrowFatal(error: unknown): void {
  if (isInterchainError(error) && (error.code === "aborted" || error.code === "reads-disabled")) {
    throw error;
  }
}

function quote(value: string): string {
  // Tendermint's query grammar has no escape for a single quote, and channel
  // ids and sequences cannot contain one. Reject rather than build a query that
  // would silently match the wrong packet.
  if (value.includes("'")) {
    throw new InterchainError(
      "malformed-response",
      `Refusing to search for a value containing a quote: ${value}`,
    );
  }
  return `'${value}'`;
}

/**
 * Run one transaction search, tolerating both LCD spellings.
 *
 * @returns The `tx_responses` rows, or `null` when neither spelling worked —
 *   which is a node without a transaction index, not a missing packet.
 */
async function searchTxs(
  lcd: LcdClient,
  conditions: readonly string[],
  limit: number,
  request: LcdRequestOptions,
  notes: string[],
): Promise<readonly unknown[] | null> {
  const base = { ...request, query: undefined } satisfies LcdRequestOptions;

  try {
    const body = await lcd.getJson("/cosmos/tx/v1beta1/txs", {
      ...base,
      query: { query: conditions.join(" AND "), order_by: "ORDER_BY_DESC", limit },
    });
    return asArray(asRecord(body)?.tx_responses);
  } catch (error) {
    rethrowFatal(error);
  }

  // SDK ≤ 0.46 wants one `events` parameter per condition. A repeated key
  // cannot be expressed through LcdRequestOptions.query, so this is the one
  // place in the package that hand-builds a query string.
  try {
    const repeated = conditions.map((c) => `events=${encodeURIComponent(c)}`).join("&");
    const body = await lcd.getJson(`/cosmos/tx/v1beta1/txs?${repeated}`, {
      ...base,
      query: { order_by: "ORDER_BY_DESC", limit },
    });
    return asArray(asRecord(body)?.tx_responses);
  } catch (error) {
    rethrowFatal(error);
    notes.push(`${lcd.chainId}: tx search unavailable (${conditions[0] ?? ""})`);
    return null;
  }
}

/** One transaction that mentions our packet. */
interface PacketHit {
  readonly txHash: string | null;
  readonly timestamp: string | null;
  readonly events: readonly DecodedTxEvent[];
  readonly row: unknown;
}

function matchesPacket(event: DecodedTxEvent, ref: PacketRef): boolean {
  if (asUint(attr(event, "packet_sequence")) !== ref.sequence) return false;
  const src = attr(event, "packet_src_channel");
  if (src !== null && src !== ref.sourceChannelId) return false;
  const dst = attr(event, "packet_dst_channel");
  if (dst !== null && ref.destChannelId !== "" && dst !== ref.destChannelId) return false;
  return true;
}

/**
 * The first returned transaction that really contains our packet.
 *
 * The search filters are re-checked here: some indexers match attributes across
 * different events in the same transaction, so a relayer batch can come back
 * for a packet that is not ours.
 */
function findPacketHit(
  rows: readonly unknown[] | null,
  eventType: string,
  ref: PacketRef,
): PacketHit | null {
  if (rows === null) return null;
  for (const row of rows) {
    const txResponse = txResponseOf(row);
    if (!txResponse) continue;
    const events = eventGroupsOf(txResponse).flatMap((group) => group.events);
    const hit = events.some((event) => eventIs(event, eventType) && matchesPacket(event, ref));
    if (!hit) continue;
    return {
      txHash: asString(txResponse.txhash),
      timestamp: asString(txResponse.timestamp),
      events,
      row,
    };
  }
  return null;
}

/**
 * Whether the packet's timeout can already have fired.
 *
 * Skipping the timeout search while the deadline is in the future halves the
 * request count for the common in-flight poll. Height timeouts cannot be
 * checked without the counterparty's current height, so a packet with only a
 * height timeout is always probed.
 */
function timeoutMayHaveFired(ref: PacketRef, nowMs: number): boolean {
  const nanos = ref.timeoutTimestamp;
  if (nanos === undefined || nanos === null || nanos === "" || nanos === "0") return true;
  let deadline: bigint;
  try {
    deadline = BigInt(nanos);
  } catch {
    return true;
  }
  return BigInt(Math.floor(nowMs)) * 1_000_000n >= deadline;
}

/**
 * Ask both chains where one packet is.
 *
 * The source chain is asked first for a terminal answer — `acknowledge_packet`,
 * then `timeout_packet` if the deadline has passed — because those are the only
 * states that end the user's wait. The destination chain is asked in parallel
 * for `write_acknowledgement` (which carries the acknowledgement itself) and
 * falls back to `recv_packet`, which also yields the transaction that forwarded
 * the packet onward for the next hop.
 *
 * Never throws for a chain that cannot answer: a public LCD with transaction
 * indexing off reports `unknown`, and the caller keeps polling.
 *
 * @throws {@link InterchainError} `aborted` or `reads-disabled` only.
 */
export async function getPacketStatus(
  packet: PacketRef,
  endpoints: PacketEndpoints,
  options: PacketStatusOptions = {},
): Promise<PacketStatusReport> {
  const notes: string[] = [];
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const nowMs = (options.now ?? Date.now)();
  const request: LcdRequestOptions = {
    ...options.request,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const destination = endpoints.destination ?? null;

  const seq = quote(packet.sequence);
  const src = quote(packet.sourceChannelId);
  const dst = packet.destChannelId === "" ? null : quote(packet.destChannelId);

  function conditions(prefix: string, withDest: boolean): string[] {
    const out = [`${prefix}.packet_sequence=${seq}`, `${prefix}.packet_src_channel=${src}`];
    if (withDest && dst !== null) out.push(`${prefix}.packet_dst_channel=${dst}`);
    return out;
  }

  let probesRan = 0;

  async function probeSource(): Promise<{ ack: PacketHit | null; timeout: PacketHit | null }> {
    const ackRows = await searchTxs(
      endpoints.source,
      conditions("acknowledge_packet", true),
      limit,
      request,
      notes,
    );
    if (ackRows !== null) probesRan += 1;
    const ack = findPacketHit(ackRows, "acknowledge_packet", packet);
    if (ack) return { ack, timeout: null };

    if (!timeoutMayHaveFired(packet, nowMs)) return { ack: null, timeout: null };
    const timeoutRows = await searchTxs(
      endpoints.source,
      conditions("timeout_packet", true),
      limit,
      request,
      notes,
    );
    if (timeoutRows !== null) probesRan += 1;
    return { ack: null, timeout: findPacketHit(timeoutRows, "timeout_packet", packet) };
  }

  async function probeDest(): Promise<{ write: PacketHit | null; recv: PacketHit | null }> {
    if (destination === null || options.probeDestination === false) {
      return { write: null, recv: null };
    }
    const writeRows = await searchTxs(
      destination,
      conditions("write_acknowledgement", true),
      limit,
      request,
      notes,
    );
    if (writeRows !== null) probesRan += 1;
    const write = findPacketHit(writeRows, "write_acknowledgement", packet);
    if (write) return { write, recv: null };

    const recvRows = await searchTxs(
      destination,
      conditions("recv_packet", true),
      limit,
      request,
      notes,
    );
    if (recvRows !== null) probesRan += 1;
    return { write: null, recv: findPacketHit(recvRows, "recv_packet", packet) };
  }

  const [source, dest] = await Promise.all([probeSource(), probeDest()]);

  const delivery = dest.write ?? dest.recv;
  const onwardPackets = delivery === null ? [] : extractPacketsFromTx(delivery.row);
  const receiveTxHash = delivery?.txHash ?? null;
  const receivedAt = delivery?.timestamp ?? null;

  // The acknowledgement text is best read on the destination, where
  // `write_acknowledgement` carries it verbatim; the source chain's
  // `fungible_token_packet` is the fallback when the destination was not probed.
  const destAck = dest.write === null ? null : readAckOutcome(dest.write.events);
  const sourceAck = source.ack === null ? null : readAckOutcome(source.ack.events);
  const outcome = destAck ?? sourceAck;

  if (source.timeout !== null) {
    return {
      status: "timeout",
      failure: "timeout",
      receiveTxHash,
      ackTxHash: null,
      timeoutTxHash: source.timeout.txHash,
      receivedAt,
      completedAt: source.timeout.timestamp,
      error: null,
      fundsRefunded: true,
      onwardPackets,
      notes,
    };
  }

  if (source.ack !== null) {
    const failed = outcome !== null && !outcome.ok;
    return {
      status: failed ? "failed" : "acknowledged",
      failure: failed ? "ack-error" : null,
      receiveTxHash,
      ackTxHash: source.ack.txHash,
      timeoutTxHash: null,
      receivedAt,
      completedAt: source.ack.timestamp,
      error: failed ? (outcome?.error ?? "packet acknowledgement reported an error") : null,
      fundsRefunded: failed,
      onwardPackets,
      notes,
    };
  }

  if (dest.write !== null) {
    // An error acknowledgement is already decided on the destination; the
    // refund only lands once the relayer brings it home, so say so now rather
    // than showing "received" for a packet that has failed.
    if (destAck !== null && !destAck.ok) {
      return {
        status: "failed",
        failure: "ack-error",
        receiveTxHash,
        ackTxHash: null,
        timeoutTxHash: null,
        receivedAt,
        completedAt: null,
        error: destAck.error,
        fundsRefunded: false,
        onwardPackets,
        notes,
      };
    }
    return {
      status: "received",
      failure: null,
      receiveTxHash,
      ackTxHash: null,
      timeoutTxHash: null,
      receivedAt,
      completedAt: null,
      error: null,
      fundsRefunded: false,
      onwardPackets,
      notes,
    };
  }

  if (dest.recv !== null) {
    return {
      status: "relayed",
      failure: null,
      receiveTxHash,
      ackTxHash: null,
      timeoutTxHash: null,
      receivedAt,
      completedAt: null,
      error: null,
      fundsRefunded: false,
      onwardPackets,
      notes,
    };
  }

  return {
    status: probesRan === 0 ? "unknown" : "pending",
    failure: null,
    receiveTxHash: null,
    ackTxHash: null,
    timeoutTxHash: null,
    receivedAt: null,
    completedAt: null,
    error: null,
    fundsRefunded: false,
    onwardPackets: [],
    notes,
  };
}

/* -------------------------------------------------------------------------- *
 * Crosschain-swap recovery
 * -------------------------------------------------------------------------- */

/**
 * The crosschain-swaps recovery call, `{"recover":{}}`.
 *
 * Verified in INTERCHAIN-SPEC.md §3: when a swap succeeds but the outbound
 * delivery fails, the output is held for the `local_recovery_addr` the swap was
 * built with, and that address calls this to withdraw it.
 */
export const XCS_RECOVER_EXECUTE_MSG: JsonObject = Object.freeze({
  recover: Object.freeze({}),
});

/** Inputs for {@link buildXcsRecoverMsg}. */
export interface XcsRecoverRequest {
  /**
   * The crosschain-swaps contract on Osmosis. Host configuration supplies it:
   * the spec's candidate addresses are unverified and must never be constants.
   */
  readonly contractAddress: string;
  /**
   * The address that recovers the funds. Must be the `local_recovery_addr` the
   * swap declared in `on_failed_delivery`; the contract pays out to no one else.
   */
  readonly recoveryAddress: string;
}

/**
 * Build the message that pulls stuck swap output out of the contract.
 *
 * Returns an unsigned {@link BuiltMsg}. This package does not sign: the host
 * hands this to zunia-core, which encodes and signs it, and broadcasts it on
 * the swap chain — Osmosis, not the chain the user started from.
 *
 * @throws {@link InterchainError} `invalid-request` when either address is
 *   empty, which is a configuration bug rather than a chain failure.
 */
export function buildXcsRecoverMsg(request: XcsRecoverRequest): BuiltMsg {
  const contract = request.contractAddress.trim();
  const sender = request.recoveryAddress.trim();
  if (contract === "" || sender === "") {
    throw new InterchainError(
      "invalid-request",
      "Recovering swap output needs both the crosschain-swaps contract and the recovery address",
    );
  }
  // Encoded by the package's one `MsgExecuteContract` builder. Two builders
  // would be two chances to disagree with the kernel about whether `msg` is
  // base64 or an inline object, and only one of them can be right.
  return buildExecuteContractMsg({
    sender,
    contract,
    msg: XCS_RECOVER_EXECUTE_MSG,
  });
}

/** Everything the UI needs to offer "recover my funds". */
export interface XcsRecovery {
  /** Chain the contract lives on, and where the recovery must be broadcast. */
  readonly chainId: string;
  /** The crosschain-swaps contract, when the host configured one. */
  readonly contractAddress: string | null;
  /** The address allowed to recover, from `on_failed_delivery`. */
  readonly recoveryAddress: string | null;
  /** The execute body, for display. */
  readonly executeMsg: JsonObject;
  /** Ready for the signer, or `null` when an address is missing. */
  readonly msg: BuiltMsg | null;
}

/* -------------------------------------------------------------------------- *
 * Route tracking
 * -------------------------------------------------------------------------- */

/**
 * Finds the LCD for a chain id, or `null` when the host cannot read it.
 *
 * Returning `null` rather than throwing keeps a route trackable through a chain
 * with no public REST endpoint: those hops report `unknown` and the hops around
 * them still resolve.
 */
export type LcdResolver = (chainId: string) => LcdClient | null;

/**
 * Bridge a host's {@link ChainRegistry} and {@link LcdClientFactory} into an
 * {@link LcdResolver}.
 *
 * Chains that are unknown, or known but without a REST endpoint, resolve to
 * `null` instead of throwing out of the factory.
 */
export function createLcdResolver(
  registry: ChainRegistry,
  factory: LcdClientFactory,
): LcdResolver {
  return (chainId: string): LcdClient | null => {
    const chain = registry.get(chainId);
    if (!chain || lcdEndpointsFromChain(chain).length === 0) return null;
    return factory(chain);
  };
}

/** One hop of a {@link RouteTrace}. */
export interface RouteHopTrace extends PacketHopTrace {
  /** What this hop does, copied from the plan. */
  readonly kind: RouteHopKind;
  readonly failure: PacketFailureKind | null;
  readonly ackTxHash: string | null;
  readonly timeoutTxHash: string | null;
  /** When the hop's packet was sent, RFC 3339. */
  readonly startedAt: string | null;
  /** When it was acknowledged or timed out, RFC 3339. */
  readonly completedAt: string | null;
  /** Time spent so far, or in total once complete. */
  readonly elapsedSeconds: number | null;
  /** What {@link estimateHopSeconds} expects for this kind of hop. */
  readonly expectedSeconds: number;
  /** True once {@link isHopStalled} says the wait is abnormal. */
  readonly stalled: boolean;
  /** True when the source chain has already returned the escrow. */
  readonly fundsRefunded: boolean;
}

/**
 * Where a whole route has got to.
 *
 * A {@link PacketTrace} with the extra fields a UI needs to escalate: which hop
 * is current, whether the wait is abnormal, and whether funds are recoverable.
 */
export interface RouteTrace extends PacketTrace {
  readonly hops: readonly RouteHopTrace[];
  /** The one thing that went wrong, or `null` while the route is healthy. */
  readonly failure: PacketFailureKind | null;
  /** Set only for `swap-delivery-failed`: how to get the money back. */
  readonly recovery: XcsRecovery | null;
  /** True when any in-flight hop has passed its stall threshold. */
  readonly stalled: boolean;
  /** Index of the hop the user is waiting on, for "hop 2 of 3". */
  readonly currentHopIndex: number;
  /** Seconds since the source transaction, when its block time is known. */
  readonly elapsedSeconds: number | null;
  /** Sum of the per-hop estimates, for the "arrives in about…" line. */
  readonly estimatedDurationSeconds: number;
  /** Diagnostics: probes that could not run, ambiguous forwards. Never shown raw. */
  readonly notes: readonly string[];
}

/** Knobs for {@link trackRoute}. */
export interface TrackRouteOptions {
  /** Cancels in-flight reads. Aborting throws `InterchainError` code `aborted`. */
  readonly signal?: AbortSignal;
  /**
   * Called with the trace after each hop resolves, so a poll renders progress
   * instead of waiting for the whole walk. Exceptions from the callback are
   * swallowed: a broken renderer must not lose the trace.
   */
  readonly onUpdate?: (trace: RouteTrace) => void;
  readonly timing?: Partial<HopTimingProfile>;
  /** Explicit stall threshold in seconds, overriding the profile. */
  readonly stalledAfterSeconds?: number;
  /** Passed to every LCD read. Keep the cache TTL short while polling. */
  readonly request?: LcdRequestOptions;
  readonly limit?: number;
  /** See {@link PacketStatusOptions.probeDestination}. */
  readonly probeDestination?: boolean;
  /**
   * Sequence of the packet to follow, when the source transaction sent more
   * than one. Without it the packet is matched on the first hop's channel.
   */
  readonly sourcePacketSequence?: string;
  /**
   * Base-unit amount being moved. A relayer batches many packets into one
   * transaction, so when several forwarded packets leave on the next hop's
   * channel this picks ours: packet-forward-middleware forwards the amount
   * unchanged.
   */
  readonly expectedAmount?: string;
  /** Crosschain-swaps contract, for the recovery message. Host configuration. */
  readonly swapContract?: string;
  /** The `local_recovery_addr` the swap was built with. */
  readonly recoveryAddress?: string;
  /** Injected for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function secondsBetween(fromMs: number | null, toMs: number | null): number | null {
  if (fromMs === null || toMs === null) return null;
  return Math.max(0, Math.round((toMs - fromMs) / 1000));
}

/**
 * Pick the packet this route forwarded out of everything the relayer's
 * transaction sent.
 *
 * Channel and port narrow it; the amount settles a batch. When the amount does
 * not settle it either, the first match is used and the caller is told, because
 * a slightly wrong hop trace is better than no trace and the ambiguity must not
 * be silent.
 */
function pickOnwardPacket(
  packets: readonly ExtractedPacket[],
  channelId: string,
  port: string,
  expectedAmount: string | undefined,
  notes: string[],
): ExtractedPacket | null {
  const onChannel = packets.filter(
    (packet) =>
      packet.sourceChannelId === channelId &&
      (port === "" || packet.sourcePort === port),
  );
  if (onChannel.length === 0) return null;
  if (onChannel.length === 1) return onChannel[0] ?? null;

  if (expectedAmount !== undefined) {
    const byAmount = onChannel.filter((packet) => packet.data?.amount === expectedAmount);
    if (byAmount.length === 1) return byAmount[0] ?? null;
  }
  notes.push(
    `Several packets left on ${channelId} in the same transaction; followed the first`,
  );
  return onChannel[0] ?? null;
}

function throwIfAborted(signal: AbortSignal | undefined, chainId: string): void {
  if (signal?.aborted === true) {
    throw new InterchainError("aborted", `${chainId}: tracking cancelled`, { chainId });
  }
}

/**
 * Fetch one transaction by hash.
 *
 * @returns `null` when the node has not indexed it, which is normal for the
 *   first few seconds after a broadcast and must never read as a failure.
 */
async function fetchTx(
  lcd: LcdClient,
  txHash: string,
  request: LcdRequestOptions,
): Promise<unknown | null> {
  try {
    return await lcd.getJson(`/cosmos/tx/v1beta1/txs/${encodeURIComponent(txHash)}`, request);
  } catch (error) {
    rethrowFatal(error);
    if (isInterchainError(error) && error.httpStatus === 404) return null;
    throw error;
  }
}

/** Normalise a user-pasted hash: uppercase hex, no `0x`. */
function normalizeTxHash(raw: string): string {
  const trimmed = raw.trim();
  const body = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  return body.toUpperCase();
}

/**
 * Follow a signed route across every hop.
 *
 * Starts from the transaction the user signed, reads its `send_packet` events,
 * and then walks forward: each hop's receive transaction on the intermediate
 * chain contains the packet that packet-forward-middleware or the
 * crosschain-swaps contract sent onward, which becomes the next hop's packet.
 * The walk stops at the first hop that has not moved, so a poll costs a bounded
 * number of reads.
 *
 * Nothing here signs, and nothing here needs the user's key: every read is a
 * public LCD query.
 *
 * @param plan - The plan the transaction was built from. Only the hop list,
 *   chain ids and channels are read; the memo is not re-derived.
 * @param sourceTxHash - Hash of the transaction the user signed.
 * @param resolve - Chain id to {@link LcdClient}; see {@link createLcdResolver}.
 * @throws {@link InterchainError} `no-route` for an empty plan,
 *   `unsupported-chain` when the source chain has no reachable REST endpoint,
 *   `aborted` when cancelled, `reads-disabled` when the host gate is off, or
 *   `lcd-unreachable` when the source transaction itself cannot be read.
 */
export async function trackRoute(
  plan: RoutePlan,
  sourceTxHash: string,
  resolve: LcdResolver,
  options: TrackRouteOptions = {},
): Promise<RouteTrace> {
  const hops = plan.hops;
  if (hops.length === 0) {
    throw new InterchainError("no-route", "Cannot track a plan with no hops", {
      chainId: plan.sourceChainId,
    });
  }

  const now = options.now ?? Date.now;
  const notes: string[] = [];
  const txHash = normalizeTxHash(sourceTxHash);
  const request: LcdRequestOptions = {
    ...options.request,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const estimatedDurationSeconds = estimateRouteSeconds(hops, options.timing);

  const sourceLcd = resolve(plan.sourceChainId);
  if (sourceLcd === null) {
    throw new InterchainError(
      "unsupported-chain",
      `No REST endpoint for ${plan.sourceChainId}`,
      { chainId: plan.sourceChainId },
    );
  }

  const traces: RouteHopTrace[] = [];
  let failure: PacketFailureKind | null = null;
  let recovery: XcsRecovery | null = null;
  let sourceStartedAt: string | null = null;

  function emptyHop(index: number, status: PacketStatus): RouteHopTrace {
    const hop = hops[index];
    return {
      index,
      chainId: hop?.chainId ?? plan.sourceChainId,
      channelId: hop?.channelId ?? "",
      port: hop?.port ?? "transfer",
      counterpartyChainId: hop?.counterpartyChainId ?? null,
      kind: hop?.kind ?? "transfer",
      sequence: null,
      sendTxHash: null,
      receiveTxHash: null,
      ackTxHash: null,
      timeoutTxHash: null,
      status,
      error: null,
      failure: null,
      startedAt: null,
      completedAt: null,
      elapsedSeconds: null,
      expectedSeconds: estimateHopSeconds(hop?.kind ?? "transfer", options.timing),
      stalled: false,
      fundsRefunded: false,
    };
  }

  function assemble(): RouteTrace {
    const padded = [...traces];
    // Hops the walk never reached: `pending` while the route is alive, and
    // `unknown` after a failure, because they will now never happen and calling
    // them pending would promise an arrival that is not coming.
    const filler: PacketStatus = failure === null || failure === "stalled" ? "pending" : "unknown";
    for (let i = padded.length; i < hops.length; i++) padded.push(emptyHop(i, filler));

    const firstOpen = padded.findIndex((hop) => !isTerminalPacketStatus(hop.status));
    const currentHopIndex = firstOpen === -1 ? padded.length - 1 : firstOpen;
    const broken = padded.find((hop) => hop.status === "timeout" || hop.status === "failed");
    const last = padded[padded.length - 1];
    const open = firstOpen === -1 ? null : padded[firstOpen];
    // A failure anywhere wins: a later hop sitting at `pending` describes a
    // packet that was never sent.
    const status: PacketStatus =
      broken?.status ?? open?.status ?? last?.status ?? "unknown";

    const startMs = parseTime(sourceStartedAt);
    return {
      sourceChainId: plan.sourceChainId,
      destChainId: plan.destChainId,
      sourceTxHash: txHash,
      hops: padded,
      status,
      failure,
      recovery,
      stalled: padded.some((hop) => hop.stalled),
      currentHopIndex,
      elapsedSeconds: secondsBetween(startMs, now()),
      estimatedDurationSeconds,
      notes,
      updatedAt: now(),
    };
  }

  function publish(): RouteTrace {
    const trace = assemble();
    if (options.onUpdate) {
      try {
        options.onUpdate(trace);
      } catch {
        // A rendering bug in the host must not abort tracking.
      }
    }
    return trace;
  }

  throwIfAborted(options.signal, plan.sourceChainId);
  const sourceTx = await fetchTx(sourceLcd, txHash, request);
  if (sourceTx === null) {
    notes.push(`${plan.sourceChainId}: transaction not indexed yet`);
    return publish();
  }

  sourceStartedAt = asString(txResponseOf(sourceTx)?.timestamp);
  const sourcePackets = extractPacketsFromTx(sourceTx);
  const firstHop = hops[0];
  let packet: ExtractedPacket | null =
    (options.sourcePacketSequence !== undefined
      ? (sourcePackets.find((p) => p.sequence === options.sourcePacketSequence) ?? null)
      : null) ??
    (firstHop
      ? pickOnwardPacket(
          sourcePackets,
          firstHop.channelId,
          firstHop.port,
          options.expectedAmount,
          notes,
        )
      : null) ??
    sourcePackets[0] ??
    null;

  if (packet === null) {
    notes.push(`${plan.sourceChainId}: no IBC packet found in ${txHash}`);
    return publish();
  }

  let hopStartedAt: string | null = sourceStartedAt ?? packet.timestamp;
  let previousReceiveTxHash: string | null = null;
  let stop = false;

  for (let index = 0; index < hops.length && !stop; index++) {
    const hop = hops[index];
    if (!hop) break;
    throwIfAborted(options.signal, hop.chainId);

    // A hop with no channel is a contract call inside packet processing — an
    // ibc-hooks swap. It sends no packet of its own, so its state is the state
    // of the delivery that triggered it.
    if (hop.channelId === "") {
      const previous = traces[index - 1];
      const derived: PacketStatus =
        index === 0
          ? "pending"
          : previous === undefined
            ? "unknown"
            : previous.status === "acknowledged" || previous.status === "received"
              ? "received"
              : previous.status;
      traces.push({
        ...emptyHop(index, derived),
        receiveTxHash: previousReceiveTxHash,
        startedAt: hopStartedAt,
      });
      publish();
      continue;
    }

    if (packet === null) {
      // The previous hop has not forwarded anything yet, so this hop has no
      // packet to look up. Report it as waiting and stop: nothing beyond it can
      // be known this round.
      traces.push({ ...emptyHop(index, "pending"), startedAt: hopStartedAt });
      publish();
      stop = true;
      continue;
    }
    const current: ExtractedPacket = packet;

    const destChainId = hops[index + 1]?.chainId ?? hop.counterpartyChainId;
    const destination = destChainId === null || destChainId === undefined
      ? null
      : resolve(destChainId);
    if (destination === null && destChainId !== null && destChainId !== undefined) {
      notes.push(`${destChainId}: no REST endpoint, hop ${index} tracked from the source only`);
    }

    const report = await getPacketStatus(
      current,
      { source: resolve(hop.chainId) ?? sourceLcd, destination },
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.probeDestination === undefined
          ? {}
          : { probeDestination: options.probeDestination }),
        request,
        now,
      },
    );
    notes.push(...report.notes);

    const startedMs = parseTime(hopStartedAt);
    const endedMs = parseTime(report.completedAt ?? report.receivedAt);
    const elapsedSeconds = secondsBetween(startedMs, endedMs ?? now());
    const stalled = isHopStalled({
      status: report.status,
      kind: hop.kind,
      elapsedSeconds: endedMs === null ? elapsedSeconds : null,
      ...(options.timing ? { timing: options.timing } : {}),
      ...(options.stalledAfterSeconds === undefined
        ? {}
        : { stalledAfterSeconds: options.stalledAfterSeconds }),
    });

    traces.push({
      index,
      chainId: hop.chainId,
      channelId: hop.channelId,
      port: hop.port,
      counterpartyChainId: hop.counterpartyChainId ?? destChainId ?? null,
      kind: hop.kind,
      sequence: current.sequence,
      sendTxHash: index === 0 ? txHash : (current.txHash ?? previousReceiveTxHash),
      receiveTxHash: report.receiveTxHash,
      ackTxHash: report.ackTxHash,
      timeoutTxHash: report.timeoutTxHash,
      status: report.status,
      error: report.error,
      failure: report.failure,
      startedAt: hopStartedAt,
      completedAt: report.completedAt ?? report.receivedAt,
      elapsedSeconds,
      expectedSeconds: estimateHopSeconds(hop.kind, options.timing),
      stalled,
      fundsRefunded: report.fundsRefunded,
    });

    if (report.failure !== null) {
      failure = report.failure;
      // Funds only sit in the crosschain-swaps contract when the swap itself
      // worked and the hop *leaving* the swap chain failed. A failure before
      // the swap refunds on the source chain and needs no recovery.
      const swapIndex = hops.findIndex((candidate) => candidate.kind === "swap");
      if (swapIndex !== -1 && index > swapIndex) {
        failure = "swap-delivery-failed";
        const swapChainId = hops[swapIndex]?.chainId ?? hop.chainId;
        const contractAddress = options.swapContract ?? null;
        const recoveryAddress = options.recoveryAddress ?? null;
        recovery = {
          chainId: swapChainId,
          contractAddress,
          recoveryAddress,
          executeMsg: XCS_RECOVER_EXECUTE_MSG,
          msg:
            contractAddress === null || recoveryAddress === null
              ? null
              : buildXcsRecoverMsg({ contractAddress, recoveryAddress }),
        };
        if (recovery.msg === null) {
          notes.push(
            "Swap output is stuck in the contract but no recovery address was configured",
          );
        }
      }
      stop = true;
    } else if (stalled) {
      failure = "stalled";
    }

    publish();
    if (stop) break;

    // Chain to the next hop: the forwarded packet lives in the transaction that
    // delivered this one. A swap hop moves no packet of its own, so look past it
    // to the hop that does — the crosschain-swaps contract sends the outbound
    // transfer from inside the same delivery.
    previousReceiveTxHash = report.receiveTxHash;
    hopStartedAt = report.receivedAt ?? hopStartedAt;
    let nextIndex = index + 1;
    while (nextIndex < hops.length && hops[nextIndex]?.channelId === "") nextIndex += 1;
    const next = hops[nextIndex];
    // `null` here is not a failure: the packet may simply not have been
    // forwarded yet, or the destination chain was not probed. The next
    // iteration reports that hop as waiting and stops.
    packet = next
      ? pickOnwardPacket(
          report.onwardPackets,
          next.channelId,
          next.port,
          options.expectedAmount ?? current.data?.amount ?? undefined,
          notes,
        )
      : null;
  }

  return publish();
}
