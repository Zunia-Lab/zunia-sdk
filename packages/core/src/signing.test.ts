import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToBase64, utf8ToBytes } from "./encoding.js";
import { explainZuniaError, toZuniaConnectError } from "./errors.js";
import { ZUNIA_SIGNING_FEATURES, aminoNeedsEscaping, zuniaCapabilities, zuniaSignMode, type SignableMessage } from "./signing.js";
import type { StdSignDoc } from "./types.js";
import { checkAminoSignature, serializeAminoSignDoc } from "./verify.js";

const OSMO = "osmo1qx8te2rzsdyj47q2hswzclqc52gp9nju8ltgjy";
// The Osmosis crosschain-swaps contract: 32 bytes, like every wasmd contract.
const XCS = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";

const send: SignableMessage = {
  typeUrl: "/cosmos.bank.v1beta1.MsgSend",
  value: { fromAddress: OSMO, toAddress: OSMO, amount: [{ denom: "uosmo", amount: "1" }] },
};
/** A payment to a contract (or an interchain account): 32 bytes. */
const send32: SignableMessage = {
  typeUrl: "/cosmos.bank.v1beta1.MsgSend",
  value: { fromAddress: OSMO, toAddress: XCS, amount: [{ denom: "uosmo", amount: "1" }] },
};
/** The same in `@zunialab/interchain` BuiltMsg spelling. */
const builtSend32: SignableMessage = {
  typeUrl: "/cosmos.bank.v1beta1.MsgSend",
  value: { from_address: OSMO, to_address: XCS, amount: [{ denom: "uosmo", amount: "1" }] },
};
/** What extension 0.1.5 reports in `window.zunia.features`, E3 included. */
const P1_FEATURES = [
  "sign-direct:wasm-contract-32",
  "sign-direct:send-32",
  "sign-direct:osmosis-poolmanager",
  "sign-direct:osmosis-exact-out",
  "sign-amino:escaped",
  "sign-amino:osmosis-poolmanager",
];
/** CosmJS shape: the body is bytes. */
const contract = (body: object): SignableMessage => ({
  typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
  value: { sender: OSMO, contract: XCS, msg: utf8ToBytes(JSON.stringify(body)), funds: [] },
});
/** `@zunialab/interchain` BuiltMsg shape: proto-JSON, the body is base64. */
const builtContract = (body: object): SignableMessage => ({
  typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
  value: { sender: OSMO, contract: XCS, msg: bytesToBase64(utf8ToBytes(JSON.stringify(body))), funds: [] },
});
const poolSwap: SignableMessage = {
  typeUrl: "/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn",
  value: { sender: OSMO, routes: [{ poolId: 1n, tokenOutDenom: "uion" }], tokenIn: { denom: "uosmo", amount: "1000" }, tokenOutMinAmount: "1" },
};
const recover = contract({ recover: {} });
const nftAmp = contract({ transfer_nft: { recipient: OSMO, token_id: "rock & roll" } });

const LEGACY = zuniaCapabilities({ version: "0.1.0" });
const FIXED = zuniaCapabilities({ version: "0.1.0", extensionVersion: "0.1.5" });

describe("zuniaCapabilities", () => {
  it("cannot tell 0.1.0 to 0.1.4 apart, and assumes their gaps", () => {
    assert.deepEqual(LEGACY, {
      extensionVersion: null,
      directContractCalls: false,
      directSends32: false,
      directPoolmanager: null,
      directExactOut: false,
      aminoEscaping: false,
      aminoPoolmanager: false,
    });
    assert.deepEqual(zuniaCapabilities(undefined), LEGACY);
    assert.deepEqual(zuniaCapabilities({ version: "test" }), LEGACY);
  });

  it("trusts 0.1.5+, by extensionVersion or by a release version, and explicit features over both", () => {
    assert.deepEqual(FIXED, {
      extensionVersion: "0.1.5",
      directContractCalls: true,
      directSends32: true,
      directPoolmanager: true,
      directExactOut: true,
      aminoEscaping: true,
      // Optional in 0.1.5: without a features list nothing says it shipped.
      aminoPoolmanager: false,
    });
    assert.equal(zuniaCapabilities({ version: "0.1.6" }).directContractCalls, true);
    assert.equal(zuniaCapabilities({ version: "0.1.4" }).directContractCalls, false);
    const partial = zuniaCapabilities({ version: "0.1.0", extensionVersion: "0.1.5", features: [ZUNIA_SIGNING_FEATURES.aminoEscaping] });
    assert.deepEqual(partial, {
      extensionVersion: "0.1.5",
      directContractCalls: false,
      directSends32: false,
      directPoolmanager: false,
      directExactOut: false,
      aminoEscaping: true,
      aminoPoolmanager: false,
    });
  });

  it("reads the whole features list 0.1.5 reports, frozen as the extension hands it over", () => {
    assert.deepEqual(Object.values(ZUNIA_SIGNING_FEATURES).sort(), [...P1_FEATURES].sort());
    const reported = zuniaCapabilities({ version: "0.1.0", extensionVersion: "0.1.5", features: Object.freeze([...P1_FEATURES]) });
    assert.deepEqual(reported, {
      extensionVersion: "0.1.5",
      directContractCalls: true,
      directSends32: true,
      directPoolmanager: true,
      directExactOut: true,
      aminoEscaping: true,
      aminoPoolmanager: true,
    });
    // Without E3 the extension leaves the Amino poolmanager string out.
    const withoutE3 = zuniaCapabilities({ version: "0.1.0", extensionVersion: "0.1.5", features: P1_FEATURES.slice(0, 5) });
    assert.deepEqual(withoutE3, { ...reported, aminoPoolmanager: false });
  });

  it("goes by the features when 0.1.5 could not read its own version", () => {
    const blank = zuniaCapabilities({ version: "0.1.0", extensionVersion: "", features: P1_FEATURES });
    assert.equal(blank.extensionVersion, null);
    assert.equal(blank.directContractCalls, true);
    assert.equal(zuniaSignMode({ messages: [recover], capabilities: blank }), "direct");
    // No features and no version: legacy.
    assert.deepEqual(zuniaCapabilities({ version: "0.1.0", extensionVersion: "" }), LEGACY);
  });
});

