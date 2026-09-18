import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildForwardMemo,
  buildForwardMemoJson,
  buildWasmHookMemo,
  buildWasmHookMemoJson,
  buildXcsSwapMemo,
  checkMemoBytes,
  isWasmHookReceiverValid,
  memoByteLength,
  TX_MEMO_MAX_BYTES,
  validateMemo,
  wasmHookReceiver,
  type ForwardHop,
  type XcsSwapParams,
} from "./memo.js";
import { isInterchainError, type JsonObject } from "./types.js";

/**
 * Every builder rejection is the same shape, so assert it in one place: an
 * InterchainError with code `invalid-memo`, optionally naming the field.
 */
function rejects(fn: () => unknown, match?: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(isInterchainError(error), `expected InterchainError, got ${String(error)}`);
    assert.equal(error.code, "invalid-memo", error.message);
    if (match !== undefined) assert.match(error.message, match);
    return true;
  });
}

/* -------------------------------------------------------------------------- *
 * buildForwardMemo — exact bytes
 * -------------------------------------------------------------------------- */

test("one-hop forward memo matches the PFM shape byte for byte", () => {
  assert.equal(
    buildForwardMemo([{ channelId: "channel-42" }], "osmo1receiver"),
    '{"forward":{"receiver":"osmo1receiver","port":"transfer","channel":"channel-42","timeout":"10m","retries":2}}',
  );
});

test("two-hop forward memo reproduces the middleware README example", () => {
  // Lifted from INTERCHAIN-SPEC.md section 1, minified. Key order included:
  // a diff against upstream should be empty.
  assert.equal(
    buildForwardMemo(
      [{ channelId: "channel-123" }, { channelId: "channel-234" }],
      "chain-d-bech32-address",
    ),
    '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-123","timeout":"10m",' +
      '"retries":2,"next":{"forward":{"receiver":"chain-d-bech32-address","port":"transfer",' +
      '"channel":"channel-234","timeout":"10m","retries":2}}}}',
  );
});

test("three-hop forward memo nests three levels and names the receiver once", () => {
  const memo = buildForwardMemo(
    [{ channelId: "channel-0" }, { channelId: "channel-1" }, { channelId: "channel-2" }],
    "juno1abc",
  );
  assert.equal(
    memo,
    '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-0","timeout":"10m",' +
      '"retries":2,"next":{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-1",' +
      '"timeout":"10m","retries":2,"next":{"forward":{"receiver":"juno1abc","port":"transfer",' +
      '"channel":"channel-2","timeout":"10m","retries":2}}}}}}',
  );
  // The real address appears exactly once, on the last hop only.
  assert.equal(memo.split("juno1abc").length - 1, 1);
  assert.equal(memo.split('"receiver":"pfm"').length - 1, 2);
});

test("forward memo emits the nested-object form, never the escaped-string form", () => {
  const memo = buildForwardMemo(
    [{ channelId: "channel-0" }, { channelId: "channel-1" }],
    "juno1abc",
  );
  assert.equal(memo.includes("\\"), false, memo);
  assert.equal(memo.includes('"next":"'), false, memo);
});

test("forward timeout and retries are overridable memo-wide and per hop", () => {
  assert.equal(
    buildForwardMemo([{ channelId: "channel-7" }], "juno1abc", {
      timeout: "1h30m",
      retries: 0,
    }),
    '{"forward":{"receiver":"juno1abc","port":"transfer","channel":"channel-7","timeout":"1h30m","retries":0}}',
  );
  assert.equal(
    buildForwardMemo(
      [
        { channelId: "channel-7", timeout: "30s", retries: 5 },
        { channelId: "channel-8", port: "transfer-v2" },
      ],
      "juno1abc",
      { timeout: "2m", retries: 1 },
    ),
    '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-7","timeout":"30s",' +
      '"retries":5,"next":{"forward":{"receiver":"juno1abc","port":"transfer-v2",' +
      '"channel":"channel-8","timeout":"2m","retries":1}}}}',
  );
});

test("forward memo can carry a trailing memo for the destination chain", () => {
  const memo = buildForwardMemo([{ channelId: "channel-1" }], "osmo1contract", {
    next: buildWasmHookMemoJson("osmo1contract", { do_thing: {} }),
  });
  assert.equal(
    memo,
    '{"forward":{"receiver":"osmo1contract","port":"transfer","channel":"channel-1",' +
      '"timeout":"10m","retries":2,"next":{"wasm":{"contract":"osmo1contract","msg":{"do_thing":{}}}}}}',
  );
});

/* -------------------------------------------------------------------------- *
 * buildForwardMemo — rejections
 * -------------------------------------------------------------------------- */

