/**
 * The ICS20 `MsgTransfer`: the one message every IBC route asks the user to
 * sign.
 *
 * The planner decides the channel, the receiver and the memo; this module only
 * writes them down in the proto-JSON shape zunia-core's `msg_from_proto_json`
 * parses. Hosts used to assemble it themselves, and a field renamed in one of
 * them fails on chain as an opaque decode error after the user has approved.
 *
 * Every transfer carries a timestamp timeout. A packet with neither a height
 * nor a timestamp never expires, so its escrow is never refunded if no relayer
 * delivers it; the kernel refuses one, and so does this builder.
 */

import { memoByteLength, PACKET_MEMO_MAX_BYTES } from "./memo.js";
import {
  InterchainError,
  TRANSFER_PORT,
  type BuiltMsg,
  type Coin,
  type RoutePlan,
} from "./types.js";

/** Proto type URL of an ICS20 transfer. */
export const MSG_TRANSFER_TYPE_URL = "/ibc.applications.transfer.v1.MsgTransfer";

/** Minutes until an unrelayed packet expires and its escrow is refunded. */
export const DEFAULT_TRANSFER_TIMEOUT_MINUTES = 10;

/** ICS-024 identifier characters and length, for ports and channels. */
const IDENTIFIER = /^[a-zA-Z0-9._+\-#[\]<>]{2,128}$/;
const BASE_UNITS = /^[0-9]+$/;

export interface TransferMsgRequest {
  /** Defaults to {@link TRANSFER_PORT}. */
  readonly sourcePort?: string;
  readonly sourceChannel: string;
  /** Denom as held on the sending chain, amount in base units. */
  readonly token: Coin;
  readonly sender: string;
  /**
   * ICS20 receiver. Not always the final recipient: a forward is addressed to
   * the next chain, and an ibc-hooks call to the contract.
   */
  readonly receiver: string;
  /** `""` or absent for no memo. */
  readonly memo?: string;
  /** Defaults to {@link DEFAULT_TRANSFER_TIMEOUT_MINUTES}. */
  readonly timeoutMinutes?: number;
}

export interface TransferMsgOptions {
  /** Injected for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Memo ceiling in UTF-8 bytes. Defaults to {@link PACKET_MEMO_MAX_BYTES}. */
  readonly maxMemoBytes?: number;
}

function invalid(message: string, channelId?: string): InterchainError {
  return new InterchainError("invalid-request", message, channelId ? { channelId } : {});
}

/**
 * Build a `MsgTransfer` from its fields.
 *
 * @throws {@link InterchainError} `invalid-request` for a missing or malformed
 *   field, a zero amount or a timeout that is not in the future;
 *   `invalid-memo` for a memo over the byte ceiling.
 */
export function buildTransferMsg(
  request: TransferMsgRequest,
  options: TransferMsgOptions = {},
): BuiltMsg {
  const port = request.sourcePort ?? TRANSFER_PORT;
  const channel = request.sourceChannel;
  if (!IDENTIFIER.test(port)) throw invalid(`"${port}" is not a port identifier`);
  if (!IDENTIFIER.test(channel)) {
    throw invalid(`"${channel}" is not a channel identifier`, channel || undefined);
  }
  if (!request.token.denom) throw invalid("The token has no denom", channel);
  if (!BASE_UNITS.test(request.token.amount) || BigInt(request.token.amount) === 0n) {
    throw invalid("The amount must be a whole number of base units above zero", channel);
  }
  if (!request.sender) throw invalid("The sender is required", channel);
  if (!request.receiver) throw invalid("The receiver is required", channel);

  const memo = request.memo ?? "";
  const maxBytes = options.maxMemoBytes ?? PACKET_MEMO_MAX_BYTES;
  if (memoByteLength(memo) > maxBytes) {
    throw new InterchainError(
      "invalid-memo",
      `The memo is ${memoByteLength(memo)} bytes, over the ${maxBytes}-byte limit`,
      { channelId: channel },
    );
  }

  const minutes = request.timeoutMinutes ?? DEFAULT_TRANSFER_TIMEOUT_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw invalid("The timeout must be a number of minutes above zero", channel);
  }
  const now = options.now ?? (() => Date.now());
  // BigInt: nanoseconds since the epoch are far past 2^53, and a `number`
  // would round to a different instant.
  const millis = Math.floor(now()) + Math.round(minutes * 60_000);
  const timeoutTimestamp = (BigInt(millis) * 1_000_000n).toString();

  return {
    typeUrl: MSG_TRANSFER_TYPE_URL,
    value: {
      source_port: port,
      source_channel: channel,
      token: { denom: request.token.denom, amount: request.token.amount },
      sender: request.sender,
      receiver: request.receiver,
      // Explicit zero height: the timestamp above is the timeout.
      timeout_height: { revision_number: "0", revision_height: "0" },
      timeout_timestamp: timeoutTimestamp,
      memo,
    },
  };
}

/**
 * Build the transfer a plan starts with: the channel and port of `hops[0]`,
 * the plan's input denom and memo verbatim, and the candidate's ICS20
 * receiver (the contract for a swap, the next chain for a forward).
 *
 * @throws {@link InterchainError} `invalid-request` when the plan does not
 *   start with a transfer (a bank send or a local swap signs no packet), plus
 *   everything {@link buildTransferMsg} throws.
 */
export function buildPlanTransferMsg(
  input: {
    readonly plan: RoutePlan;
    readonly receiver: string;
    readonly sender: string;
    readonly amount: string;
    readonly timeoutMinutes?: number;
  },
  options: TransferMsgOptions = {},
): BuiltMsg {
  const hop = input.plan.hops[0];
  if (!hop || hop.kind === "swap" || !hop.channelId) {
    throw invalid("This plan has no transfer for the user to sign");
  }
  return buildTransferMsg(
    {
      sourcePort: hop.port || TRANSFER_PORT,
      sourceChannel: hop.channelId,
      token: { denom: input.plan.inputDenom, amount: input.amount },
      sender: input.sender,
      receiver: input.receiver,
      memo: input.plan.memo,
      ...(input.timeoutMinutes === undefined ? {} : { timeoutMinutes: input.timeoutMinutes }),
    },
    options,
  );
}
