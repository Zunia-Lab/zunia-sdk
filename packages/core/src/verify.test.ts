import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Secp256k1HdWallet, makeSignDoc, serializeSignDoc } from "@cosmjs/amino";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToBase64, utf8ToBytes } from "./encoding.js";
import { ZuniaSignInError } from "./errors.js";
import { buildSignInMessage } from "./sign-in.js";
import type { StdSignature } from "./types.js";
import {
  adr36SignDoc,
  checkAminoSignature,
  pubkeyToAddress,
  serializeAminoSignDoc,
  verifyAdr36Signature,
  verifySignIn,
  type VerifySignInOptions,
} from "./verify.js";

const secretKey = sha256(utf8ToBytes("zunia sign-in test key"));
const pubKey = secp256k1.getPublicKey(secretKey, true);
const address = pubkeyToAddress(pubKey, "cosmos");
const now = Date.parse("2026-09-24T10:01:00.000Z");

function sign(text: string, key = secretKey, signer = address): StdSignature {
  const digest = sha256(serializeAminoSignDoc(adr36SignDoc(signer, utf8ToBytes(text))));
  const signature = secp256k1.sign(digest, key, { prehash: false });
  return {
    pub_key: { type: "tendermint/PubKeySecp256k1", value: bytesToBase64(secp256k1.getPublicKey(key, true)) },
    signature: bytesToBase64(signature),
  };
}

function message(overrides: Record<string, unknown> = {}): string {
  return buildSignInMessage({
    domain: "app.example.com",
    address,
    statement: "Sign in to Example.",
    uri: "https://app.example.com/login",
    chainId: "cosmoshub-4",
    nonce: "a1b2c3d4e5f6a7b8",
    issuedAt: "2026-09-24T10:00:00.000Z",
    expirationTime: "2026-09-24T10:10:00.000Z",
    ...overrides,
  });
}

function options(text = message(), extra: Partial<VerifySignInOptions> = {}): VerifySignInOptions {
  return { message: text, signature: sign(text), domain: "app.example.com", nonce: "a1b2c3d4e5f6a7b8", now, ...extra };
}

function refusal(opts: VerifySignInOptions): string {
  try {
    verifySignIn(opts);
    return "ok";
  } catch (error) {
    assert.ok(error instanceof ZuniaSignInError, String(error));
    return error.code;
  }
}

describe("ADR-036", () => {
  it("serializes the sign doc the way CosmJS does", () => {
    const doc = adr36SignDoc("cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu", utf8ToBytes("hello"));
    assert.equal(
      new TextDecoder().decode(serializeAminoSignDoc(doc)),
      '{"account_number":"0","chain_id":"","fee":{"amount":[],"gas":"0"},"memo":"","msgs":[{"type":"sign/MsgSignData","value":{"data":"aGVsbG8=","signer":"cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu"}}],"sequence":"0"}',
    );
    assert.equal(new TextDecoder().decode(serializeAminoSignDoc({ memo: "<a&b>" })), '{"memo":"\\u003ca\\u0026b\\u003e"}');
  });

  it("escapes U+2028 and U+2029 as the chain does, and leaves other text as it is", () => {
    // Go's json.Marshal writes both separators escaped in every string; CosmJS does not.
    const text = new TextDecoder().decode(serializeAminoSignDoc({ memo: "a\u2028b\u2029c · ünï 🙂 \\u2028" }));
    assert.equal(text, '{"memo":"a\\u2028b\\u2029c · ünï 🙂 \\\\u2028"}');
    assert.equal(new TextDecoder().decode(serializeAminoSignDoc({ memo: "&<>\u2028" })), '{"memo":"\\u0026\\u003c\\u003e\\u2028"}');
  });

  it("derives addresses from compressed keys", () => {
    assert.match(address, /^cosmos1[02-9ac-hj-np-z]{38}$/);
    assert.equal(pubkeyToAddress(pubKey, "osmo").startsWith("osmo1"), true);
  });

  it("verifies its own signatures and refuses high-S ones", () => {
    const text = "plain message";
    const digest = sha256(serializeAminoSignDoc(adr36SignDoc(address, utf8ToBytes(text))));
    const low = secp256k1.sign(digest, secretKey, { prehash: false });
    assert.equal(verifyAdr36Signature({ signer: address, data: text, pubKey, signature: low }), true);
    const parsed = secp256k1.Signature.fromBytes(low);
    const high = new secp256k1.Signature(parsed.r, secp256k1.Point.CURVE().n - parsed.s).toBytes();
    assert.equal(verifyAdr36Signature({ signer: address, data: text, pubKey, signature: high }), false);
  });
});