test("forward memo rejects an empty or oversized hop list", () => {
  rejects(() => buildForwardMemo([], "juno1abc"), /at least one hop/);
  const many: ForwardHop[] = Array.from({ length: 9 }, (_, i) => ({
    channelId: `channel-${i}`,
  }));
  rejects(() => buildForwardMemo(many, "juno1abc"), /more than 8 hops/);
  // The ceiling is configurable, so the same list passes when the host raises it.
  assert.ok(buildForwardMemo(many, "juno1abc", { maxHops: 9 }).length > 0);
});

test("forward memo refuses to make the sentinel the final receiver", () => {
  // The whole point of "pfm" is that no key controls it; using it as the final
  // receiver would burn the transfer.
  rejects(() => buildForwardMemo([{ channelId: "channel-1" }], "pfm"), /intermediate sentinel/);
});

test("forward memo rejects malformed receivers", () => {
  rejects(() => buildForwardMemo([{ channelId: "channel-1" }], ""), /must not be empty/);
  rejects(
    () => buildForwardMemo([{ channelId: "channel-1" }], "osmo1abc def"),
    /whitespace or a control character/,
  );
  rejects(
    () => buildForwardMemo([{ channelId: "channel-1" }], `osmo1abc${String.fromCharCode(10)}`),
    /whitespace or a control character/,
  );
  // A zero-width no-break space would render as a valid address but is not one.
  rejects(
    () => buildForwardMemo([{ channelId: "channel-1" }], `osmo1${String.fromCharCode(0xfeff)}abc`),
    /whitespace or a control character/,
  );
  rejects(
    () => buildForwardMemo([{ channelId: "channel-1" }], 42 as unknown as string),
    /must be a string/,
  );
});

test("forward memo rejects malformed channel and port identifiers", () => {
  rejects(() => buildForwardMemo([{ channelId: "" }], "juno1abc"), /not a valid IBC identifier/);
  rejects(
    () => buildForwardMemo([{ channelId: "channel 1" }], "juno1abc"),
    /not a valid IBC identifier/,
  );
  rejects(
    () => buildForwardMemo([{ channelId: "channel-1", port: "" }], "juno1abc"),
    /not a valid IBC identifier/,
  );
  // Bare digits are not normalised here; a caller passing "42" has a bug.
  rejects(() => buildForwardMemo([{ channelId: "4" }], "juno1abc"), /not a valid IBC identifier/);
});

test("forward memo rejects timeouts that Go would not parse", () => {
  for (const timeout of ["10", "10 m", "ten minutes", "0s", "-5m", "1e3s", ""]) {
    rejects(
      () => buildForwardMemo([{ channelId: "channel-1", timeout }], "juno1abc"),
      /positive Go duration/,
    );
  }
  for (const timeout of ["10m", "30s", "1h30m", "500ms", "1h0m0s"]) {
    assert.ok(buildForwardMemo([{ channelId: "channel-1", timeout }], "juno1abc").includes(timeout));
  }
});

test("forward memo rejects retries outside the uint8 PFM decodes into", () => {
  rejects(
    () => buildForwardMemo([{ channelId: "channel-1", retries: -1 }], "juno1abc"),
    /between 0 and 255/,
  );
  rejects(
    () => buildForwardMemo([{ channelId: "channel-1", retries: 256 }], "juno1abc"),
    /between 0 and 255/,
  );
  rejects(
    () => buildForwardMemo([{ channelId: "channel-1", retries: 1.5 }], "juno1abc"),
    /must be an integer/,
  );
  rejects(
    () => buildForwardMemo([{ channelId: "channel-1", retries: Number.NaN }], "juno1abc"),
    /must be an integer/,
  );
});

test("forward memo rejects a non-object hop", () => {
  rejects(
    () => buildForwardMemo(["channel-1"] as unknown as ForwardHop[], "juno1abc"),
    /must be an object/,
  );
});

/* -------------------------------------------------------------------------- *
 * buildWasmHookMemo
 * -------------------------------------------------------------------------- */

test("wasm hook memo matches the ibc-hooks shape byte for byte", () => {
  assert.equal(
    buildWasmHookMemo("osmo1contractAddr", { increment: {} }),
    '{"wasm":{"contract":"osmo1contractAddr","msg":{"increment":{}}}}',
  );
});

test("wasm hook memo produces exactly the two keys the middleware requires", () => {
  const built = buildWasmHookMemoJson("osmo1c", { swap: { amount: "1" } });
  const wasm = built.wasm;
  assert.ok(wasm !== undefined && typeof wasm === "object" && !Array.isArray(wasm));
  assert.deepEqual(Object.keys(wasm as JsonObject), ["contract", "msg"]);
});

test("wasm hook memo rejects a msg that is not a JSON object", () => {
  for (const msg of [null, [], "swap", 1, true]) {
    rejects(() => buildWasmHookMemo("osmo1c", msg as unknown as JsonObject), /must be a JSON object/);
  }
});

