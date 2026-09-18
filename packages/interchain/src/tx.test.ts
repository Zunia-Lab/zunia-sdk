import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeBase64Utf8, jsonToBase64 } from "./base64.js";
import {
  createLcdPostClient,
  isLcdPostClient,
  type FetchLike,
  type LcdPostClient,
} from "./lcd.js";
import {
  broadcast,
  buildUnsignedTxRequest,
  classifyTxFailure,
  DEFAULT_GAS_ADJUSTMENT,
  estimateFee,
  getAccount,
  getTxStatus,
  isEthSecp256k1PubKey,
  isTxRejectedError,
  parseAccount,
  simulate,
  waitForTx,
} from "./tx.js";
import {
  InterchainError,
  isInterchainError,
  type AccountInfo,
  type BuiltMsg,
  type ChainInfoLike,
  type FeeEstimate,
  type JsonObject,
  type LcdClient,
  type LcdRequestOptions,
} from "./types.js";

const CHAIN_ID = "safrochain-1";
/** Safrochain's prefix has an underscore, which most bech32 regexes reject. */
const ADDRESS = "addr_safro1jrkmdcwgq94uaamx6zax2luewlhf7u4kuv3x2p";
const HASH = "9D8A2F1B0C7E4A6D5B3F1E9C8A7D6B5C4E3F2A1B0C9D8E7F6A5B4C3D2E1F0A9B";

const CHAIN: ChainInfoLike = {
  chainId: CHAIN_ID,
  chainName: "Safrochain",
  bech32Prefix: "addr_safro",
  coinType: 118,
  coinDenom: "SAFRO",
  coinMinimalDenom: "usafro",
  coinDecimals: 6,
  feeDenom: "SAFRO",
  feeMinimalDenom: "usafro",
  feeDecimals: 6,
  gasPriceStep: { low: 0.01, average: 0.025, high: 0.04 },
  rest: "https://api.safrochain.example",
  features: ["cosmwasm"],
};

/* -------------------------------------------------------------------------- *
 * Stubs
 * -------------------------------------------------------------------------- */

interface GetCall {
  readonly path: string;
  readonly options: LcdRequestOptions | undefined;
}

interface PostCall {
  readonly path: string;
  readonly body: JsonObject;
}

type Answer = unknown | (() => unknown);