describe("verifySignIn", () => {
  it("returns the proven address", () => {
    const result = verifySignIn(options(message(), { chainId: ["cosmoshub-4", "osmosis-1"], address }));
    assert.equal(result.address, address);
    assert.equal(result.chainId, "cosmoshub-4");
    assert.equal(result.domain, "app.example.com");
    assert.deepEqual(result.pubKey, pubKey);
  });

  it("refuses each broken rule with its own code", () => {
    const other = sha256(utf8ToBytes("another key"));
    const otherAddress = pubkeyToAddress(secp256k1.getPublicKey(other, true), "cosmos");
    const text = message();
    const cases: Array<[string, VerifySignInOptions]> = [
      ["INVALID_MESSAGE", { ...options(), message: "hello" }],
      ["DOMAIN_MISMATCH", options(text, { domain: "evil.example" })],
      ["URI_MISMATCH", options(message({ uri: "https://evil.example/login" }))],
      ["NONCE_MISMATCH", options(text, { nonce: "0000000000000000" })],
      ["CHAIN_MISMATCH", options(text, { chainId: "osmosis-1" })],
      ["ADDRESS_MISMATCH", options(text, { address: otherAddress })],
      ["ISSUED_IN_FUTURE", options(message({ issuedAt: "2026-09-24T10:30:00.000Z", expirationTime: undefined }))],
      ["TOO_OLD", options(message({ issuedAt: "2026-09-24T09:00:00.000Z", expirationTime: undefined }))],
      ["EXPIRED", options(text, { now: Date.parse("2026-09-24T10:10:00.000Z") })],
      ["NOT_YET_VALID", options(message({ notBefore: "2026-09-24T10:09:00.000Z" }))],
      [
        "UNSUPPORTED_KEY",
        { ...options(), signature: { ...sign(text), pub_key: { type: "ethermint/PubKeyEthSecp256k1", value: bytesToBase64(pubKey) } } },
      ],
      ["KEY_MISMATCH", { ...options(), signature: sign(text, other) }],
      ["INVALID_SIGNATURE", { ...options(), signature: { ...sign(text), signature: sign(`${text} `).signature } }],
    ];
    for (const [code, opts] of cases) assert.equal(refusal(opts), code, code);
  });

  it("refuses a signature over another message", () => {
    const signed = message();
    const shown = message({ statement: "Something else." });
    assert.equal(refusal({ ...options(shown), signature: sign(signed) }), "INVALID_SIGNATURE");
  });
});

describe("checkAminoSignature against CosmJS", () => {
  // The public BIP39 test phrase: nobody keeps funds behind it.
  const wallet = Secp256k1HdWallet.fromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  const fee = { amount: [{ denom: "uatom", amount: "5000" }], gas: "200000" };
  const doc = (from: string, memo: string, body = "{}") =>
    makeSignDoc(
      [
        { type: "cosmos-sdk/MsgSend", value: { from_address: from, to_address: from, amount: [{ denom: "uatom", amount: "1" }] } },
        { type: "wasm/MsgExecuteContract", value: { sender: from, contract: from, msg: JSON.parse(body), funds: [] } },
      ],
      fee,
      "cosmoshub-4",
      memo,
      7,
      3,
    );

  it("reads a CosmJS signature over a document without U+2028 or U+2029 as valid, & < > included", async () => {
    const signer = await wallet;
    const [account] = await signer.getAccounts();
    assert.ok(account);
    for (const signDoc of [doc(account.address, "rent & food <3>", '{"transfer_nft":{"token_id":"rock & roll"}}'), doc(account.address, "")]) {
      assert.deepEqual(serializeAminoSignDoc(signDoc), serializeSignDoc(signDoc), "the same bytes as CosmJS");
      const { signed, signature } = await signer.signAmino(account.address, signDoc);
      assert.equal(checkAminoSignature(signed, signature), "valid");
    }
  });

  it("reads a CosmJS signature over U+2028 as unescaped: the chain writes it \\u2028", async () => {
    const signer = await wallet;
    const [account] = await signer.getAccounts();
    assert.ok(account);
    for (const memo of ["line\u2028break", "a & b\u2029"]) {
      const { signed, signature } = await signer.signAmino(account.address, doc(account.address, memo));
      assert.equal(checkAminoSignature(signed, signature), "unescaped", JSON.stringify(memo));
    }
  });
});