test("wasm hook memo rejects an empty msg", () => {
  // A CosmWasm ExecuteMsg is an enum; {} names no variant and always errors.
  rejects(() => buildWasmHookMemo("osmo1c", {}), /must name a variant/);
});

test("wasm hook memo rejects a contract address that is not usable", () => {
  rejects(() => buildWasmHookMemo("", { a: 1 }), /must not be empty/);
  rejects(() => buildWasmHookMemo("osmo1 c", { a: 1 }), /whitespace or a control character/);
  rejects(
    () => buildWasmHookMemo(undefined as unknown as string, { a: 1 }),
    /must be a string/,
  );
});

test("wasm hook memo rejects values JSON.stringify would silently rewrite", () => {
  rejects(
    () => buildWasmHookMemo("osmo1c", { swap: { amount: Number.NaN } }),
    /msg\.swap\.amount is NaN/,
  );
  rejects(
    () => buildWasmHookMemo("osmo1c", { swap: { amount: Number.POSITIVE_INFINITY } }),
    /encodes as null/,
  );
  rejects(
    () => buildWasmHookMemo("osmo1c", { swap: { at: new Date(0) } } as unknown as JsonObject),
    /class instance/,
  );
  rejects(
    () => buildWasmHookMemo("osmo1c", { swap: { amount: 1n } } as unknown as JsonObject),
    /bigint/,
  );
  rejects(
    () => buildWasmHookMemo("osmo1c", { swap: { fn: () => 1 } } as unknown as JsonObject),
    /function/,
  );
  rejects(
    () => buildWasmHookMemo("osmo1c", { swap: [1, undefined] } as unknown as JsonObject),
    /msg\.swap\[1\] is undefined/,
  );
});

test("wasm hook memo rejects a cyclic msg with a useful message", () => {
  const cyclic: Record<string, unknown> = { swap: {} };
  cyclic.self = cyclic;
  rejects(() => buildWasmHookMemo("osmo1c", cyclic as unknown as JsonObject), /reference cycle/);
});

test("wasm hook memo drops undefined properties, the way JSON does", () => {
  assert.equal(
    buildWasmHookMemo("osmo1c", { swap: { amount: "1", slippage: undefined } }),
    '{"wasm":{"contract":"osmo1c","msg":{"swap":{"amount":"1"}}}}',
  );
});

test("wasmHookReceiver returns the contract, and both legal receivers validate", () => {
  // ibc-hooks accepts "" or the contract; the contract is the one ibc-go's
  // MsgTransfer.ValidateBasic will also accept.
  assert.equal(wasmHookReceiver("osmo1contract"), "osmo1contract");
  rejects(() => wasmHookReceiver(""), /must not be empty/);
  assert.equal(isWasmHookReceiverValid("", "osmo1contract"), true);
  assert.equal(isWasmHookReceiverValid("osmo1contract", "osmo1contract"), true);
  assert.equal(isWasmHookReceiverValid("osmo1someoneelse", "osmo1contract"), false);
});

/* -------------------------------------------------------------------------- *
 * buildXcsSwapMemo
 * -------------------------------------------------------------------------- */

const XCS_CONTRACT = "osmo1xcscontract";

test("xcs swap memo reproduces the crosschain-swaps README example", () => {
  assert.equal(
    buildXcsSwapMemo({
      contract: "[XCS_ADDRESS]",
      outputDenom: "token1",
      receiver: "juno1receiver",
      slippage: { kind: "twap", slippagePercentage: "20", windowSeconds: 10 },
      onFailedDelivery: { kind: "do_nothing" },
    }),
    '{"wasm":{"contract":"[XCS_ADDRESS]","msg":{"osmosis_swap":{"output_denom":"token1",' +
      '"slippage":{"twap":{"slippage_percentage":"20","window_seconds":10}},' +
      '"receiver":"juno1receiver","on_failed_delivery":"do_nothing","next_memo":null}}}}',
  );
});

test("xcs swap memo omits window_seconds so the contract applies its own default", () => {
  // swaprouter reads `window: Option<u64>` and falls back to `unwrap_or(3600)`.
  // Emitting the key with a guessed value would silently narrow the TWAP window
  // and read a noisier price on a thin pool, so an absent window stays absent.
  const memo = JSON.parse(
    buildXcsSwapMemo({
      contract: XCS_CONTRACT,
      outputDenom: "uatom",
      receiver: "cosmos1receiver",
      slippage: { kind: "twap", slippagePercentage: "5" },
      onFailedDelivery: { kind: "do_nothing" },
    }),
  ) as Record<string, never>;
  const slippage = (
    memo.wasm as unknown as { msg: { osmosis_swap: { slippage: { twap: object } } } }
  ).msg.osmosis_swap.slippage;
  assert.deepEqual(slippage, { twap: { slippage_percentage: "5" } });
  assert.ok(!("window_seconds" in slippage.twap));
});

