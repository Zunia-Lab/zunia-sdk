import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeBase64Utf8, encodeBase64Utf8, jsonToBase64 } from "./base64.js";
import {
  DEFAULT_HOP_TIMING,
  buildXcsRecoverMsg,
  createLcdResolver,
  decodeTxEvents,
  estimateHopSeconds,
  estimateRouteSeconds,
  extractPacketsFromTx,
  getPacketStatus,
  hopStallThresholdSeconds,
  isHopStalled,
  isTerminalPacketStatus,
  parseIcs20PacketData,
  parsePacketAcknowledgement,
  trackRoute,
  type LcdResolver,
  type RouteTrace,
} from "./tracking.js";
import {
  InterchainError,
  isInterchainError,
  type ChainInfoLike,
  type ChainRegistry,
  type LcdClient,
  type LcdRequestOptions,
  type RouteHop,
  type RoutePlan,
} from "./types.js";

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const ICS20 = {
  denom: "usafro",
  amount: "1000000",
  sender: "addr_safro1sender",
  receiver: "osmo1receiver",
  memo: "",
};

/** ns timestamp used by every fixture packet: 2023-11-14T22:13:20Z. */
const TIMEOUT_NS = "1700000000000000000";
const TIMEOUT_MS = 1_700_000_000_000;

const SEND_ATTRS: Record<string, string> = {
  packet_data: JSON.stringify(ICS20),
  packet_timeout_height: "1-1000",
  packet_timeout_timestamp: TIMEOUT_NS,
  packet_sequence: "7",
  packet_src_port: "transfer",
  packet_src_channel: "channel-0",
  packet_dst_port: "transfer",
  packet_dst_channel: "channel-141",
  packet_connection: "connection-3",
};

const TRANSFER_ATTRS: Record<string, string> = {
  sender: ICS20.sender,
  receiver: ICS20.receiver,
  denom: ICS20.denom,
  amount: ICS20.amount,
  memo: "",
};

/** Cosmos SDK ≥ 0.47: attributes in the clear. */
function plainEvent(type: string, attributes: Record<string, string>): unknown {
  return {
    type,
    attributes: Object.entries(attributes).map(([key, value]) => ({ key, value })),
  };
}

/** Cosmos SDK ≤ 0.46: attribute keys and values are base64. */
function encodedEvent(type: string, attributes: Record<string, string>): unknown {
  return {
    type,
    attributes: Object.entries(attributes).map(([key, value]) => ({
      key: encodeBase64Utf8(key),
      value: encodeBase64Utf8(value),
      index: true,
    })),
  };
}

interface TxParts {
  readonly hash: string;
  readonly timestamp?: string;
  readonly events?: readonly unknown[];
  readonly logs?: readonly unknown[];
}

function txResponse(parts: TxParts): Record<string, unknown> {
  return {
    height: "100",
    txhash: parts.hash,
    code: 0,
    raw_log: "",
    timestamp: parts.timestamp ?? "2026-09-06T10:00:00Z",
    logs: parts.logs ?? [],
    events: parts.events ?? [],
  };
}

function envelope(parts: TxParts): unknown {
  return { tx: {}, tx_response: txResponse(parts) };
}

/* -------------------------------------------------------------------------- *
 * LCD stub
 * -------------------------------------------------------------------------- */

interface StubCall {
  readonly path: string;
  readonly query: Record<string, unknown>;
}

interface StubLcd extends LcdClient {
  readonly calls: readonly StubCall[];
}

type Responder = (path: string, query: Record<string, unknown>) => unknown;

function stubLcd(chainId: string, respond: Responder): StubLcd {
  const calls: StubCall[] = [];
  return {
    chainId,
    calls,
    async getJson(path: string, options?: LcdRequestOptions): Promise<unknown> {
      const query = { ...(options?.query ?? {}) } as Record<string, unknown>;
      calls.push({ path, query });
      return respond(path, query);
    },
  };
}

/**
 * Answer tx searches by the event prefix the query filters on, and tx fetches
 * by hash. Anything unmapped answers with no rows, which is what a chain that
 * has not seen the packet looks like.
 */
function chainStub(
  chainId: string,
  config: {
    readonly txs?: Record<string, unknown>;
    readonly searches?: Record<string, readonly unknown[]>;
    readonly fail?: boolean;
  },
): StubLcd {
  return stubLcd(chainId, (path, query) => {
    if (config.fail === true) {
      throw new InterchainError("lcd-unreachable", `${chainId}: down`, { chainId });
    }
    const byHash = path.match(/^\/cosmos\/tx\/v1beta1\/txs\/([^/?]+)$/);
    if (byHash) {
      const body = config.txs?.[byHash[1] ?? ""];
      if (body === undefined) {
        throw new InterchainError("lcd-unreachable", "not found", { chainId, httpStatus: 404 });
      }
      return body;
    }
    if (!path.startsWith("/cosmos/tx/v1beta1/txs")) {
      throw new InterchainError("lcd-unreachable", `unexpected path ${path}`, { chainId });
    }
    const haystack = `${path} ${String(query.query ?? "")}`;
    for (const [prefix, rows] of Object.entries(config.searches ?? {})) {
      if (haystack.includes(prefix)) return { tx_responses: rows };
    }
    return { tx_responses: [] };
  });
}

function resolverOf(chains: Record<string, LcdClient | null>): LcdResolver {
  return (chainId) => chains[chainId] ?? null;
}

/* -------------------------------------------------------------------------- *
 * extractPacketsFromTx
 * -------------------------------------------------------------------------- */

