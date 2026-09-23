import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPlanTransferMsg,
  buildTransferMsg,
  DEFAULT_TRANSFER_TIMEOUT_MINUTES,
  MSG_TRANSFER_TYPE_URL,
} from "./transfer.js";
import { isInterchainError, type RoutePlan } from "./types.js";

const NOW = 1_700_000_000_000;
const now = () => NOW;
const SENDER = "addr_safro1jrkmdcwgq94uaamx6zax2luewlhf7u4kuv3x2p";

function plan(overrides: Partial<RoutePlan> = {}): RoutePlan {
  return {
    sourceChainId: "safrochain-1",
    destChainId: "osmosis-1",
    inputDenom: "usafro",
    outputDenom: "ibc/ABC",
    hops: [
      {
        chainId: "safrochain-1",
        channelId: "channel-7",
        port: "transfer",
        counterpartyChainId: "osmosis-1",
        kind: "transfer",
      },
    ],
    memo: "",
    warnings: [],
    estimatedDurationSeconds: 60,
    requiresPfm: false,
    requiresIbcHooks: false,
    ...overrides,
  };
}

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return isInterchainError(error) ? error.code : "not-interchain";
  }
  return undefined;
}

test("buildTransferMsg writes the proto-JSON field names the kernel parses", () => {
  const msg = buildTransferMsg(
    {
      sourceChannel: "channel-7",
      token: { denom: "usafro", amount: "1000000" },
      sender: SENDER,
      receiver: "osmo1receiver",
    },
    { now },
  );
  assert.equal(msg.typeUrl, MSG_TRANSFER_TYPE_URL);
  assert.deepEqual(msg.value, {
    source_port: "transfer",
    source_channel: "channel-7",
    token: { denom: "usafro", amount: "1000000" },
    sender: SENDER,
    receiver: "osmo1receiver",
    timeout_height: { revision_number: "0", revision_height: "0" },
    timeout_timestamp: (
      BigInt(NOW + DEFAULT_TRANSFER_TIMEOUT_MINUTES * 60_000) * 1_000_000n
    ).toString(),
    memo: "",
  });
});

test("buildTransferMsg keeps a custom port, memo and timeout", () => {
  const msg = buildTransferMsg(
    {
      sourcePort: "wasm.osmo1contract",
      sourceChannel: "channel-2",
      token: { denom: "uosmo", amount: "5" },
      sender: "osmo1sender",
      receiver: "juno1receiver",
      memo: '{"forward":{}}',
      timeoutMinutes: 1,
    },
    { now },
  );
  assert.equal(msg.value.source_port, "wasm.osmo1contract");
  assert.equal(msg.value.memo, '{"forward":{}}');
  assert.equal(msg.value.timeout_timestamp, (BigInt(NOW + 60_000) * 1_000_000n).toString());
});

test("buildTransferMsg refuses input that cannot describe a real transfer", () => {
  const base = {
    sourceChannel: "channel-7",
    token: { denom: "usafro", amount: "1" },
    sender: SENDER,
    receiver: "osmo1receiver",
  };
  assert.equal(code(() => buildTransferMsg({ ...base, sourceChannel: "" })), "invalid-request");
  assert.equal(code(() => buildTransferMsg({ ...base, sourcePort: "a b" })), "invalid-request");
  assert.equal(
    code(() => buildTransferMsg({ ...base, token: { denom: "", amount: "1" } })),
    "invalid-request",
  );
  for (const amount of ["0", "-1", "1.5", "", "1e6"]) {
    assert.equal(
      code(() => buildTransferMsg({ ...base, token: { denom: "usafro", amount } })),
      "invalid-request",
      amount,
    );
  }
  assert.equal(code(() => buildTransferMsg({ ...base, sender: "" })), "invalid-request");
  assert.equal(code(() => buildTransferMsg({ ...base, receiver: "" })), "invalid-request");
  assert.equal(code(() => buildTransferMsg({ ...base, timeoutMinutes: 0 })), "invalid-request");
  assert.equal(
    code(() => buildTransferMsg({ ...base, memo: "x".repeat(11) }, { maxMemoBytes: 10 })),
    "invalid-memo",
  );
});

test("buildPlanTransferMsg takes the first hop, the plan's denom and memo, and the receiver", () => {
  const msg = buildPlanTransferMsg(
    {
      plan: plan({ memo: '{"wasm":{}}' }),
      receiver: "osmo1contract",
      sender: SENDER,
      amount: "42",
    },
    { now },
  );
  assert.equal(msg.value.source_channel, "channel-7");
  assert.deepEqual(msg.value.token, { denom: "usafro", amount: "42" });
  assert.equal(msg.value.receiver, "osmo1contract");
  assert.equal(msg.value.memo, '{"wasm":{}}');
});

test("buildPlanTransferMsg refuses a plan that signs no packet", () => {
  const swapFirst = plan({
    hops: [
      {
        chainId: "osmosis-1",
        channelId: "",
        port: "transfer",
        counterpartyChainId: "osmosis-1",
        kind: "swap",
      },
    ],
  });
  assert.equal(
    code(() =>
      buildPlanTransferMsg({ plan: swapFirst, receiver: "osmo1x", sender: SENDER, amount: "1" }),
    ),
    "invalid-request",
  );
  assert.equal(
    code(() =>
      buildPlanTransferMsg({
        plan: plan({ hops: [] }),
        receiver: "osmo1x",
        sender: SENDER,
        amount: "1",
      }),
    ),
    "invalid-request",
  );
});