test("xcs swap memo supports the min_output_amount slippage form", () => {
  assert.equal(
    buildXcsSwapMemo({
      contract: XCS_CONTRACT,
      outputDenom: "uatom",
      receiver: "cosmos1receiver",
      slippage: { kind: "min_output_amount", minOutputAmount: "100" },
      onFailedDelivery: { kind: "local_recovery_addr", address: "osmo1recovery" },
    }),
    '{"wasm":{"contract":"osmo1xcscontract","msg":{"osmosis_swap":{"output_denom":"uatom",' +
      '"slippage":{"min_output_amount":"100"},"receiver":"cosmos1receiver",' +
      '"on_failed_delivery":{"local_recovery_addr":"osmo1recovery"},"next_memo":null}}}}',
  );
});

test("xcs swap memo chains a forward after the swap", () => {
  const memo = buildXcsSwapMemo({
    contract: XCS_CONTRACT,
    outputDenom: "ustars",
    receiver: "juno1receiver",
    slippage: { kind: "min_output_amount", minOutputAmount: "100" },
    onFailedDelivery: { kind: "local_recovery_addr", address: "osmo1recovery" },
    nextMemo: buildForwardMemoJson([{ channelId: "channel-42" }], "stars1final"),
  });
  assert.equal(
    memo,
    '{"wasm":{"contract":"osmo1xcscontract","msg":{"osmosis_swap":{"output_denom":"ustars",' +
      '"slippage":{"min_output_amount":"100"},"receiver":"juno1receiver",' +
      '"on_failed_delivery":{"local_recovery_addr":"osmo1recovery"},' +
      '"next_memo":{"forward":{"receiver":"stars1final","port":"transfer","channel":"channel-42",' +
      '"timeout":"10m","retries":2}}}}}}',
  );
});

test("xcs swap memo always writes next_memo, spelled null when absent", () => {
  const memo = buildXcsSwapMemo({
    contract: XCS_CONTRACT,
    outputDenom: "uosmo",
    receiver: "osmo1receiver",
    slippage: { kind: "twap", slippagePercentage: "1", windowSeconds: 30 },
    onFailedDelivery: { kind: "local_recovery_addr", address: "osmo1recovery" },
    nextMemo: null,
  });
  assert.ok(memo.includes('"next_memo":null'), memo);
});

test("xcs swap memo rejects malformed slippage", () => {
  const base = {
    contract: XCS_CONTRACT,
    outputDenom: "uosmo",
    receiver: "osmo1receiver",
    onFailedDelivery: { kind: "local_recovery_addr" as const, address: "osmo1recovery" },
  };
  const bad: Array<[unknown, RegExp]> = [
    [{ kind: "twap", slippagePercentage: 20, windowSeconds: 10 }, /decimal string/],
    [{ kind: "twap", slippagePercentage: "20%", windowSeconds: 10 }, /decimal string/],
    [{ kind: "twap", slippagePercentage: "101", windowSeconds: 10 }, /between 0 and 100/],
    [{ kind: "twap", slippagePercentage: "20", windowSeconds: 0 }, /positive integer/],
    [{ kind: "twap", slippagePercentage: "20", windowSeconds: 1.5 }, /positive integer/],
    [{ kind: "min_output_amount", minOutputAmount: "1.5" }, /integer string/],
    [{ kind: "min_output_amount", minOutputAmount: 100 }, /integer string/],
    [{ kind: "twap_v2" }, /Unknown slippage kind/],
    [null, /must be an object/],
  ];
  for (const [slippage, match] of bad) {
    rejects(
      () => buildXcsSwapMemo({ ...base, slippage } as unknown as XcsSwapParams),
      match,
    );
  }
});

test("xcs swap memo rejects a malformed failure action", () => {
  const base = {
    contract: XCS_CONTRACT,
    outputDenom: "uosmo",
    receiver: "osmo1receiver",
    slippage: { kind: "min_output_amount" as const, minOutputAmount: "1" },
  };
  rejects(
    () =>
      buildXcsSwapMemo({
        ...base,
        onFailedDelivery: { kind: "refund" },
      } as unknown as XcsSwapParams),
    /Unknown onFailedDelivery kind/,
  );
  rejects(
    () =>
      buildXcsSwapMemo({
        ...base,
        onFailedDelivery: { kind: "local_recovery_addr", address: "" },
      } as unknown as XcsSwapParams),
    /onFailedDelivery\.address must not be empty/,
  );
});