describe("aminoNeedsEscaping", () => {
  it("finds & < > in the memo and in free text, whatever the message shape", () => {
    assert.equal(aminoNeedsEscaping([send]), false);
    assert.equal(aminoNeedsEscaping([send], ""), false);
    assert.equal(aminoNeedsEscaping([send], "rent & food"), true);
    assert.equal(aminoNeedsEscaping([send], "1 < 2"), true);
    assert.equal(aminoNeedsEscaping([send], "2 > 1"), true);
    assert.equal(aminoNeedsEscaping([send], "Swap OSMO to USDC.n · by Zunia-wallet"), false);
    assert.equal(aminoNeedsEscaping([recover]), false);
    assert.equal(aminoNeedsEscaping([nftAmp]), true, "bytes body");
    assert.equal(aminoNeedsEscaping([builtContract({ transfer_nft: { token_id: "a<b" } })]), true, "base64 body");
    assert.equal(aminoNeedsEscaping([{ typeUrl: "/ibc.applications.transfer.v1.MsgTransfer", value: { memo: "x>y" } }]), true);
  });

  it("also finds the two line separators the chain escapes and Zunia 0.1.4 does not", () => {
    // Built from code points: raw U+2028/U+2029 are line terminators in source.
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);
    assert.equal(aminoNeedsEscaping([send], `rent${lineSeparator}food`), true, "memo, U+2028");
    assert.equal(aminoNeedsEscaping([send], `rent${paragraphSeparator}food`), true, "memo, U+2029");
    assert.equal(aminoNeedsEscaping([builtContract({ transfer_nft: { token_id: `a${lineSeparator}b` } })]), true, "base64 body");
    assert.equal(
      aminoNeedsEscaping([{ typeUrl: "/ibc.applications.transfer.v1.MsgTransfer", value: { memo: `x${paragraphSeparator}y` } }]),
      true,
    );
    // The dashboard keeps the same rule (src/lib/tx/sign-mode.ts AMINO_ESCAPED).
    assert.equal(aminoNeedsEscaping([send], "plain memo"), false);
  });
});

describe("zuniaSignMode", () => {
  const rows: Array<[string, SignableMessage[], string | undefined, "direct" | "amino", "direct" | "amino"]> = [
    // name, messages, memo, legacy (0.1.0-0.1.4), fixed (0.1.5+)
    ["send", [send], undefined, "direct", "direct"],
    ["send, memo with &", [send], "rent & food", "direct", "direct"],
    ["contract call (swap recovery)", [recover], "Recover", "amino", "direct"],
    ["contract call + fee send", [contract({ osmosis_swap: { output_denom: "uatom" } }), send], undefined, "amino", "direct"],
    ["contract call, memo with &", [recover], "a & b", "direct", "direct"],
    ["contract call, & in its body", [nftAmp], undefined, "direct", "direct"],
    ["poolmanager", [poolSwap], undefined, "direct", "direct"],
    ["poolmanager + contract call", [poolSwap, recover], undefined, "direct", "direct"],
    ["send to a 32-byte address", [send32], undefined, "amino", "direct"],
    ["send to a 32-byte address, BuiltMsg spelling", [builtSend32], "Pay the treasury", "amino", "direct"],
    ["send to a 32-byte address, memo with &", [send32], "rent & food", "direct", "direct"],
    ["send to a 32-byte address + send", [send, send32], undefined, "amino", "direct"],
    ["send to an address that is not bech32", [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { toAddress: "osmo1nope" } }], undefined, "direct", "direct"],
  ];
  for (const [name, messages, memo, legacy, fixed] of rows) {
    it(name, () => {
      assert.equal(zuniaSignMode({ messages, memo, capabilities: LEGACY }), legacy, "0.1.4 and older");
      assert.equal(zuniaSignMode({ messages, memo }), legacy, "nothing reported means 0.1.4 and older");
      assert.equal(zuniaSignMode({ messages, memo, capabilities: FIXED }), fixed, "0.1.5+");
    });
  }

  it("keeps Ethereum-key chains direct (their contracts are 20 bytes; Amino is refused there)", () => {
    assert.equal(zuniaSignMode({ messages: [recover], capabilities: LEGACY, ethKeyChain: true }), "direct");
  });

  it("signs a send to a 32-byte address direct on a build that reports only that fix", () => {
    const sends32 = zuniaCapabilities({ version: "0.1.0", extensionVersion: "0.1.5", features: [ZUNIA_SIGNING_FEATURES.directSends32] });
    assert.equal(zuniaSignMode({ messages: [send32], capabilities: sends32 }), "direct");
    assert.equal(zuniaSignMode({ messages: [recover], capabilities: sends32 }), "amino");
  });
});