test("extractPacketsFromTx reads the flat plain-attribute shape", () => {
  const packets = extractPacketsFromTx(
    envelope({
      hash: "ABC",
      events: [
        plainEvent("message", { action: "/ibc.applications.transfer.v1.MsgTransfer" }),
        plainEvent("send_packet", SEND_ATTRS),
        plainEvent("ibc_transfer", TRANSFER_ATTRS),
      ],
    }),
  );

  assert.equal(packets.length, 1);
  const packet = packets[0];
  assert.ok(packet);
  assert.equal(packet.sequence, "7");
  assert.equal(packet.sourceChannelId, "channel-0");
  assert.equal(packet.sourcePort, "transfer");
  assert.equal(packet.destChannelId, "channel-141");
  assert.equal(packet.timeoutHeight, "1-1000");
  assert.equal(packet.timeoutTimestamp, TIMEOUT_NS);
  assert.equal(packet.connectionId, "connection-3");
  assert.equal(packet.txHash, "ABC");
  assert.equal(packet.data?.amount, "1000000");
  assert.equal(packet.transfer?.receiver, "osmo1receiver");
});

test("extractPacketsFromTx reads base64 attributes from logs[].events", () => {
  const packets = extractPacketsFromTx(
    envelope({
      hash: "DEF",
      logs: [
        {
          msg_index: 0,
          log: "",
          events: [encodedEvent("send_packet", SEND_ATTRS), encodedEvent("ibc_transfer", TRANSFER_ATTRS)],
        },
      ],
    }),
  );

  assert.equal(packets.length, 1);
  assert.equal(packets[0]?.sequence, "7");
  assert.equal(packets[0]?.sourceChannelId, "channel-0");
  assert.equal(packets[0]?.data?.sender, ICS20.sender);
  assert.equal(packets[0]?.transfer?.amount, "1000000");
});

test("extractPacketsFromTx merges the same packet seen in both shapes", () => {
  // SDK 0.47 answers with logs *and* events describing the same send.
  const packets = extractPacketsFromTx(
    envelope({
      hash: "GHI",
      logs: [{ msg_index: 0, events: [plainEvent("send_packet", SEND_ATTRS)] }],
      events: [encodedEvent("send_packet", SEND_ATTRS)],
    }),
  );
  assert.equal(packets.length, 1);
});

test("extractPacketsFromTx keeps several packets from one transaction", () => {
  const second = { ...SEND_ATTRS, packet_sequence: "8", packet_src_channel: "channel-9" };
  const packets = extractPacketsFromTx(
    txResponse({
      hash: "JKL",
      events: [plainEvent("send_packet", SEND_ATTRS), plainEvent("send_packet", second)],
    }),
  );
  assert.deepEqual(
    packets.map((packet) => `${packet.sourceChannelId}/${packet.sequence}`),
    ["channel-0/7", "channel-9/8"],
  );
});