test("xcs swap memo rejects a malformed denom or receiver", () => {
  const base = {
    contract: XCS_CONTRACT,
    slippage: { kind: "min_output_amount" as const, minOutputAmount: "1" },
    onFailedDelivery: { kind: "do_nothing" as const },
  };
  rejects(
    () => buildXcsSwapMemo({ ...base, outputDenom: "", receiver: "osmo1r" }),
    /outputDenom must be a non-empty string/,
  );
  rejects(
    () => buildXcsSwapMemo({ ...base, outputDenom: "u osmo", receiver: "osmo1r" }),
    /outputDenom contains whitespace/,
  );
  rejects(
    () => buildXcsSwapMemo({ ...base, outputDenom: "uosmo", receiver: "" }),
    /receiver must not be empty/,
  );
  rejects(
    () => buildXcsSwapMemo({ ...base, outputDenom: "uosmo", receiver: "osmo1r", contract: "" }),
    /contract must not be empty/,
  );
});

/* -------------------------------------------------------------------------- *
 * Byte-length ceiling
 * -------------------------------------------------------------------------- */

test("memoByteLength counts UTF-8 bytes, not UTF-16 units", () => {
  assert.equal(memoByteLength(""), 0);
  assert.equal(memoByteLength("abc"), 3);
  assert.equal(memoByteLength("é"), 2);
  assert.equal(memoByteLength("😀"), 4);
});

test("builders throw over the byte ceiling and never truncate", () => {
  const hops = [{ channelId: "channel-0" }, { channelId: "channel-1" }];
  rejects(() => buildForwardMemo(hops, "juno1abc", { maxBytes: 64 }), /over the 64-byte limit/);
  rejects(
    () => buildWasmHookMemo("osmo1c", { swap: { note: "x".repeat(200) } }, { maxBytes: 100 }),
    /over the 100-byte limit/,
  );
  // Under the limit it comes back whole, not shortened.
  const memo = buildForwardMemo(hops, "juno1abc", { maxBytes: 4096 });
  assert.equal(memoByteLength(memo), memo.length);
  assert.ok(memo.endsWith("}}"));
});

test("checkMemoBytes warns instead of failing between the two thresholds", () => {
  const small = checkMemoBytes("hello");
  assert.deepEqual(
    { exceedsWarn: small.exceedsWarn, exceedsMax: small.exceedsMax, warning: small.warning },
    { exceedsWarn: false, exceedsMax: false, warning: null },
  );

  // The advisory threshold is off unless the host asks for it: 256 bytes is the
  // transaction memo limit, and a two-hop packet memo is already past it.
  const quiet = checkMemoBytes("x".repeat(300));
  assert.equal(quiet.exceedsWarn, false);
  assert.equal(quiet.warning, null);

  const long = checkMemoBytes("x".repeat(300), { warnBytes: TX_MEMO_MAX_BYTES });
  assert.equal(long.byteLength, 300);
  assert.equal(long.exceedsWarn, true);
  assert.equal(long.exceedsMax, false);
  assert.match(long.warning ?? "", /over the 256-byte advisory threshold/);

  const huge = checkMemoBytes("x".repeat(64), { maxBytes: 32 });
  assert.equal(huge.exceedsMax, true);
  assert.match(huge.warning ?? "", /over the 32-byte limit/);
});

/* -------------------------------------------------------------------------- *
 * validateMemo — classification
 * -------------------------------------------------------------------------- */

test("validateMemo reports an absent memo as empty", () => {
  for (const memo of ["", "   "]) {
    const result = validateMemo(memo);
    assert.equal(result.kind, "empty");
    assert.equal(result.summary, "No memo.");
    assert.equal(result.requiresPfm, false);
    assert.equal(result.requiresIbcHooks, false);
  }
});

test("validateMemo reports non-JSON and non-object JSON as inert plain text", () => {
  // Neither PFM nor ibc-hooks unmarshals these into the map they read.
  assert.equal(validateMemo("deposit for user 42").kind, "plain-text");
  assert.equal(validateMemo("{not json").kind, "plain-text");
  // Exchange deposit memos are usually bare digits.
  assert.equal(validateMemo("104520").kind, "plain-text");
  assert.equal(validateMemo('"forward"').kind, "plain-text");
  assert.equal(validateMemo("[1,2,3]").kind, "plain-text");
  assert.equal(validateMemo("null").kind, "plain-text");
});

test("validateMemo reads back the memos this module builds", () => {
  const oneHop = validateMemo(buildForwardMemo([{ channelId: "channel-42" }], "osmo1receiver"));
  assert.equal(oneHop.kind, "forward");
  assert.equal(oneHop.requiresPfm, true);
  assert.equal(oneHop.requiresIbcHooks, false);
  assert.deepEqual(oneHop.warnings, []);
  assert.deepEqual(oneHop.forward, {
    hops: [
      {
        receiver: "osmo1receiver",
        port: "transfer",
        channelId: "channel-42",
        timeout: "10m",
        retries: 2,
      },
    ],
    finalReceiver: "osmo1receiver",
    hasNextMemo: false,
  });
  assert.equal(
    oneHop.summary,
    "On arrival, forwards one more hop (channel-42) and pays osmo1receiver.",
  );

  const threeHop = validateMemo(
    buildForwardMemo(
      [{ channelId: "channel-0" }, { channelId: "channel-1" }, { channelId: "channel-2" }],
      "juno1abc",
    ),
  );
  assert.equal(threeHop.kind, "forward");
  assert.equal(threeHop.forward?.hops.length, 3);
  assert.equal(threeHop.forward?.finalReceiver, "juno1abc");
  assert.equal(
    threeHop.summary,
    "On arrival, forwards 3 more hops (channel-0, then channel-1, then channel-2) and pays juno1abc.",
  );
});