describe("checkAminoSignature", () => {
  const secret = sha256(utf8ToBytes("check amino"));
  const pubKey = secp256k1.getPublicKey(secret, true);
  const doc = (memo: string): StdSignDoc => ({
    chain_id: "osmosis-1",
    account_number: "7",
    sequence: "3",
    fee: { amount: [{ denom: "uosmo", amount: "5000" }], gas: "200000" },
    msgs: [{ type: "cosmos-sdk/MsgSend", value: { from_address: OSMO, to_address: OSMO, amount: [{ denom: "uosmo", amount: "1" }] } }],
    memo,
  });
  const sortKeys = (value: unknown): unknown =>
    value === null || typeof value !== "object"
      ? value
      : Array.isArray(value)
        ? value.map(sortKeys)
        : Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  const sign = (bytes: Uint8Array) => ({
    pub_key: { type: "tendermint/PubKeySecp256k1", value: bytesToBase64(pubKey) },
    signature: bytesToBase64(secp256k1.sign(sha256(bytes), secret, { prehash: false })),
  });

  it("pins the chain's bytes: & < > written \\u0026 \\u003c \\u003e", () => {
    const text = new TextDecoder().decode(serializeAminoSignDoc({ memo: "a & <b>" }));
    assert.equal(text, '{"memo":"a \\u0026 \\u003cb\\u003e"}');
  });

  it("tells a chain-valid signature from one over unescaped bytes (Zunia 0.1.4 and older)", () => {
    assert.equal(checkAminoSignature(doc("rent & food"), sign(serializeAminoSignDoc(doc("rent & food")))), "valid");
    const unescaped = utf8ToBytes(JSON.stringify(sortKeys(doc("rent & food"))));
    assert.equal(checkAminoSignature(doc("rent & food"), sign(unescaped)), "unescaped");
    // Without & < > both encodings are the same bytes: nothing to report.
    assert.equal(checkAminoSignature(doc("rent and food"), sign(utf8ToBytes(JSON.stringify(sortKeys(doc("rent and food")))))), "valid");
    assert.equal(checkAminoSignature(doc("x"), sign(utf8ToBytes("something else"))), "invalid");
    assert.equal(checkAminoSignature(doc("x"), { pub_key: { type: "ethermint/PubKeyEthSecp256k1", value: bytesToBase64(pubKey) }, signature: "AA==" }), "unchecked");
  });
});

describe("wallet errors", () => {
  const providerError = (code: string, message: string) => Object.assign(new Error(message), { code });

  it("maps an expired prompt to TIMEOUT and a stale page to DISCONNECTED", () => {
    const expired = toZuniaConnectError(providerError("USER_REJECTED", "Request expired before it was answered"));
    assert.equal(expired.code, "TIMEOUT");
    assert.equal(expired.reason, "prompt-expired");
    const stale = toZuniaConnectError(new Error("Extension context invalidated."));
    assert.equal(stale.code, "DISCONNECTED");
    assert.equal(stale.reason, "stale-page");
    assert.equal(toZuniaConnectError(providerError("INTERNAL", "Zunia provider handshake timed out")).code, "DISCONNECTED");
    // Unchanged: a real rejection, Keplr's words, a lock.
    assert.equal(toZuniaConnectError(providerError("USER_REJECTED", "Request rejected")).code, "USER_REJECTED");
    assert.equal(toZuniaConnectError(new Error("Request rejected")).code, "USER_REJECTED");
    assert.equal(toZuniaConnectError(providerError("LOCKED", "Zunia stayed locked, so the request was cancelled")).code, "LOCKED");
  });

  it("explains each refusal with a next step, keeping the wallet's words as the detail", () => {
    const blind = explainZuniaError(providerError("UNSUPPORTED", "Blind signing disabled for unknown messages"));
    assert.equal(blind.code, "UNSUPPORTED");
    assert.equal(blind.reason, "blind-signing");
    assert.match(blind.message, /Update Zunia/);
    assert.equal(blind.detail, "Blind signing disabled for unknown messages");
    assert.match(explainZuniaError(providerError("LOCKED", "Wallet locked")).message, /Unlock it/);
    assert.match(explainZuniaError(new Error("Extension context invalidated.")).message, /Reload this page/);
    assert.equal(explainZuniaError(providerError("USER_REJECTED", "Request rejected")).title, "Declined");
    assert.equal(explainZuniaError("weird").code, "INTERNAL");
  });
});