/** An LcdClient driven by a queue of answers. Never touches the network. */
function stubClient(answers: readonly Answer[]): LcdClient & {
  readonly calls: GetCall[];
} {
  const calls: GetCall[] = [];
  return {
    chainId: CHAIN_ID,
    calls,
    getJson: async (path, options) => {
      const answer = answers[calls.length];
      calls.push({ path, options });
      if (answer === undefined) {
        throw new Error(`unexpected GET #${calls.length}: ${path}`);
      }
      const value = typeof answer === "function" ? answer() : answer;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function stubPostClient(answers: readonly Answer[]): LcdPostClient & {
  readonly posts: PostCall[];
} {
  const posts: PostCall[] = [];
  return {
    chainId: CHAIN_ID,
    posts,
    getJson: async () => {
      throw new Error("this stub only posts");
    },
    postJson: async (path, body) => {
      const answer = answers[posts.length];
      posts.push({ path, body });
      if (answer === undefined) {
        throw new Error(`unexpected POST #${posts.length}: ${path}`);
      }
      const value = typeof answer === "function" ? answer() : answer;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function httpError(status: number, message = "boom"): InterchainError {
  return new InterchainError("lcd-unreachable", message, {
    chainId: CHAIN_ID,
    httpStatus: status,
  });
}

async function rejects(
  run: () => Promise<unknown>,
  code: string,
): Promise<InterchainError> {
  try {
    await run();
  } catch (error) {
    assert.ok(isInterchainError(error), `expected InterchainError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected a ${code} rejection`);
}

function throws(run: () => unknown, code: string): InterchainError {
  try {
    run();
  } catch (error) {
    assert.ok(isInterchainError(error), `expected InterchainError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected a ${code} throw`);
}

/* -------------------------------------------------------------------------- *
 * getAccount — the wrapper zoo
 * -------------------------------------------------------------------------- */

const PUB_KEY = {
  "@type": "/cosmos.crypto.secp256k1.PubKey",
  key: "A0/koq2Zw01gubpig8lDGoQYr4ZzISlh+Xp3tjd/zQW2",
};

function baseAccount(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    "@type": "/cosmos.auth.v1beta1.BaseAccount",
    address: ADDRESS,
    pub_key: PUB_KEY,
    account_number: "12345",
    sequence: "7",
    ...overrides,
  } as JsonObject;
}

test("getAccount reads a plain BaseAccount", async () => {
  const lcd = stubClient([{ account: baseAccount() }]);
  const account = await getAccount(lcd, CHAIN_ID, ADDRESS);

  assert.deepEqual(account, {
    address: ADDRESS,
    accountNumber: "12345",
    sequence: "7",
    pubKey: {
      typeUrl: "/cosmos.crypto.secp256k1.PubKey",
      key: PUB_KEY.key,
    },
  });
  assert.equal(lcd.calls[0]?.path, `/cosmos/auth/v1beta1/accounts/${ADDRESS}`);
});

test("getAccount never caches, because a stale sequence is an invalid signature", async () => {
  const lcd = stubClient([{ account: baseAccount() }]);
  await getAccount(lcd, CHAIN_ID, ADDRESS);
  assert.equal(lcd.calls[0]?.options?.cacheTtlMs, 0);
});

test("getAccount unwraps ModuleAccount", async () => {
  const lcd = stubClient([
    {
      account: {
        "@type": "/cosmos.auth.v1beta1.ModuleAccount",
        base_account: baseAccount({ account_number: "3", sequence: "0" }),
        name: "distribution",
        permissions: [],
      },
    },
  ]);
  const account = await getAccount(lcd, CHAIN_ID, ADDRESS);
  assert.equal(account.accountNumber, "3");
  assert.equal(account.sequence, "0");
});

test("getAccount unwraps EthAccount and reports the ethermint key type", async () => {
  const lcd = stubClient([
    {
      account: {
        "@type": "/ethermint.types.v1.EthAccount",
        base_account: baseAccount({
          account_number: "88",
          sequence: "2",
          pub_key: {
            "@type": "/ethermint.crypto.v1.ethsecp256k1.PubKey",
            key: PUB_KEY.key,
          },
        }),
        code_hash:
          "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
      },
    },
  ]);
  const account = await getAccount(lcd, CHAIN_ID, ADDRESS);
  assert.equal(account.accountNumber, "88");
  assert.equal(
    account.pubKey?.typeUrl,
    "/ethermint.crypto.v1.ethsecp256k1.PubKey",
  );
  assert.equal(isEthSecp256k1PubKey(account.pubKey), true);
});

test("getAccount unwraps BaseVestingAccount", async () => {
  const lcd = stubClient([
    {
      account: {
        "@type": "/cosmos.vesting.v1beta1.BaseVestingAccount",
        base_account: baseAccount({ account_number: "41", sequence: "9" }),
        original_vesting: [{ denom: "usafro", amount: "1000000" }],
        end_time: "1780000000",
      },
    },
  ]);
  const account = await getAccount(lcd, CHAIN_ID, ADDRESS);
  assert.equal(account.accountNumber, "41");
  assert.equal(account.sequence, "9");
});

test("getAccount unwraps the doubly nested vesting family", async () => {
  for (const typeUrl of [
    "/cosmos.vesting.v1beta1.ContinuousVestingAccount",
    "/cosmos.vesting.v1beta1.DelayedVestingAccount",
    "/cosmos.vesting.v1beta1.PeriodicVestingAccount",
    "/cosmos.vesting.v1beta1.PermanentLockedAccount",
  ]) {
    const lcd = stubClient([
      {
        account: {
          "@type": typeUrl,
          base_vesting_account: {
            "@type": "/cosmos.vesting.v1beta1.BaseVestingAccount",
            base_account: baseAccount({
              account_number: "512",
              sequence: "33",
            }),
            original_vesting: [],
          },
          start_time: "1700000000",
        },
      },
    ]);
    const account = await getAccount(lcd, CHAIN_ID, ADDRESS);
    assert.equal(account.accountNumber, "512", typeUrl);
    assert.equal(account.sequence, "33", typeUrl);
  }
});

test("getAccount reads the legacy amino result.value envelope", () => {
  const account = parseAccount(
    {
      height: "9001",
      result: {
        type: "cosmos-sdk/Account",
        value: {
          address: ADDRESS,
          public_key: {
            type: "tendermint/PubKeySecp256k1",
            value: PUB_KEY.key,
          },
          account_number: "17",
          sequence: "4",
        },
      },
    },
    CHAIN_ID,
    ADDRESS,
  );
  assert.equal(account.accountNumber, "17");
  assert.equal(account.pubKey?.typeUrl, "tendermint/PubKeySecp256k1");
});

test("getAccount reads the SDK 0.47 account_info envelope", () => {
  const account = parseAccount(
    { info: { address: ADDRESS, account_number: "5", sequence: "1" } },
    CHAIN_ID,
    ADDRESS,
  );
  assert.equal(account.accountNumber, "5");
  assert.equal(account.pubKey, null);
});

test("getAccount treats an omitted or numeric uint64 the way the wire does", () => {
  // proto-JSON drops a zero, and a handful of gateways emit JSON numbers.
  const omitted = parseAccount(
    { account: { "@type": "…BaseAccount", address: ADDRESS, sequence: "3" } },
    CHAIN_ID,
    ADDRESS,
  );
  assert.equal(omitted.accountNumber, "0");
  assert.equal(omitted.sequence, "3");

  const numeric = parseAccount(
    { account: { address: ADDRESS, account_number: 12, sequence: 0 } },
    CHAIN_ID,
    ADDRESS,
  );
  assert.equal(numeric.accountNumber, "12");
  assert.equal(numeric.sequence, "0");

  const padded = parseAccount(
    { account: { address: ADDRESS, account_number: "007", sequence: "010" } },
    CHAIN_ID,
    ADDRESS,
  );
  assert.equal(padded.accountNumber, "7");
  assert.equal(padded.sequence, "10");
});

test("getAccount yields zeros for an account the chain has never seen", async () => {
  for (const answer of [
    () => httpError(404),
    () => httpError(400, "rpc error: code = NotFound desc = account not found"),
    { code: 5, message: `account ${ADDRESS} not found`, details: [] },
    { account: null },
  ] as const) {
    const lcd = stubClient([answer]);
    const account = await getAccount(lcd, CHAIN_ID, ADDRESS);
    assert.deepEqual(account, {
      address: ADDRESS,
      accountNumber: "0",
      sequence: "0",
      pubKey: null,
    });
  }
});

test("getAccount rejects malformed payloads instead of signing over zeros", async () => {
  await rejects(
    () => getAccount(stubClient(["not an object"]), CHAIN_ID, ADDRESS),
    "malformed-response",
  );
  await rejects(
    () => getAccount(stubClient([{ account: [] }]), CHAIN_ID, ADDRESS),
    "malformed-response",
  );
  // Present but not a uint64 means the endpoint is broken; defaulting to 0
  // here would produce a signature over the wrong sign doc.
  await rejects(
    () =>
      getAccount(
        stubClient([{ account: baseAccount({ account_number: "12x" }) }]),
        CHAIN_ID,
        ADDRESS,
      ),
    "malformed-response",
  );
  await rejects(
    () =>
      getAccount(
        stubClient([{ account: baseAccount({ sequence: -1 }) }]),
        CHAIN_ID,
        ADDRESS,
      ),
    "malformed-response",
  );
  await rejects(
    () =>
      getAccount(stubClient([{ code: 13, message: "bad" }]), CHAIN_ID, ADDRESS),
    "malformed-response",
  );
});

test("getAccount refuses an address that would escape the URL path", async () => {
  for (const bad of ["", "../../../etc/passwd", "addr_safro1/../..", "nope"]) {
    await rejects(
      () => getAccount(stubClient([{}]), CHAIN_ID, bad),
      "malformed-response",
    );
  }
});

test("getAccount errors that are not 'missing account' propagate", async () => {
  await rejects(
    () => getAccount(stubClient([() => httpError(503)]), CHAIN_ID, ADDRESS),
    "lcd-unreachable",
  );
});

/* -------------------------------------------------------------------------- *
 * simulate
 * -------------------------------------------------------------------------- */

test("simulate posts tx_bytes and returns gas_used", async () => {
  const lcd = stubPostClient([
    { gas_info: { gas_wanted: "0", gas_used: "91175" }, result: {} },
  ]);
  const gas = await simulate(lcd, CHAIN_ID, "CgUKA2Zvbwo=");

  assert.equal(gas, "91175");
  assert.equal(lcd.posts[0]?.path, "/cosmos/tx/v1beta1/simulate");
  assert.deepEqual(lcd.posts[0]?.body, { tx_bytes: "CgUKA2Zvbwo=" });
});

test("simulate base64-encodes raw bytes without Buffer", async () => {
  const lcd = stubPostClient([{ gas_info: { gas_used: "1" } }]);
  await simulate(lcd, CHAIN_ID, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  assert.deepEqual(lcd.posts[0]?.body, { tx_bytes: "3q2+7w==" });
});

test("simulate rejects a response without gas_info", async () => {
  for (const body of [{}, { gas_info: {} }, { gas_info: { gas_used: "x" } }, null]) {
    await rejects(
      () => simulate(stubPostClient([body]), CHAIN_ID, "AA=="),
      "malformed-response",
    );
  }
});

test("simulate re-maps a 400 whose body named the cause", async () => {
  const error = await rejects(
    () =>
      simulate(
        stubPostClient([
          () =>
            httpError(
              400,
              "https://a.example returned HTTP 400: account sequence mismatch, expected 8, got 7",
            ),
        ]),
        CHAIN_ID,
        "AA==",
      ),
    "tx-rejected",
  );
  assert.ok(isTxRejectedError(error));
  assert.equal(error.failure.kind, "sequence-mismatch");
  assert.equal(error.failure.expectedSequence, "8");
});

test("simulate leaves an unexplained 400 as the transport error", async () => {
  const error = await rejects(
    () => simulate(stubPostClient([() => httpError(400, "bad request")]), CHAIN_ID, "AA=="),
    "lcd-unreachable",
  );
  assert.equal(isTxRejectedError(error), false);
});

/* -------------------------------------------------------------------------- *
 * estimateFee
 * -------------------------------------------------------------------------- */

test("estimateFee applies the multiplier and the requested tier", () => {
  const fee = estimateFee("91175", CHAIN, "average");
  // 91175 * 1.4 = 127645 exactly; 127645 * 0.025 = 3191.125 -> 3192.
  assert.equal(fee.gasLimit, "127645");
  assert.deepEqual(fee.amount, [{ denom: "usafro", amount: "3192" }]);
  assert.equal(fee.gasPrice, 0.025);
  assert.equal(fee.simulatedGas, "91175");
  assert.equal(fee.gasAdjustment, DEFAULT_GAS_ADJUSTMENT);

  assert.equal(estimateFee("100000", CHAIN, "low").amount[0]?.amount, "1400");
  assert.equal(estimateFee("100000", CHAIN, "high").amount[0]?.amount, "5600");
});

test("estimateFee rounds both computations up, never down", () => {
  // Rounding down by one base unit is rejected at CheckTx with code 13.
  assert.equal(estimateFee("1", CHAIN, "low", { gasAdjustment: 1.4 }).gasLimit, "2");
  assert.equal(
    estimateFee("100001", CHAIN, "low", { gasAdjustment: 1, gasPrice: 0.0025 })
      .amount[0]?.amount,
    // 100001 * 0.0025 = 250.0025
    "251",
  );
  // Exact multiples are not inflated.
  assert.equal(
    estimateFee("100000", CHAIN, "low", { gasAdjustment: 1, gasPrice: 0.0025 })
      .amount[0]?.amount,
    "250",
  );
});

test("estimateFee survives gas prices that a float would mangle", () => {
  // aevmos-scale price, well past 2^53 once multiplied by the gas limit.
  const big = estimateFee("21000", CHAIN, "low", {
    gasAdjustment: 1,
    gasPrice: 25000000000,
    feeDenom: "aevmos",
  });
  assert.deepEqual(big.amount, [{ denom: "aevmos", amount: "525000000000000" }]);

  // Sub-1e-7, where Number#toString switches to exponent notation.
  const tiny = estimateFee("1000000000000", CHAIN, "low", {
    gasAdjustment: 1,
    gasPrice: 2.5e-8,
  });
  assert.deepEqual(tiny.amount, [{ denom: "usafro", amount: "25000" }]);
});

test("estimateFee emits no coin at all on a zero-fee chain", () => {
  const fee = estimateFee("100000", CHAIN, "low", { gasPrice: 0 });
  assert.deepEqual(fee.amount, []);
  assert.equal(fee.gasLimit, "140000");
});

test("estimateFee honours floors, fee grants and a never-zero gas limit", () => {
  const fee = estimateFee("0", CHAIN, "low", {
    minGasLimit: "80000",
    payer: ADDRESS,
    granter: ADDRESS,
  });
  assert.equal(fee.gasLimit, "80000");
  assert.equal(fee.payer, ADDRESS);
  assert.equal(fee.granter, ADDRESS);

  // Fee::new in zunia-core rejects a zero gas limit outright.
  assert.equal(estimateFee("0", CHAIN, "low").gasLimit, "1");
});

test("estimateFee refuses to guess a gas price", () => {
  const priceless: ChainInfoLike = { ...CHAIN, gasPriceStep: undefined };
  throws(() => estimateFee("100000", priceless), "unsupported-chain");
  // …but an explicit override is enough.
  assert.equal(
    estimateFee("100000", priceless, "average", {
      gasAdjustment: 1,
      gasPrice: 0.1,
    }).amount[0]?.amount,
    "10000",
  );
});

test("estimateFee rejects nonsense inputs", () => {
  throws(() => estimateFee("-5", CHAIN), "malformed-response");
  throws(() => estimateFee("1e6", CHAIN), "malformed-response");
  throws(() => estimateFee("1000", CHAIN, "low", { gasAdjustment: 0 }), "malformed-response");
  throws(
    () => estimateFee("1000", CHAIN, "low", { minGasLimit: "lots" }),
    "malformed-response",
  );
});

/* -------------------------------------------------------------------------- *
 * broadcast
 * -------------------------------------------------------------------------- */

function txResponse(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    tx_response: {
      height: "0",
      txhash: HASH,
      codespace: "",
      code: 0,
      raw_log: "[]",
      gas_wanted: "127645",
      gas_used: "91175",
      ...overrides,
    },
  } as JsonObject;
}

test("broadcast posts SYNC by default and reports acceptance, not confirmation", async () => {
  const lcd = stubPostClient([txResponse()]);
  const result = await broadcast(lcd, CHAIN_ID, "CkIKQAoe");

  assert.equal(lcd.posts[0]?.path, "/cosmos/tx/v1beta1/txs");
  assert.deepEqual(lcd.posts[0]?.body, {
    tx_bytes: "CkIKQAoe",
    mode: "BROADCAST_MODE_SYNC",
  });
  assert.equal(result.txHash, HASH);
  assert.equal(result.code, 0);
  assert.equal(result.success, true);
  assert.equal(result.failure, null);
  assert.equal(result.gasUsed, "91175");
});

test("broadcast maps the async mode name", async () => {
  const lcd = stubPostClient([txResponse()]);
  await broadcast(lcd, CHAIN_ID, "AA==", "async");
  assert.equal(lcd.posts[0]?.body["mode"], "BROADCAST_MODE_ASYNC");
});

test("broadcast normalises a lowercase hash and an omitted zero code", async () => {
  const lcd = stubPostClient([
    { tx_response: { txhash: HASH.toLowerCase(), raw_log: "" } },
  ]);
  const result = await broadcast(lcd, CHAIN_ID, "AA==");
  assert.equal(result.txHash, HASH);
  assert.equal(result.success, true);
});

test("broadcast returns the hash even when the chain rejected the tx", async () => {
  // Throwing here would discard the one identifier support can look up.
  const lcd = stubPostClient([
    txResponse({
      code: 13,
      codespace: "sdk",
      raw_log: "insufficient fees; got: 100usafro required: 3192usafro",
    }),
  ]);
  const result = await broadcast(lcd, CHAIN_ID, "AA==");
  assert.equal(result.txHash, HASH);
  assert.equal(result.success, false);
  assert.equal(result.failure?.kind, "insufficient-fee");
  assert.equal(result.failure?.retryable, true);
});

test("broadcast rejects a body with no hash", async () => {
  for (const body of [null, {}, { tx_response: {} }, { tx_response: null }]) {
    await rejects(
      () => broadcast(stubPostClient([body]), CHAIN_ID, "AA=="),
      "malformed-response",
    );
  }
});

test("classifyTxFailure decodes the codes a wallet actually meets", () => {
  assert.equal(classifyTxFailure(0, ""), null);

  const cases: ReadonlyArray<readonly [number, string, string, boolean]> = [
    [4, "signature verification failed", "unauthorized", false],
    [5, "insufficient funds", "insufficient-funds", false],
    [11, "out of gas in location: WritePerByte", "out-of-gas", true],
    [13, "insufficient fees", "insufficient-fee", true],
    [19, "tx already exists in cache", "already-in-mempool", false],
    [30, "tx timeout height", "tx-timeout", true],
    [32, "account sequence mismatch, expected 8, got 7", "sequence-mismatch", true],
  ];
  for (const [code, log, kind, retryable] of cases) {
    const failure = classifyTxFailure(code, log, "sdk");
    assert.equal(failure?.kind, kind, log);
    assert.equal(failure?.retryable, retryable, log);
    assert.ok((failure?.message.length ?? 0) > 0, log);
  }

  assert.equal(
    classifyTxFailure(32, "account sequence mismatch, expected 8, got 7")
      ?.expectedSequence,
    "8",
  );
});

test("classifyTxFailure does not read sdk codes in another codespace", () => {
  // Code 5 in the wasm codespace is not "insufficient funds".
  const wasm = classifyTxFailure(5, "Error parsing into type …: unknown field", "wasm");
  assert.equal(wasm?.kind, "unknown");
  assert.equal(wasm?.codespace, "wasm");

  // The log is still consulted, so a wrapped SDK error is recovered.
  const wrapped = classifyTxFailure(5, "insufficient funds for fee", "wasm");
  assert.equal(wrapped?.kind, "insufficient-funds");
});

/* -------------------------------------------------------------------------- *
 * getTxStatus / waitForTx
 * -------------------------------------------------------------------------- */

test("getTxStatus distinguishes included, pending and not-found", async () => {
  const included = await getTxStatus(
    stubClient([
      {
        tx_response: {
          height: "18042311",
          txhash: HASH,
          code: 0,
          raw_log: "",
          timestamp: "2026-09-06T09:15:00Z",
          gas_used: "91175",
          gas_wanted: "127645",
        },
      },
    ]),
    CHAIN_ID,
    HASH,
  );
  assert.equal(included.state, "success");
  assert.equal(included.height, "18042311");
  assert.equal(included.timestamp, "2026-09-06T09:15:00Z");

  const pending = await getTxStatus(
    stubClient([{ tx_response: { height: "0", txhash: HASH, code: 0 } }]),
    CHAIN_ID,
    HASH,
  );
  assert.equal(pending.state, "pending");
  assert.equal(pending.code, null);

  for (const answer of [
    () => httpError(404),
    () => httpError(500, `tx (${HASH}) not found`),
    { code: 5, message: "tx not found" },
  ] as const) {
    const missing = await getTxStatus(stubClient([answer]), CHAIN_ID, HASH);
    assert.equal(missing.state, "not-found");
    assert.equal(missing.code, null);
  }
});

test("getTxStatus reports a failure with its code, not as not-found", async () => {
  const status = await getTxStatus(
    stubClient([
      {
        tx_response: {
          height: "18042311",
          txhash: HASH,
          code: 11,
          raw_log: "out of gas",
        },
      },
    ]),
    CHAIN_ID,
    HASH,
  );
  assert.equal(status.state, "failed");
  assert.equal(status.code, 11);
  assert.equal(status.rawLog, "out of gas");
});

test("getTxStatus uppercases the hash and refuses a non-hash", async () => {
  const lcd = stubClient([{ tx_response: { height: "1", txhash: HASH } }]);
  await getTxStatus(lcd, CHAIN_ID, HASH.toLowerCase());
  assert.equal(lcd.calls[0]?.path, `/cosmos/tx/v1beta1/txs/${HASH}`);

  for (const bad of ["", "../../accounts", `${HASH}00`, "zz"]) {
    await rejects(
      () => getTxStatus(stubClient([{}]), CHAIN_ID, bad),
      "malformed-response",
    );
  }
});

test("waitForTx polls with backoff until the tx is included", async () => {
  const notFound = () => httpError(404);
  const lcd = stubClient([
    notFound,
    notFound,
    { tx_response: { height: "42", txhash: HASH, code: 0, raw_log: "" } },
  ]);
  const slept: number[] = [];
  let clock = 0;

  const status = await waitForTx(lcd, CHAIN_ID, HASH, {
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    pollIntervalMs: 1000,
    backoffFactor: 2,
    maxPollIntervalMs: 1500,
    deadlineMs: 60_000,
  });

  assert.equal(status.state, "success");
  assert.deepEqual(slept, [1000, 1500]);
});

test("waitForTx returns what it knows when the deadline passes", async () => {
  const lcd = stubClient(Array.from({ length: 8 }, () => () => httpError(404)));
  let clock = 0;
  const status = await waitForTx(lcd, CHAIN_ID, HASH, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    pollIntervalMs: 1000,
    backoffFactor: 1,
    deadlineMs: 3000,
  });
  // Not an error: the tx may still land, and the caller keeps the hash on screen.
  assert.equal(status.state, "not-found");
  assert.equal(status.txHash, HASH);
});

test("waitForTx keeps polling through a flaky endpoint", async () => {
  const lcd = stubClient([
    () => httpError(503),
    () => new InterchainError("malformed-response", "html", { chainId: CHAIN_ID }),
    { tx_response: { height: "9", txhash: HASH, code: 0 } },
  ]);
  let clock = 0;
  const status = await waitForTx(lcd, CHAIN_ID, HASH, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    pollIntervalMs: 10,
    deadlineMs: 10_000,
  });
  assert.equal(status.state, "success");
});

test("waitForTx surfaces a privacy gate and honours an abort", async () => {
  await rejects(
    () =>
      waitForTx(
        stubClient([
          () => new InterchainError("reads-disabled", "off", { chainId: CHAIN_ID }),
        ]),
        CHAIN_ID,
        HASH,
        { sleep: async () => {}, deadlineMs: 1000 },
      ),
    "reads-disabled",
  );

  const controller = new AbortController();
  controller.abort();
  await rejects(
    () =>
      waitForTx(stubClient([{}]), CHAIN_ID, HASH, {
        signal: controller.signal,
        sleep: async () => {},
      }),
    "aborted",
  );
});

test("waitForTx rejects a bad hash immediately rather than at the deadline", async () => {
  await rejects(
    () =>
      waitForTx(stubClient([]), CHAIN_ID, "not-a-hash", {
        sleep: async () => {
          throw new Error("should not have polled");
        },
      }),
    "malformed-response",
  );
});

/* -------------------------------------------------------------------------- *
 * createLcdPostClient
 * -------------------------------------------------------------------------- */

function fetchStub(
  handlers: ReadonlyArray<(url: string, init: RequestInit) => Promise<Response>>,
): { readonly urls: string[]; readonly fetchImpl: FetchLike } {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const handler = handlers[urls.length];
    urls.push(url);
    if (!handler) throw new Error(`unexpected POST #${urls.length}: ${url}`);
    return handler(url, init);
  };
  return { urls, fetchImpl };
}

const READ_ONLY: LcdClient = {
  chainId: CHAIN_ID,
  getJson: async () => ({}),
};

test("createLcdPostClient sends JSON and parses the reply", async () => {
  let seen: RequestInit | undefined;
  const stub = fetchStub([
    async (_url, init) => {
      seen = init;
      return new Response(JSON.stringify({ gas_info: { gas_used: "5" } }), {
        status: 200,
      });
    },
  ]);
  const client = createLcdPostClient({
    client: READ_ONLY,
    // The trailing slash must not survive into the path.
    endpoints: ["https://a.example/"],
    fetchImpl: stub.fetchImpl,
  });

  assert.equal(isLcdPostClient(client), true);
  assert.equal(isLcdPostClient(READ_ONLY), false);

  const gas = await simulate(client, CHAIN_ID, "AA==");
  assert.equal(gas, "5");
  assert.deepEqual(stub.urls, ["https://a.example/cosmos/tx/v1beta1/simulate"]);
  assert.equal(seen?.method, "POST");
  assert.equal(seen?.credentials, "omit");
  assert.equal(seen?.body, JSON.stringify({ tx_bytes: "AA==" }));
});

test("createLcdPostClient falls back on 5xx but stops on a definitive 4xx", async () => {
  const good = fetchStub([
    async () => new Response("{}", { status: 502 }),
    async () => new Response(JSON.stringify(txResponse()), { status: 200 }),
  ]);
  const ok = await broadcast(
    createLcdPostClient({
      client: READ_ONLY,
      endpoints: ["https://a.example", "https://b.example"],
      fetchImpl: good.fetchImpl,
    }),
    CHAIN_ID,
    "AA==",
  );
  assert.equal(ok.txHash, HASH);
  assert.equal(good.urls.length, 2);

  // A 400 is the chain answering "no"; a second endpoint answers the same.
  const bad = fetchStub([
    async () =>
      new Response(JSON.stringify({ code: 3, message: "out of gas" }), {
        status: 400,
      }),
  ]);
  const error = await rejects(
    () =>
      simulate(
        createLcdPostClient({
          client: READ_ONLY,
          endpoints: ["https://a.example", "https://b.example"],
          fetchImpl: bad.fetchImpl,
        }),
        CHAIN_ID,
        "AA==",
      ),
    "tx-rejected",
  );
  assert.ok(isTxRejectedError(error) && error.failure.kind === "out-of-gas");
  assert.equal(bad.urls.length, 1);
});

test("createLcdPostClient reports a non-JSON body as malformed", async () => {
  const stub = fetchStub([
    async () => new Response("<html>gateway</html>", { status: 200 }),
  ]);
  await rejects(
    () =>
      simulate(
        createLcdPostClient({
          client: READ_ONLY,
          endpoints: ["https://a.example"],
          fetchImpl: stub.fetchImpl,
        }),
        CHAIN_ID,
        "AA==",
      ),
    "malformed-response",
  );
});

test("createLcdPostClient needs at least one endpoint", () => {
  throws(
    () =>
      createLcdPostClient({
        client: READ_ONLY,
        endpoints: ["", "   "],
        fetchImpl: fetchStub([]).fetchImpl,
      }),
    "unsupported-chain",
  );
});

/* -------------------------------------------------------------------------- *
 * buildUnsignedTxRequest
 * -------------------------------------------------------------------------- */

const PUBLIC_KEY_HEX =
  "024f4e2ad99c34d60b9ba6283c9431a8418af8673212961f97a77b6377fcd05b62";

const ACCOUNT: AccountInfo = {
  address: ADDRESS,
  accountNumber: "12345",
  sequence: "7",
  pubKey: { typeUrl: "/cosmos.crypto.secp256k1.PubKey", key: PUB_KEY.key },
};

const FEE: FeeEstimate = {
  amount: [{ denom: "usafro", amount: "3192" }],
  gasLimit: "127645",
  gasPrice: 0.025,
};

const SEND: BuiltMsg = {
  typeUrl: "/cosmos.bank.v1beta1.MsgSend",
  value: {
    from_address: ADDRESS,
    to_address: ADDRESS,
    amount: [{ denom: "usafro", amount: "1000000" }],
  },
};

test("buildUnsignedTxRequest matches the Rust UnsignedTx/SignerData/Fee fields", () => {
  const request = buildUnsignedTxRequest({
    chainId: CHAIN_ID,
    account: ACCOUNT,
    publicKeyHex: `0x${PUBLIC_KEY_HEX.toUpperCase()}`,
    msgs: [SEND],
    fee: FEE,
    memo: "hello",
  });

  assert.deepEqual(request, {
    sign_mode: "direct",
    signer: {
      chain_id: CHAIN_ID,
      account_number: "12345",
      sequence: "7",
      public_key: PUBLIC_KEY_HEX,
      eth_key_type: false,
    },
    tx: {
      msgs: [{ type_url: "/cosmos.bank.v1beta1.MsgSend", value: SEND.value }],
      fee: {
        amount: [{ denom: "usafro", amount: "3192" }],
        gas_limit: "127645",
        payer: "",
        granter: "",
      },
      memo: "hello",
      timeout_height: "0",
    },
  });
  // The payload has to survive a round trip; nothing in it is a class instance.
  assert.deepEqual(JSON.parse(JSON.stringify(request)), request);
});

test("buildUnsignedTxRequest carries an ibc-hooks memo and a wasm execute unchanged", () => {
  // The memo the router builds must reach the kernel byte for byte: the wasm
  // middleware requires the object to hold exactly `contract` and `msg`.
  const memo = JSON.stringify({
    wasm: {
      contract: "osmo1contract",
      msg: { osmosis_swap: { output_denom: "uosmo" } },
    },
  });
  const request = buildUnsignedTxRequest({
    chainId: CHAIN_ID,
    account: ACCOUNT,
    publicKeyHex: PUBLIC_KEY_HEX,
    fee: FEE,
    signMode: "amino",
    timeoutHeight: "18100000",
    msgs: [
      {
        typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
        value: {
          source_port: "transfer",
          source_channel: "channel-0",
          token: { denom: "usafro", amount: "1000000" },
          sender: ADDRESS,
          receiver: "osmo1contract",
          timeout_height: { revision_number: "0", revision_height: "0" },
          timeout_timestamp: "1780000000000000000",
          memo,
        },
      },
      {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: {
          sender: ADDRESS,
          contract: "addr_safro1contract",
          // proto-JSON encodes `bytes` as base64, which is what Msg::msg wants.
          msg: jsonToBase64({ transfer_nft: { recipient: ADDRESS, token_id: "1" } }),
          funds: [],
        },
      },
    ],
  });

  assert.equal(request.sign_mode, "amino");
  assert.equal(request.tx.timeout_height, "18100000");
  assert.equal(request.tx.msgs[0]?.value["memo"], memo);
  assert.equal(
    request.tx.msgs[1]?.value["msg"],
    encodeBase64Utf8('{"transfer_nft":{"recipient":"' + ADDRESS + '","token_id":"1"}}'),
  );
});

test("buildUnsignedTxRequest defaults eth_key_type from the account's key", () => {
  const eth = buildUnsignedTxRequest({
    chainId: "evmos_9001-2",
    account: {
      ...ACCOUNT,
      pubKey: {
        typeUrl: "/ethermint.crypto.v1.ethsecp256k1.PubKey",
        key: PUB_KEY.key,
      },
    },
    publicKeyHex: PUBLIC_KEY_HEX,
    msgs: [SEND],
    fee: FEE,
  });
  assert.equal(eth.signer.eth_key_type, true);

  // A never-signed account reports no key, so the caller must say so.
  const fresh = buildUnsignedTxRequest({
    chainId: "evmos_9001-2",
    account: { ...ACCOUNT, pubKey: null },
    publicKeyHex: PUBLIC_KEY_HEX,
    msgs: [SEND],
    fee: FEE,
    ethKeyType: true,
  });
  assert.equal(fresh.signer.eth_key_type, true);
});

test("buildUnsignedTxRequest counts the memo limit in bytes, not characters", () => {
  const base = {
    chainId: CHAIN_ID,
    account: ACCOUNT,
    publicKeyHex: PUBLIC_KEY_HEX,
    msgs: [SEND],
    fee: FEE,
  };
  assert.equal(
    buildUnsignedTxRequest({ ...base, memo: "a".repeat(256) }).tx.memo.length,
    256,
  );
  throws(
    () => buildUnsignedTxRequest({ ...base, memo: "a".repeat(257) }),
    "invalid-memo",
  );
  // 64 four-byte emoji is 256 bytes; one more overflows even though the string
  // is far shorter than 256 characters.
  throws(
    () => buildUnsignedTxRequest({ ...base, memo: "🙂".repeat(65) }),
    "invalid-memo",
  );
  assert.equal(
    buildUnsignedTxRequest({ ...base, memo: "🙂".repeat(64) }).tx.memo.length,
    128,
  );
});

test("buildUnsignedTxRequest refuses input the kernel would refuse", () => {
  const base = {
    chainId: CHAIN_ID,
    account: ACCOUNT,
    publicKeyHex: PUBLIC_KEY_HEX,
    msgs: [SEND],
    fee: FEE,
  };
  throws(() => buildUnsignedTxRequest({ ...base, chainId: "  " }), "invalid-request");
  throws(() => buildUnsignedTxRequest({ ...base, msgs: [] }), "invalid-request");
  throws(
    () => buildUnsignedTxRequest({ ...base, fee: { ...FEE, gasLimit: "0" } }),
    "invalid-request",
  );
  throws(
    () => buildUnsignedTxRequest({ ...base, fee: { ...FEE, gasLimit: "lots" } }),
    "invalid-request",
  );
  // Uncompressed (65 byte) and truncated keys both produce an address the chain
  // will not match to the signature.
  throws(
    () => buildUnsignedTxRequest({ ...base, publicKeyHex: `04${PUBLIC_KEY_HEX}` }),
    "invalid-request",
  );
  throws(() => buildUnsignedTxRequest({ ...base, publicKeyHex: "" }), "invalid-request");
  throws(
    () =>
      buildUnsignedTxRequest({
        ...base,
        account: { ...ACCOUNT, sequence: "seven" },
      }),
    "invalid-request",
  );
  throws(
    () =>
      buildUnsignedTxRequest({
        ...base,
        msgs: [{ typeUrl: "cosmos.bank.v1beta1.MsgSend", value: {} }],
      }),
    "invalid-request",
  );
});

test("buildUnsignedTxRequest passes a fee grant through", () => {
  const request = buildUnsignedTxRequest({
    chainId: CHAIN_ID,
    account: ACCOUNT,
    publicKeyHex: PUBLIC_KEY_HEX,
    msgs: [SEND],
    fee: { ...FEE, payer: ADDRESS, granter: ADDRESS },
  });
  assert.equal(request.tx.fee.payer, ADDRESS);
  assert.equal(request.tx.fee.granter, ADDRESS);
});