test("validateMemo describes a plain contract call", () => {
  const result = validateMemo(buildWasmHookMemo("osmo1contract", { increment: { by: 1 } }));
  assert.equal(result.kind, "wasm");
  assert.equal(result.requiresIbcHooks, true);
  assert.equal(result.requiresPfm, false);
  assert.equal(result.wasm?.contract, "osmo1contract");
  assert.deepEqual(result.wasm?.msgKeys, ["increment"]);
  assert.equal(result.summary, "On arrival, calls contract osmo1contract with increment.");
  assert.deepEqual(result.warnings, []);
});

test("validateMemo describes a crosschain swap and its recovery address", () => {
  const result = validateMemo(
    buildXcsSwapMemo({
      contract: XCS_CONTRACT,
      outputDenom: "uatom",
      receiver: "cosmos1receiver",
      slippage: { kind: "twap", slippagePercentage: "5", windowSeconds: 10 },
      onFailedDelivery: { kind: "local_recovery_addr", address: "osmo1recovery" },
    }),
  );
  assert.equal(result.kind, "xcs");
  assert.equal(result.requiresIbcHooks, true);
  assert.deepEqual(result.xcs?.slippage, {
    kind: "twap",
    slippagePercentage: "5",
    windowSeconds: 10,
  });
  assert.deepEqual(result.xcs?.onFailedDelivery, {
    kind: "local_recovery_addr",
    address: "osmo1recovery",
  });
  assert.equal(
    result.summary,
    "On arrival, swaps to uatom (up to 5% off the 10s average price) and pays cosmos1receiver. " +
      "Recovery address osmo1recovery.",
  );
  assert.deepEqual(result.warnings, []);
});

test("validateMemo warns when a swap cannot recover stranded funds", () => {
  const result = validateMemo(
    buildXcsSwapMemo({
      contract: XCS_CONTRACT,
      outputDenom: "uatom",
      receiver: "cosmos1receiver",
      slippage: { kind: "min_output_amount", minOutputAmount: "0" },
      onFailedDelivery: { kind: "do_nothing" },
    }),
  );
  assert.equal(result.kind, "xcs");
  assert.ok(result.warnings.some((w) => w.includes("do_nothing")), result.warnings.join(" | "));
  assert.ok(
    result.warnings.some((w) => w.includes("Minimum output is 0")),
    result.warnings.join(" | "),
  );
});

test("validateMemo follows a swap chained after a forward", () => {
  const memo = buildForwardMemo([{ channelId: "channel-1" }], XCS_CONTRACT, {
    next: buildWasmHookMemoJson(XCS_CONTRACT, {
      osmosis_swap: {
        output_denom: "uatom",
        slippage: { min_output_amount: "100" },
        receiver: "cosmos1receiver",
        on_failed_delivery: { local_recovery_addr: "osmo1recovery" },
        next_memo: null,
      },
    }),
  });
  const result = validateMemo(memo);
  assert.equal(result.kind, "xcs");
  assert.equal(result.requiresPfm, true);
  assert.equal(result.requiresIbcHooks, true);
  assert.equal(result.forward?.hasNextMemo, true);
  assert.equal(result.xcs?.outputDenom, "uatom");
  assert.equal(
    result.summary,
    `On arrival, forwards one more hop (channel-1) and pays ${XCS_CONTRACT}. ` +
      "Then swaps to uatom (at least 100 base units out) and pays cosmos1receiver.",
  );
});

test("validateMemo cross-checks the transfer receiver against the hook contract", () => {
  const memo = buildWasmHookMemo("osmo1contract", { increment: {} });
  assert.deepEqual(validateMemo(memo, { receiver: "osmo1contract" }).warnings, []);
  assert.deepEqual(validateMemo(memo, { receiver: "" }).warnings, []);
  const wrong = validateMemo(memo, { receiver: "osmo1someoneelse" });
  assert.ok(
    wrong.warnings.some((w) => w.includes("ibc-hooks will not run")),
    wrong.warnings.join(" | "),
  );
});

/* -------------------------------------------------------------------------- *
 * validateMemo — conservative rejection
 * -------------------------------------------------------------------------- */

const UNKNOWN = "Unrecognised memo.";

