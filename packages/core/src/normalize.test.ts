import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bytesToBase64 } from "./encoding.js";
import { ZuniaConnectError, toZuniaConnectError } from "./errors.js";
import {
  accountFromKey,
  accountFromWire,
  accountNumberToString,
  accountToWire,
  normalizeAminoResponse,
  normalizeDirectResponse,
  normalizeStdSignature,
} from "./normalize.js";
import { normalizeChainIds } from "./session.js";

const signature = {
  pub_key: { type: "tendermint/PubKeySecp256k1", value: bytesToBase64(new Uint8Array(33).fill(2)) },
  signature: bytesToBase64(new Uint8Array(64).fill(7)),
};

describe("normalize", () => {
  it("returns Uint8Array bytes and bigint account numbers whatever the wallet sent", () => {
    const body = new Uint8Array([1, 2, 3]);
    const auth = new Uint8Array([4, 5]);
    const fromBytes = normalizeDirectResponse({
      signed: { bodyBytes: body, authInfoBytes: auth, chainId: "c-1", accountNumber: 7n },
      signature,
    });
    const fromBase64 = normalizeDirectResponse({
      signed: { bodyBytes: bytesToBase64(body), authInfoBytes: bytesToBase64(auth), chainId: "c-1", accountNumber: "7" },
      signature,
    });
    const fromClone = normalizeDirectResponse({
      signed: { bodyBytes: { 0: 1, 1: 2, 2: 3 }, authInfoBytes: [4, 5], chainId: "c-1", accountNumber: { low: 7, high: 0, toString: () => "7" } },
      signature,
    });
    for (const result of [fromBytes, fromBase64, fromClone]) {
      assert.deepEqual(result.signed.bodyBytes, body);
      assert.deepEqual(result.signed.authInfoBytes, auth);
      assert.equal(result.signed.accountNumber, 7n);
      assert.deepEqual(result.signature, signature);
    }
  });

  it("falls back to the request when the wallet omits the signed doc", () => {
    const request = { bodyBytes: new Uint8Array([9]), authInfoBytes: new Uint8Array([8]), chainId: "c-2", accountNumber: 3n };
    const result = normalizeDirectResponse({ signature }, request);
    assert.deepEqual(result.signed.bodyBytes, request.bodyBytes);
    assert.equal(result.signed.accountNumber, 3n);
    const doc = { chain_id: "c-2", account_number: "3", sequence: "1", fee: { amount: [], gas: "1" }, msgs: [], memo: "" };
    assert.deepEqual(normalizeAminoResponse({ signature }, doc).signed, doc);
  });

  it("encodes binary signatures as base64", () => {
    const result = normalizeStdSignature({
      pub_key: { type: "tendermint/PubKeySecp256k1", value: new Uint8Array(33).fill(2) },
      signature: new Uint8Array(64).fill(7),
    });
    assert.deepEqual(result, signature);
    assert.throws(() => normalizeStdSignature(null));
  });

  it("round-trips accounts over the wire", () => {
    const account = accountFromKey("cosmoshub-4", {
      name: "Main",
      algo: "secp256k1",
      pubKey: new Uint8Array(33).fill(3),
      address: new Uint8Array(20),
      bech32Address: "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu",
    });
    assert.deepEqual(accountFromWire(accountToWire(account)), account);
    assert.equal(accountNumberToString(12n), "12");
    assert.throws(() => accountNumberToString("-1"));
  });

  it("dedupes chain ids", () => {
    assert.deepEqual(normalizeChainIds(["a", " a", "b", ""]), ["a", "b"]);
    assert.deepEqual(normalizeChainIds("a"), ["a"]);
  });
});

describe("toZuniaConnectError", () => {
  it("keeps wallet codes and maps Keplr messages", () => {
    const coded = Object.assign(new Error("Wallet is locked"), { code: "LOCKED" });
    assert.equal(toZuniaConnectError(coded).code, "LOCKED");
    assert.equal(toZuniaConnectError(new Error("Request rejected")).code, "USER_REJECTED");
    assert.equal(toZuniaConnectError(new Error("Not authorized")).code, "NOT_CONNECTED");
    assert.equal(toZuniaConnectError("boom").code, "INTERNAL");
    const existing = new ZuniaConnectError("TIMEOUT", "late");
    assert.equal(toZuniaConnectError(existing), existing);
  });
});