test("extractPacketsFromTx falls back to packet_data_hex", () => {
  const json = JSON.stringify(ICS20);
  const hex = [...new TextEncoder().encode(json)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const attrs: Record<string, string> = { ...SEND_ATTRS, packet_data_hex: hex };
  delete attrs.packet_data;

  const packets = extractPacketsFromTx(txResponse({ hash: "MNO", events: [plainEvent("send_packet", attrs)] }));
  assert.equal(packets[0]?.data?.receiver, "osmo1receiver");
});

test("extractPacketsFromTx drops packets it could never look up again", () => {
  const noSequence: Record<string, string> = { ...SEND_ATTRS };
  delete noSequence.packet_sequence;
  const noChannel: Record<string, string> = { ...SEND_ATTRS, packet_sequence: "9" };
  delete noChannel.packet_src_channel;

  assert.deepEqual(
    extractPacketsFromTx(
      txResponse({
        hash: "PQR",
        events: [plainEvent("send_packet", noSequence), plainEvent("send_packet", noChannel)],
      }),
    ),
    [],
  );
});

test("extractPacketsFromTx tolerates malformed bodies", () => {
  for (const body of [
    null,
    undefined,
    42,
    "not json",
    [],
    {},
    { tx_response: null },
    { tx_response: { events: "nope", logs: 7 } },
    { tx_response: { events: [null, 3, { type: 5 }, { type: "send_packet" }] } },
    { tx_response: { events: [{ type: "send_packet", attributes: [null, { key: 1 }, {}] }] } },
  ]) {
    assert.deepEqual(extractPacketsFromTx(body), [], `body ${JSON.stringify(body)}`);
  }
});

test("decodeTxEvents decodes encoded attributes under their plain names", () => {
  // The ABCI event *type* has always been a string; only the attributes were
  // ever bytes, so this is what an SDK 0.45 response really looks like.
  const events = decodeTxEvents(
    txResponse({ hash: "STU", events: [encodedEvent("send_packet", SEND_ATTRS)] }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "send_packet");
  assert.equal(events[0]?.attributes.get("packet_sequence"), "7");
  assert.equal(events[0]?.attributes.get("packet_src_channel"), "channel-0");
});

test("decodeTxEvents also tolerates a base64 event type", () => {
  const events = decodeTxEvents(
    txResponse({ hash: "STU2", events: [{ type: encodeBase64Utf8("recv_packet"), attributes: [] }] }),
  );
  assert.equal(events[0]?.type, "recv_packet");
  assert.ok(events[0]?.types.includes(encodeBase64Utf8("recv_packet")));
});

/* -------------------------------------------------------------------------- *
 * Payload parsing
 * -------------------------------------------------------------------------- */

test("parseIcs20PacketData reads v1 and the defensive v2 tokens shape", () => {
  assert.deepEqual(parseIcs20PacketData(JSON.stringify(ICS20)), {
    denom: "usafro",
    amount: "1000000",
    sender: "addr_safro1sender",
    receiver: "osmo1receiver",
    memo: "",
  });

  const v2 = parseIcs20PacketData(
    JSON.stringify({
      tokens: [{ denom: { base: "uatom", trace: [] }, amount: "42" }],
      sender: "cosmos1a",
      receiver: "osmo1b",
      memo: "{}",
    }),
  );
  assert.equal(v2?.denom, "uatom");
  assert.equal(v2?.amount, "42");
});

test("parseIcs20PacketData rejects non-objects", () => {
  assert.equal(parseIcs20PacketData("nope"), null);
  assert.equal(parseIcs20PacketData("[1,2]"), null);
  assert.equal(parseIcs20PacketData(""), null);
});

test("parsePacketAcknowledgement splits result from error", () => {
  assert.deepEqual(parsePacketAcknowledgement('{"result":"AQ=="}'), {
    ok: true,
    error: null,
    result: "AQ==",
  });
  const failed = parsePacketAcknowledgement('{"error":"ABCI code: 1: memo rejected"}');
  assert.equal(failed?.ok, false);
  assert.equal(failed?.error, "ABCI code: 1: memo rejected");
});

test("parsePacketAcknowledgement unwraps a base64-wrapped ack", () => {
  const wrapped = encodeBase64Utf8('{"error":"nope"}');
  assert.equal(parsePacketAcknowledgement(wrapped)?.ok, false);
});

test("parsePacketAcknowledgement returns null for shapes it does not know", () => {
  assert.equal(parsePacketAcknowledgement(""), null);
  assert.equal(parsePacketAcknowledgement("   "), null);
  assert.equal(parsePacketAcknowledgement("{}"), null);
  assert.equal(parsePacketAcknowledgement("[1]"), null);
});

/* -------------------------------------------------------------------------- *
 * Timing
 * -------------------------------------------------------------------------- */

test("estimateHopSeconds and estimateRouteSeconds follow the profile", () => {
  assert.equal(estimateHopSeconds("transfer"), DEFAULT_HOP_TIMING.transferSeconds);
  assert.equal(estimateHopSeconds("forward"), DEFAULT_HOP_TIMING.forwardSeconds);
  assert.equal(estimateHopSeconds("swap"), DEFAULT_HOP_TIMING.swapSeconds);
  assert.equal(estimateHopSeconds("transfer", { transferSeconds: 5 }), 5);
  assert.equal(
    estimateRouteSeconds([{ kind: "transfer" }, { kind: "swap" }, { kind: "forward" }]),
    DEFAULT_HOP_TIMING.transferSeconds +
      DEFAULT_HOP_TIMING.swapSeconds +
      DEFAULT_HOP_TIMING.forwardSeconds,
  );
});

test("hopStallThresholdSeconds never dips below the floor", () => {
  assert.equal(hopStallThresholdSeconds("swap"), DEFAULT_HOP_TIMING.minStalledSeconds);
  assert.equal(
    hopStallThresholdSeconds("transfer", { transferSeconds: 600, stalledFactor: 2 }),
    1200,
  );
});

test("isHopStalled only fires for packets the user is still waiting on", () => {
  const base = { kind: "transfer" as const, elapsedSeconds: 10_000 };
  assert.equal(isHopStalled({ ...base, status: "pending" }), true);
  assert.equal(isHopStalled({ ...base, status: "relayed" }), true);
  assert.equal(isHopStalled({ ...base, status: "unknown" }), true);
  // Funds have landed; a late acknowledgement is not the user's problem.
  assert.equal(isHopStalled({ ...base, status: "received" }), false);
  assert.equal(isHopStalled({ ...base, status: "acknowledged" }), false);
  assert.equal(isHopStalled({ ...base, status: "timeout" }), false);
  assert.equal(isHopStalled({ ...base, status: "pending", elapsedSeconds: null }), false);
  assert.equal(isHopStalled({ ...base, status: "pending", elapsedSeconds: 10 }), false);
  assert.equal(
    isHopStalled({ ...base, status: "pending", elapsedSeconds: 30, stalledAfterSeconds: 20 }),
    true,
  );
});

test("isTerminalPacketStatus names the three end states", () => {
  assert.deepEqual(
    (["pending", "relayed", "received", "acknowledged", "timeout", "failed", "unknown"] as const).filter(
      isTerminalPacketStatus,
    ),
    ["acknowledged", "timeout", "failed"],
  );
});

/* -------------------------------------------------------------------------- *
 * getPacketStatus
 * -------------------------------------------------------------------------- */

const PACKET = {
  sequence: "7",
  sourcePort: "transfer",
  sourceChannelId: "channel-0",
  destPort: "transfer",
  destChannelId: "channel-141",
  timeoutTimestamp: TIMEOUT_NS,
} as const;

const PACKET_EVENT_ATTRS: Record<string, string> = {
  packet_sequence: "7",
  packet_src_port: "transfer",
  packet_src_channel: "channel-0",
  packet_dst_port: "transfer",
  packet_dst_channel: "channel-141",
};

const AFTER_TIMEOUT = TIMEOUT_MS + 60_000;
const BEFORE_TIMEOUT = TIMEOUT_MS - 60_000;

test("getPacketStatus reports acknowledged when the source processed the ack", async () => {
  const source = chainStub("safrochain-1", {
    searches: {
      "acknowledge_packet.": [
        txResponse({
          hash: "ACKTX",
          timestamp: "2026-09-06T10:01:00Z",
          events: [plainEvent("acknowledge_packet", PACKET_EVENT_ATTRS)],
        }),
      ],
    },
  });
  const destination = chainStub("osmosis-1", {
    searches: {
      "write_acknowledgement.": [
        txResponse({
          hash: "RECVTX",
          timestamp: "2026-09-06T10:00:30Z",
          events: [
            plainEvent("write_acknowledgement", {
              ...PACKET_EVENT_ATTRS,
              packet_ack: '{"result":"AQ=="}',
            }),
          ],
        }),
      ],
    },
  });

  const report = await getPacketStatus(PACKET, { source, destination }, { now: () => AFTER_TIMEOUT });
  assert.equal(report.status, "acknowledged");
  assert.equal(report.failure, null);
  assert.equal(report.ackTxHash, "ACKTX");
  assert.equal(report.receiveTxHash, "RECVTX");
  assert.equal(report.receivedAt, "2026-09-06T10:00:30Z");
  assert.equal(report.completedAt, "2026-09-06T10:01:00Z");
  assert.equal(report.fundsRefunded, false);
});

test("getPacketStatus reports an error acknowledgement as a refund", async () => {
  const source = chainStub("safrochain-1", {
    searches: {
      "acknowledge_packet.": [
        txResponse({ hash: "ACKTX", events: [plainEvent("acknowledge_packet", PACKET_EVENT_ATTRS)] }),
      ],
    },
  });
  const destination = chainStub("osmosis-1", {
    searches: {
      "write_acknowledgement.": [
        txResponse({
          hash: "RECVTX",
          events: [
            plainEvent("write_acknowledgement", {
              ...PACKET_EVENT_ATTRS,
              packet_ack: '{"error":"ABCI code: 1: memo rejected"}',
            }),
          ],
        }),
      ],
    },
  });

  const report = await getPacketStatus(PACKET, { source, destination }, { now: () => AFTER_TIMEOUT });
  assert.equal(report.status, "failed");
  assert.equal(report.failure, "ack-error");
  assert.equal(report.fundsRefunded, true);
  assert.equal(report.error, "ABCI code: 1: memo rejected");
});

test("getPacketStatus reads an error off the source fungible_token_packet event", async () => {
  // No destination endpoint: the source chain's transfer module is all we have.
  const source = chainStub("safrochain-1", {
    searches: {
      "acknowledge_packet.": [
        txResponse({
          hash: "ACKTX",
          events: [
            plainEvent("acknowledge_packet", PACKET_EVENT_ATTRS),
            plainEvent("fungible_token_packet", { module: "transfer", error: "receiver rejected" }),
          ],
        }),
      ],
    },
  });

  const report = await getPacketStatus(PACKET, { source }, { now: () => AFTER_TIMEOUT });
  assert.equal(report.status, "failed");
  assert.equal(report.error, "receiver rejected");
  assert.equal(report.receiveTxHash, null);
});

test("getPacketStatus reports a timeout as refunded", async () => {
  const source = chainStub("safrochain-1", {
    searches: {
      "timeout_packet.": [
        txResponse({
          hash: "TIMEOUTTX",
          timestamp: "2026-09-06T10:20:00Z",
          events: [plainEvent("timeout_packet", PACKET_EVENT_ATTRS)],
        }),
      ],
    },
  });

  const report = await getPacketStatus(PACKET, { source }, { now: () => AFTER_TIMEOUT });
  assert.equal(report.status, "timeout");
  assert.equal(report.failure, "timeout");
  assert.equal(report.fundsRefunded, true);
  assert.equal(report.timeoutTxHash, "TIMEOUTTX");
  assert.equal(report.completedAt, "2026-09-06T10:20:00Z");
});

test("getPacketStatus does not search for a timeout that cannot have fired yet", async () => {
  const source = chainStub("safrochain-1", {});
  const report = await getPacketStatus(PACKET, { source }, { now: () => BEFORE_TIMEOUT });
  assert.equal(report.status, "pending");
  const searched = source.calls.map((call) => `${call.path} ${String(call.query.query ?? "")}`);
  assert.equal(searched.length, 1);
  assert.ok(searched[0]?.includes("acknowledge_packet."));
});

test("getPacketStatus reports relayed when only recv_packet is indexed", async () => {
  const source = chainStub("safrochain-1", {});
  const destination = chainStub("osmosis-1", {
    searches: {
      "recv_packet.": [
        txResponse({ hash: "RECVTX", events: [plainEvent("recv_packet", PACKET_EVENT_ATTRS)] }),
      ],
    },
  });

  const report = await getPacketStatus(PACKET, { source, destination }, { now: () => BEFORE_TIMEOUT });
  assert.equal(report.status, "relayed");
  assert.equal(report.receiveTxHash, "RECVTX");
});

test("getPacketStatus reports pending when both chains answer with nothing", async () => {
  const report = await getPacketStatus(
    PACKET,
    { source: chainStub("safrochain-1", {}), destination: chainStub("osmosis-1", {}) },
    { now: () => AFTER_TIMEOUT },
  );
  assert.equal(report.status, "pending");
  assert.deepEqual(report.notes, []);
});

test("getPacketStatus reports unknown when no endpoint can answer", async () => {
  const report = await getPacketStatus(
    PACKET,
    { source: chainStub("safrochain-1", { fail: true }), destination: chainStub("osmosis-1", { fail: true }) },
    { now: () => AFTER_TIMEOUT },
  );
  assert.equal(report.status, "unknown");
  assert.ok(report.notes.length > 0);
});

test("getPacketStatus falls back to the legacy events= search", async () => {
  const source = stubLcd("safrochain-1", (path, query) => {
    if (typeof query.query === "string") {
      throw new InterchainError("lcd-unreachable", "query unsupported", { httpStatus: 501 });
    }
    if (path.includes("events=") && path.includes("acknowledge_packet.")) {
      return {
        tx_responses: [
          txResponse({ hash: "ACKTX", events: [plainEvent("acknowledge_packet", PACKET_EVENT_ATTRS)] }),
        ],
      };
    }
    return { tx_responses: [] };
  });

  const report = await getPacketStatus(PACKET, { source }, { now: () => AFTER_TIMEOUT });
  assert.equal(report.status, "acknowledged");
  assert.equal(report.ackTxHash, "ACKTX");
});

test("getPacketStatus ignores a returned transaction that is not our packet", async () => {
  // Loose indexers match attributes across events, so a relayer batch can come
  // back holding somebody else's sequence.
  const source = chainStub("safrochain-1", {
    searches: {
      "acknowledge_packet.": [
        txResponse({
          hash: "OTHER",
          events: [plainEvent("acknowledge_packet", { ...PACKET_EVENT_ATTRS, packet_sequence: "999" })],
        }),
      ],
    },
  });
  const report = await getPacketStatus(PACKET, { source }, { now: () => BEFORE_TIMEOUT });
  assert.equal(report.status, "pending");
});

test("getPacketStatus returns the packets the receiving transaction forwarded", async () => {
  const forwarded: Record<string, string> = {
    ...SEND_ATTRS,
    packet_sequence: "3",
    packet_src_channel: "channel-42",
    packet_dst_channel: "channel-7",
  };
  const destination = chainStub("osmosis-1", {
    searches: {
      "write_acknowledgement.": [
        txResponse({
          hash: "RECVTX",
          events: [
            plainEvent("write_acknowledgement", { ...PACKET_EVENT_ATTRS, packet_ack: '{"result":"AQ=="}' }),
            plainEvent("send_packet", forwarded),
          ],
        }),
      ],
    },
  });

  const report = await getPacketStatus(
    PACKET,
    { source: chainStub("safrochain-1", {}), destination },
    { now: () => BEFORE_TIMEOUT },
  );
  assert.equal(report.status, "received");
  assert.equal(report.onwardPackets.length, 1);
  assert.equal(report.onwardPackets[0]?.sourceChannelId, "channel-42");
});

test("getPacketStatus can skip the destination probes", async () => {
  const destination = chainStub("osmosis-1", {});
  await getPacketStatus(
    PACKET,
    { source: chainStub("safrochain-1", {}), destination },
    { probeDestination: false, now: () => BEFORE_TIMEOUT },
  );
  assert.equal(destination.calls.length, 0);
});

test("getPacketStatus refuses to build a query it cannot escape", async () => {
  await assert.rejects(
    getPacketStatus({ ...PACKET, sequence: "7' OR '1'='1" }, { source: chainStub("a", {}) }),
    (error: unknown) => isInterchainError(error) && error.code === "malformed-response",
  );
});

test("getPacketStatus never swallows abort or reads-disabled", async () => {
  for (const code of ["aborted", "reads-disabled"] as const) {
    const source = stubLcd("safrochain-1", () => {
      throw new InterchainError(code, "stop");
    });
    await assert.rejects(
      getPacketStatus(PACKET, { source }),
      (error: unknown) => isInterchainError(error) && error.code === code,
    );
  }
});

/* -------------------------------------------------------------------------- *
 * Crosschain-swap recovery
 * -------------------------------------------------------------------------- */

test("buildXcsRecoverMsg produces an unsigned MsgExecuteContract", () => {
  const msg = buildXcsRecoverMsg({
    contractAddress: "osmo1contract",
    recoveryAddress: "osmo1recovery",
  });
  assert.equal(msg.typeUrl, "/cosmwasm.wasm.v1.MsgExecuteContract");
  assert.equal(msg.value.sender, "osmo1recovery");
  assert.equal(msg.value.contract, "osmo1contract");
  assert.deepEqual(msg.value.funds, []);
  assert.equal(decodeBase64Utf8(String(msg.value.msg)), '{"recover":{}}');
  assert.equal(msg.value.msg, jsonToBase64({ recover: {} }));
});

test("buildXcsRecoverMsg refuses to build without both addresses", () => {
  for (const args of [
    { contractAddress: "", recoveryAddress: "osmo1recovery" },
    { contractAddress: "osmo1contract", recoveryAddress: "  " },
  ]) {
    assert.throws(
      () => buildXcsRecoverMsg(args),
      (error: unknown) => isInterchainError(error) && error.code === "invalid-request",
    );
  }
});

/* -------------------------------------------------------------------------- *
 * createLcdResolver
 * -------------------------------------------------------------------------- */

test("createLcdResolver returns null for unknown chains and chains without REST", () => {
  const withRest: ChainInfoLike = {
    chainId: "safrochain-1",
    chainName: "Safrochain",
    bech32Prefix: "addr_safro",
    coinType: 118,
    coinDenom: "SAFRO",
    coinMinimalDenom: "usafro",
    coinDecimals: 6,
    feeDenom: "SAFRO",
    feeMinimalDenom: "usafro",
    feeDecimals: 6,
    rest: "https://api.safrochain.example",
  };
  const withoutRest: ChainInfoLike = { ...withRest, chainId: "dry-1", rest: "" };
  const registry: ChainRegistry = {
    get: (chainId) => [withRest, withoutRest].find((chain) => chain.chainId === chainId),
    list: () => [withRest, withoutRest],
    byPrefix: (prefix) => [withRest, withoutRest].filter((chain) => chain.bech32Prefix === prefix),
  };

  const resolve = createLcdResolver(registry, (chain) => stubLcd(chain.chainId, () => ({})));
  assert.equal(resolve("safrochain-1")?.chainId, "safrochain-1");
  assert.equal(resolve("dry-1"), null);
  assert.equal(resolve("nope-1"), null);
});

/* -------------------------------------------------------------------------- *
 * trackRoute
 * -------------------------------------------------------------------------- */

function hop(overrides: Partial<RouteHop> & Pick<RouteHop, "chainId">): RouteHop {
  return {
    channelId: "channel-0",
    port: "transfer",
    counterpartyChainId: null,
    kind: "transfer",
    ...overrides,
  };
}

function planOf(hops: readonly RouteHop[]): RoutePlan {
  return {
    sourceChainId: hops[0]?.chainId ?? "safrochain-1",
    destChainId: hops[hops.length - 1]?.counterpartyChainId ?? "osmosis-1",
    inputDenom: "usafro",
    outputDenom: "usafro",
    hops,
    memo: "",
    warnings: [],
    estimatedDurationSeconds: 60,
    requiresPfm: false,
    requiresIbcHooks: false,
  };
}

const SOURCE_TX = envelope({
  hash: "SOURCEHASH",
  timestamp: "2026-09-06T10:00:00Z",
  events: [plainEvent("send_packet", SEND_ATTRS), plainEvent("ibc_transfer", TRANSFER_ATTRS)],
});

test("trackRoute refuses a plan with no hops", async () => {
  await assert.rejects(
    trackRoute(planOf([]), "SOURCEHASH", resolverOf({})),
    (error: unknown) => isInterchainError(error) && error.code === "no-route",
  );
});

test("trackRoute refuses a source chain it cannot read", async () => {
  await assert.rejects(
    trackRoute(planOf([hop({ chainId: "safrochain-1" })]), "SOURCEHASH", resolverOf({})),
    (error: unknown) => isInterchainError(error) && error.code === "unsupported-chain",
  );
});

test("trackRoute reports pending while the source transaction is unindexed", async () => {
  const updates: RouteTrace[] = [];
  const trace = await trackRoute(
    planOf([hop({ chainId: "safrochain-1", counterpartyChainId: "osmosis-1" })]),
    "0xsourcehash",
    resolverOf({ "safrochain-1": chainStub("safrochain-1", {}) }),
    { onUpdate: (value) => updates.push(value), now: () => AFTER_TIMEOUT },
  );

  assert.equal(trace.status, "pending");
  assert.equal(trace.sourceTxHash, "SOURCEHASH");
  assert.equal(trace.hops.length, 1);
  assert.equal(trace.hops[0]?.sequence, null);
  assert.ok(trace.notes.some((note) => note.includes("not indexed")));
  assert.equal(updates.length, 1);
});

test("trackRoute walks a single hop to acknowledged", async () => {
  const source = chainStub("safrochain-1", {
    txs: { SOURCEHASH: SOURCE_TX },
    searches: {
      "acknowledge_packet.": [
        txResponse({
          hash: "ACKTX",
          timestamp: "2026-09-06T10:01:00Z",
          events: [plainEvent("acknowledge_packet", PACKET_EVENT_ATTRS)],
        }),
      ],
    },
  });
  const destination = chainStub("osmosis-1", {
    searches: {
      "write_acknowledgement.": [
        txResponse({
          hash: "RECVTX",
          timestamp: "2026-09-06T10:00:40Z",
          events: [
            plainEvent("write_acknowledgement", { ...PACKET_EVENT_ATTRS, packet_ack: '{"result":"AQ=="}' }),
          ],
        }),
      ],
    },
  });

  const updates: RouteTrace[] = [];
  const trace = await trackRoute(
    planOf([hop({ chainId: "safrochain-1", counterpartyChainId: "osmosis-1" })]),
    "SOURCEHASH",
    resolverOf({ "safrochain-1": source, "osmosis-1": destination }),
    {
      now: () => AFTER_TIMEOUT,
      onUpdate: (value) => {
        updates.push(value);
        throw new Error("a broken renderer must not break tracking");
      },
    },
  );

  assert.equal(trace.status, "acknowledged");
  assert.equal(trace.failure, null);
  assert.equal(trace.stalled, false);
  assert.equal(trace.currentHopIndex, 0);
  const first = trace.hops[0];
  assert.equal(first?.status, "acknowledged");
  assert.equal(first?.sequence, "7");
  assert.equal(first?.sendTxHash, "SOURCEHASH");
  assert.equal(first?.receiveTxHash, "RECVTX");
  assert.equal(first?.ackTxHash, "ACKTX");
  assert.equal(first?.startedAt, "2026-09-06T10:00:00Z");
  assert.equal(first?.completedAt, "2026-09-06T10:01:00Z");
  assert.equal(first?.elapsedSeconds, 60);
  assert.equal(first?.expectedSeconds, DEFAULT_HOP_TIMING.transferSeconds);
  assert.ok(updates.length >= 1);
});

test("trackRoute chains a packet-forward hop from the receiving transaction", async () => {
  const forwarded: Record<string, string> = {
    packet_data: JSON.stringify({ ...ICS20, denom: "transfer/channel-141/usafro" }),
    packet_timeout_timestamp: TIMEOUT_NS,
    packet_sequence: "3",
    packet_src_port: "transfer",
    packet_src_channel: "channel-9",
    packet_dst_port: "transfer",
    packet_dst_channel: "channel-2",
  };

  const source = chainStub("safrochain-1", {
    txs: { SOURCEHASH: SOURCE_TX },
    searches: {
      "acknowledge_packet.": [
        txResponse({ hash: "ACKTX", events: [plainEvent("acknowledge_packet", PACKET_EVENT_ATTRS)] }),
      ],
    },
  });
  const middle = chainStub("osmosis-1", {
    searches: {
      "write_acknowledgement.": [
        txResponse({
          hash: "RECVTX",
          timestamp: "2026-09-06T10:00:40Z",
          events: [
            plainEvent("write_acknowledgement", { ...PACKET_EVENT_ATTRS, packet_ack: '{"result":"AQ=="}' }),
            plainEvent("send_packet", forwarded),
          ],
        }),
      ],
    },
  });
  const last = chainStub("juno-1", {});

  const trace = await trackRoute(
    planOf([
      hop({ chainId: "safrochain-1", counterpartyChainId: "osmosis-1" }),
      hop({ chainId: "osmosis-1", channelId: "channel-9", counterpartyChainId: "juno-1", kind: "forward" }),
    ]),
    "SOURCEHASH",
    resolverOf({ "safrochain-1": source, "osmosis-1": middle, "juno-1": last }),
    { now: () => AFTER_TIMEOUT },
  );

  assert.equal(trace.hops.length, 2);
  assert.equal(trace.hops[0]?.status, "acknowledged");
  assert.equal(trace.hops[1]?.status, "pending");
  assert.equal(trace.hops[1]?.sequence, "3");
  assert.equal(trace.hops[1]?.sendTxHash, "RECVTX");
  assert.equal(trace.hops[1]?.startedAt, "2026-09-06T10:00:40Z");
  // The aggregate is the hop the user is waiting on, not the finished one.
  assert.equal(trace.status, "pending");
  assert.equal(trace.currentHopIndex, 1);
});

test("trackRoute leaves the second hop pending when nothing was forwarded yet", async () => {
  const source = chainStub("safrochain-1", {
    txs: { SOURCEHASH: SOURCE_TX },
    searches: {
      "acknowledge_packet.": [
        txResponse({ hash: "ACKTX", events: [plainEvent("acknowledge_packet", PACKET_EVENT_ATTRS)] }),
      ],
    },
  });
  const middle = chainStub("osmosis-1", {});

  const trace = await trackRoute(
    planOf([
      hop({ chainId: "safrochain-1", counterpartyChainId: "osmosis-1" }),
      hop({ chainId: "osmosis-1", channelId: "channel-9", counterpartyChainId: "juno-1", kind: "forward" }),
    ]),
    "SOURCEHASH",
    resolverOf({ "safrochain-1": source, "osmosis-1": middle }),
    { now: () => AFTER_TIMEOUT },
  );

  assert.equal(trace.hops[0]?.status, "acknowledged");
  assert.equal(trace.hops[1]?.status, "pending");
  assert.equal(trace.hops[1]?.sequence, null);
  assert.equal(trace.status, "pending");
});

test("trackRoute flags a stalled hop without calling it a failure", async () => {
  const source = chainStub("safrochain-1", { txs: { SOURCEHASH: SOURCE_TX } });
  const trace = await trackRoute(
    planOf([hop({ chainId: "safrochain-1", counterpartyChainId: "osmosis-1" })]),
    "SOURCEHASH",
    resolverOf({ "safrochain-1": source, "osmosis-1": chainStub("osmosis-1", {}) }),
    { now: () => Date.parse("2026-09-06T12:00:00Z"), stalledAfterSeconds: 120 },
  );

  assert.equal(trace.status, "pending");
  assert.equal(trace.stalled, true);
  assert.equal(trace.failure, "stalled");
  assert.equal(trace.hops[0]?.stalled, true);
  assert.equal(trace.hops[0]?.fundsRefunded, false);
});

test("trackRoute reports a timeout on the first hop as a refund", async () => {
  const source = chainStub("safrochain-1", {
    txs: { SOURCEHASH: SOURCE_TX },
    searches: {
      "timeout_packet.": [
        txResponse({
          hash: "TIMEOUTTX",
          timestamp: "2026-09-06T10:30:00Z",
          events: [plainEvent("timeout_packet", PACKET_EVENT_ATTRS)],
        }),
      ],
    },
  });

  const trace = await trackRoute(
    planOf([
      hop({ chainId: "safrochain-1", counterpartyChainId: "osmosis-1" }),
      hop({ chainId: "osmosis-1", channelId: "channel-9", counterpartyChainId: "juno-1", kind: "forward" }),
    ]),
    "SOURCEHASH",
    resolverOf({ "safrochain-1": source, "osmosis-1": chainStub("osmosis-1", {}) }),
    { now: () => AFTER_TIMEOUT },
  );

  assert.equal(trace.status, "timeout");
  assert.equal(trace.failure, "timeout");
  assert.equal(trace.recovery, null);
  assert.equal(trace.hops[0]?.fundsRefunded, true);
  // The hop that will now never happen is not promised to the user as pending.
  assert.equal(trace.hops[1]?.status, "unknown");
});

test("trackRoute recognises swap output stuck in the crosschain-swaps contract", async () => {
  const outbound: Record<string, string> = {
    packet_data: JSON.stringify({ ...ICS20, denom: "uosmo", receiver: "juno1receiver" }),
    packet_timeout_timestamp: TIMEOUT_NS,
    packet_sequence: "3",
    packet_src_port: "transfer",
    packet_src_channel: "channel-42",
    packet_dst_port: "transfer",
    packet_dst_channel: "channel-2",
  };
  const outboundEventAttrs: Record<string, string> = {
    packet_sequence: "3",
    packet_src_port: "transfer",
    packet_src_channel: "channel-42",
    packet_dst_port: "transfer",
    packet_dst_channel: "channel-2",
  };

  const source = chainStub("safrochain-1", {
    txs: { SOURCEHASH: SOURCE_TX },
    searches: {
      "acknowledge_packet.": [
        txResponse({ hash: "ACKTX", events: [plainEvent("acknowledge_packet", PACKET_EVENT_ATTRS)] }),
      ],
    },
  });
  const osmosis = chainStub("osmosis-1", {
    searches: {
      "write_acknowledgement.": [
        txResponse({
          hash: "SWAPTX",
          timestamp: "2026-09-06T10:00:40Z",
          events: [
            plainEvent("write_acknowledgement", { ...PACKET_EVENT_ATTRS, packet_ack: '{"result":"AQ=="}' }),
            plainEvent("send_packet", outbound),
          ],
        }),
      ],
      "timeout_packet.": [
        txResponse({ hash: "OUTTIMEOUT", events: [plainEvent("timeout_packet", outboundEventAttrs)] }),
      ],
    },
  });

  const trace = await trackRoute(
    planOf([
      hop({ chainId: "safrochain-1", counterpartyChainId: "osmosis-1" }),
      hop({ chainId: "osmosis-1", channelId: "", counterpartyChainId: null, kind: "swap" }),
      hop({ chainId: "osmosis-1", channelId: "channel-42", counterpartyChainId: "juno-1" }),
    ]),
    "SOURCEHASH",
    resolverOf({
      "safrochain-1": source,
      "osmosis-1": osmosis,
      "juno-1": chainStub("juno-1", {}),
    }),
    {
      now: () => AFTER_TIMEOUT,
      swapContract: "osmo1xcs",
      recoveryAddress: "osmo1recovery",
    },
  );

  assert.equal(trace.hops[0]?.status, "acknowledged");
  // The swap hop moves no packet of its own; it mirrors the delivery that ran it.
  assert.equal(trace.hops[1]?.status, "received");
  assert.equal(trace.hops[2]?.sequence, "3");
  assert.equal(trace.hops[2]?.status, "timeout");
  assert.equal(trace.status, "timeout");
  assert.equal(trace.failure, "swap-delivery-failed");
  assert.equal(trace.recovery?.chainId, "osmosis-1");
  assert.equal(trace.recovery?.recoveryAddress, "osmo1recovery");
  assert.equal(decodeBase64Utf8(String(trace.recovery?.msg?.value.msg)), '{"recover":{}}');
});

test("trackRoute says so when stuck swap output has no recovery address", async () => {
  const outbound: Record<string, string> = {
    packet_data: JSON.stringify(ICS20),
    packet_sequence: "3",
    packet_src_port: "transfer",
    packet_src_channel: "channel-42",
    packet_dst_channel: "channel-2",
  };
  const source = chainStub("safrochain-1", {
    txs: { SOURCEHASH: SOURCE_TX },
    searches: {
      "acknowledge_packet.": [
        txResponse({ hash: "ACKTX", events: [plainEvent("acknowledge_packet", PACKET_EVENT_ATTRS)] }),
      ],
    },
  });
  const osmosis = chainStub("osmosis-1", {
    searches: {
      "write_acknowledgement.": [
        txResponse({
          hash: "SWAPTX",
          events: [
            plainEvent("write_acknowledgement", { ...PACKET_EVENT_ATTRS, packet_ack: '{"result":"AQ=="}' }),
            plainEvent("send_packet", outbound),
          ],
        }),
      ],
      "timeout_packet.": [
        txResponse({
          hash: "OUTTIMEOUT",
          events: [
            plainEvent("timeout_packet", {
              packet_sequence: "3",
              packet_src_channel: "channel-42",
              packet_dst_channel: "channel-2",
            }),
          ],
        }),
      ],
    },
  });

  const trace = await trackRoute(
    planOf([
      hop({ chainId: "safrochain-1", counterpartyChainId: "osmosis-1" }),
      hop({ chainId: "osmosis-1", channelId: "", counterpartyChainId: null, kind: "swap" }),
      hop({ chainId: "osmosis-1", channelId: "channel-42", counterpartyChainId: "juno-1" }),
    ]),
    "SOURCEHASH",
    resolverOf({ "safrochain-1": source, "osmosis-1": osmosis, "juno-1": chainStub("juno-1", {}) }),
    { now: () => AFTER_TIMEOUT },
  );

  assert.equal(trace.failure, "swap-delivery-failed");
  assert.equal(trace.recovery?.msg, null);
  assert.ok(trace.notes.some((note) => note.includes("no recovery address")));
});

test("trackRoute notes a chain it cannot read and keeps going", async () => {
  const source = chainStub("safrochain-1", {
    txs: { SOURCEHASH: SOURCE_TX },
    searches: {
      "acknowledge_packet.": [
        txResponse({ hash: "ACKTX", events: [plainEvent("acknowledge_packet", PACKET_EVENT_ATTRS)] }),
      ],
    },
  });

  const trace = await trackRoute(
    planOf([hop({ chainId: "safrochain-1", counterpartyChainId: "osmosis-1" })]),
    "SOURCEHASH",
    resolverOf({ "safrochain-1": source }),
    { now: () => AFTER_TIMEOUT },
  );

  assert.equal(trace.status, "acknowledged");
  assert.ok(trace.notes.some((note) => note.includes("no REST endpoint")));
});

test("trackRoute follows the packet the caller names when a transaction sent several", async () => {
  const other = { ...SEND_ATTRS, packet_sequence: "8" };
  const tx = envelope({
    hash: "SOURCEHASH",
    events: [plainEvent("send_packet", SEND_ATTRS), plainEvent("send_packet", other)],
  });
  const source = chainStub("safrochain-1", { txs: { SOURCEHASH: tx } });

  const trace = await trackRoute(
    planOf([hop({ chainId: "safrochain-1", counterpartyChainId: "osmosis-1" })]),
    "SOURCEHASH",
    resolverOf({ "safrochain-1": source, "osmosis-1": chainStub("osmosis-1", {}) }),
    { sourcePacketSequence: "8", now: () => AFTER_TIMEOUT },
  );
  assert.equal(trace.hops[0]?.sequence, "8");
});

test("trackRoute reports no packet rather than guessing", async () => {
  const source = chainStub("safrochain-1", {
    txs: { SOURCEHASH: envelope({ hash: "SOURCEHASH", events: [plainEvent("message", { action: "send" })] }) },
  });

  const trace = await trackRoute(
    planOf([hop({ chainId: "safrochain-1", counterpartyChainId: "osmosis-1" })]),
    "SOURCEHASH",
    resolverOf({ "safrochain-1": source }),
    { now: () => AFTER_TIMEOUT },
  );
  assert.equal(trace.status, "pending");
  assert.ok(trace.notes.some((note) => note.includes("no IBC packet")));
});

test("trackRoute aborts when the caller cancels", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    trackRoute(
      planOf([hop({ chainId: "safrochain-1", counterpartyChainId: "osmosis-1" })]),
      "SOURCEHASH",
      resolverOf({ "safrochain-1": chainStub("safrochain-1", { txs: { SOURCEHASH: SOURCE_TX } }) }),
      { signal: controller.signal },
    ),
    (error: unknown) => isInterchainError(error) && error.code === "aborted",
  );
});