test("validateMemo refuses to classify a wasm object without exactly two keys", () => {
  const three = validateMemo(
    '{"wasm":{"contract":"osmo1c","msg":{"a":1},"funds":[{"denom":"uosmo","amount":"1"}]}}',
  );
  assert.equal(three.kind, "unknown");
  assert.ok(three.summary.startsWith(UNKNOWN));
  assert.ok(three.warnings.some((w) => w.includes("exactly the two fields")));

  assert.equal(validateMemo('{"wasm":{"contract":"osmo1c"}}').kind, "unknown");
  assert.equal(validateMemo('{"wasm":{"msg":{"a":1}}}').kind, "unknown");
  assert.equal(validateMemo('{"wasm":{"contract":"","msg":{"a":1}}}').kind, "unknown");
  // `msg` must be an object, not an array or a string.
  assert.equal(validateMemo('{"wasm":{"contract":"osmo1c","msg":[]}}').kind, "unknown");
  assert.equal(validateMemo('{"wasm":{"contract":"osmo1c","msg":"swap"}}').kind, "unknown");
  assert.equal(validateMemo('{"wasm":{"contract":"osmo1c","msg":null}}').kind, "unknown");
  assert.equal(validateMemo('{"wasm":"osmo1c"}').kind, "unknown");
});

test("validateMemo refuses a memo carrying keys alongside wasm or forward", () => {
  const beside = validateMemo('{"wasm":{"contract":"osmo1c","msg":{"a":1}},"note":"hi"}');
  assert.equal(beside.kind, "unknown");
  assert.ok(beside.warnings.some((w) => w.includes("alongside `wasm`")));

  const both = validateMemo(
    '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-1"},' +
      '"wasm":{"contract":"osmo1c","msg":{"a":1}}}',
  );
  assert.equal(both.kind, "unknown");
  assert.equal(both.requiresPfm, true);
  assert.equal(both.requiresIbcHooks, true);
});

test("validateMemo refuses a forward memo with an unreadable hop", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['{"forward":null}', "not a JSON object"],
    ['{"forward":{"port":"transfer","channel":"channel-1"}}', "no `receiver`"],
    ['{"forward":{"receiver":"pfm","channel":"channel-1"}}', "no valid `port`"],
    ['{"forward":{"receiver":"pfm","port":"transfer"}}', "no valid `channel`"],
    [
      '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel 1"}}',
      "no valid `channel`",
    ],
    [
      '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-1","timeout":"soon"}}',
      "not a Go duration",
    ],
    [
      '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-1","retries":256}}',
      "integer in 0-255",
    ],
    [
      '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-1","retries":"2"}}',
      "integer in 0-255",
    ],
    [
      '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-1","next":"{oops"}}',
      "not JSON",
    ],
    [
      '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-1","next":42}}',
      "not a JSON object",
    ],
  ];
  for (const [memo, reason] of cases) {
    const result = validateMemo(memo);
    assert.equal(result.kind, "unknown", memo);
    assert.equal(result.requiresPfm, true, memo);
    assert.ok(
      result.warnings.some((w) => w.includes(reason)),
      `${memo} -> ${result.warnings.join(" | ")}`,
    );
  }
});

test("validateMemo refuses a forward whose trailing memo it cannot read", () => {
  const opaque = validateMemo(
    '{"forward":{"receiver":"osmo1r","port":"transfer","channel":"channel-1",' +
      '"next":{"src_callback":{"address":"osmo1cb"}}}}',
  );
  assert.equal(opaque.kind, "unknown");
  // What could be read is still reported, so the UI can show the hops.
  assert.equal(opaque.forward?.hops.length, 1);

  const badHook = validateMemo(
    '{"forward":{"receiver":"osmo1r","port":"transfer","channel":"channel-1",' +
      '"next":{"wasm":{"contract":"osmo1c","msg":{"a":1},"extra":true}}}}',
  );
  assert.equal(badHook.kind, "unknown");
  assert.ok(badHook.warnings.some((w) => w.includes("does not follow the ibc-hooks rules")));
});

test("validateMemo refuses a swap whose fields it cannot read", () => {
  const result = validateMemo(
    '{"wasm":{"contract":"osmo1c","msg":{"osmosis_swap":{"output_denom":"uatom",' +
      '"slippage":{"twap":{"slippage_percentage":"5"}},"receiver":"cosmos1r",' +
      '"on_failed_delivery":"do_nothing"}}}}',
  );
  assert.equal(result.kind, "unknown");
  assert.ok(result.warnings.some((w) => w.includes("claims to be a crosschain swap")));
  // The hook itself parsed, so it is still reported.
  assert.equal(result.wasm?.contract, "osmo1c");
});

test("validateMemo refuses a JSON object with no key it models", () => {
  const result = validateMemo('{"src_callback":{"address":"osmo1cb"}}');
  assert.equal(result.kind, "unknown");
  assert.ok(result.warnings.some((w) => w.includes("src_callback")));
  assert.equal(result.requiresPfm, false);
  assert.equal(result.requiresIbcHooks, false);
});

test("validateMemo gives up on a memo nested past its depth limit", () => {
  let memo = '{"forward":{"receiver":"osmo1r","port":"transfer","channel":"channel-0"}}';
  for (let i = 0; i < 20; i++) {
    memo =
      '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-0","next":' + memo + "}}";
  }
  const result = validateMemo(memo);
  assert.equal(result.kind, "unknown");
  assert.ok(result.warnings.some((w) => w.includes("nests more than")));
});

/* -------------------------------------------------------------------------- *
 * validateMemo — tolerated but flagged
 * -------------------------------------------------------------------------- */

test("validateMemo reads the escaped-string form of next and says so", () => {
  const inner = '{"forward":{"receiver":"juno1abc","port":"transfer","channel":"channel-234","timeout":"10m","retries":2}}';
  const memo = JSON.stringify({
    forward: {
      receiver: "pfm",
      port: "transfer",
      channel: "channel-123",
      timeout: "10m",
      retries: 2,
      next: inner,
    },
  });
  const result = validateMemo(memo);
  assert.equal(result.kind, "forward");
  assert.equal(result.forward?.hops.length, 2);
  assert.equal(result.forward?.finalReceiver, "juno1abc");
  assert.ok(result.warnings.some((w) => w.includes("escaped-string form")));
});

test("validateMemo accepts the legacy integer-nanoseconds timeout with a warning", () => {
  const result = validateMemo(
    '{"forward":{"receiver":"juno1abc","port":"transfer","channel":"channel-1","timeout":600000000000}}',
  );
  assert.equal(result.kind, "forward");
  assert.equal(result.forward?.hops[0]?.timeout, "600000000000ns");
  assert.ok(result.warnings.some((w) => w.includes("integer-nanoseconds")));
});

test("validateMemo reports an omitted timeout or retries as null, not as a default", () => {
  // PFM applies its own defaults; inventing "10m" here would tell the user
  // something the memo does not say.
  const result = validateMemo(
    '{"forward":{"receiver":"juno1abc","port":"transfer","channel":"channel-1"}}',
  );
  assert.equal(result.kind, "forward");
  assert.deepEqual(result.forward?.hops[0], {
    receiver: "juno1abc",
    port: "transfer",
    channelId: "channel-1",
    timeout: null,
    retries: null,
  });
});

test("validateMemo warns about receivers that break the PFM convention", () => {
  const realIntermediate = validateMemo(
    '{"forward":{"receiver":"osmo1intermediate","port":"transfer","channel":"channel-0",' +
      '"next":{"forward":{"receiver":"juno1abc","port":"transfer","channel":"channel-1"}}}}',
  );
  assert.equal(realIntermediate.kind, "forward");
  assert.ok(
    realIntermediate.warnings.some((w) => w.includes("Hop 1 names a real receiver")),
    realIntermediate.warnings.join(" | "),
  );

  const sentinelFinal = validateMemo(
    '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-0"}}',
  );
  assert.equal(sentinelFinal.kind, "forward");
  assert.ok(
    sentinelFinal.warnings.some((w) => w.includes("unrecoverable")),
    sentinelFinal.warnings.join(" | "),
  );
});

test("validateMemo flags an unrecognised field on a forward hop", () => {
  const result = validateMemo(
    '{"forward":{"receiver":"juno1abc","port":"transfer","channel":"channel-1","fee":"10"}}',
  );
  assert.equal(result.kind, "forward");
  assert.ok(result.warnings.some((w) => w.includes("unrecognised field `fee`")));
});

test("validateMemo flags a contract message that names more than one variant", () => {
  const result = validateMemo('{"wasm":{"contract":"osmo1c","msg":{"a":{},"b":{}}}}');
  assert.equal(result.kind, "wasm");
  assert.ok(result.warnings.some((w) => w.includes("exactly one ExecuteMsg variant")));
});

test("validateMemo never throws, whatever it is handed", () => {
  const hostile: unknown[] = [
    undefined,
    null,
    42,
    { forward: {} },
    `{"forward":{"receiver":"${"x".repeat(5000)}","port":"transfer","channel":"channel-1"}}`,
    "[".repeat(2000),
  ];
  for (const memo of hostile) {
    const result = validateMemo(memo as string);
    assert.ok(typeof result.summary === "string" && result.summary.length > 0);
    assert.ok(Array.isArray(result.warnings));
  }
});

test("validateMemo abbreviates long addresses in the summary but keeps them whole in the data", () => {
  const long = `osmo1${"a".repeat(50)}`;
  const result = validateMemo(buildForwardMemo([{ channelId: "channel-1" }], long));
  assert.equal(result.forward?.finalReceiver, long);
  assert.equal(result.summary.includes(long), false);
  assert.ok(result.summary.includes("osmo1aaaaa"));
});
