import assert from "node:assert/strict";
import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ConnectCipher,
  connectKeyPairFromSecret,
  connectTranscript,
  decryptFrame,
  deriveConnectKeys,
  encryptFrame,
  frameAad,
  generateConnectKeyPair,
  verificationCodeFrom,
} from "./connect-crypto.js";
import { base64UrlToBytes, bytesToBase64Url, utf8ToBytes } from "./encoding.js";
import { ZuniaConnectError } from "./errors.js";
import { parsePairingUri } from "./protocol.js";

interface Vectors {
  keyAgreement: Array<{
    name: string;
    sessionId: string;
    dappSecretKey: string;
    walletSecretKey: string;
    dappPublicKey: string;
    walletPublicKey: string;
    sharedSecret: string;
    transcript: string;
    dappToWallet: string;
    walletToDapp: string;
    verificationCode: string;
  }>;
  frames: Array<{
    name: string;
    sessionId: string;
    sender: "dapp" | "wallet";
    key: string;
    nonce: string;
    aad: string;
    plaintext: string;
    ciphertext: string;
  }>;
  verificationCodes: Array<{ bytes: string; code: string }>;
  pairingUris: { valid: string[]; invalid: string[] };
}

const vectors = JSON.parse(
  readFileSync(new URL("../test-vectors/connect-v2-vectors.json", import.meta.url), "utf8"),
) as Vectors;

const hex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const toHex = (value: Uint8Array) => Buffer.from(value).toString("hex");

function nodeX25519(secret: Uint8Array, peerPublic: Uint8Array): Uint8Array {
  const own = connectKeyPairFromSecret(secret).publicKey;
  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "X25519", d: bytesToBase64Url(secret), x: bytesToBase64Url(own) },
    format: "jwk",
  });
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: bytesToBase64Url(peerPublic) }, format: "jwk" });
  return new Uint8Array(diffieHellman({ privateKey, publicKey }));
}

function nodeSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  return new Uint8Array(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
}

function failsWith(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof ZuniaConnectError && error.code === code);
}

describe("connect v2 vectors", () => {
  for (const vector of vectors.keyAgreement) {
    it(`derives the same keys on both sides: ${vector.name}`, () => {
      const dapp = connectKeyPairFromSecret(hex(vector.dappSecretKey));
      const wallet = connectKeyPairFromSecret(hex(vector.walletSecretKey));
      assert.equal(bytesToBase64Url(dapp.publicKey), vector.dappPublicKey);
      assert.equal(bytesToBase64Url(wallet.publicKey), vector.walletPublicKey);
      assert.equal(toHex(connectTranscript(vector.sessionId, dapp.publicKey, wallet.publicKey)), vector.transcript);
      const fromDapp = deriveConnectKeys({ role: "dapp", sessionId: vector.sessionId, secretKey: dapp.secretKey, peerPublicKey: wallet.publicKey });
      const fromWallet = deriveConnectKeys({ role: "wallet", sessionId: vector.sessionId, secretKey: wallet.secretKey, peerPublicKey: dapp.publicKey });
      for (const keys of [fromDapp, fromWallet]) {
        assert.equal(toHex(keys.dappToWallet), vector.dappToWallet);
        assert.equal(toHex(keys.walletToDapp), vector.walletToDapp);
        assert.equal(keys.verificationCode, vector.verificationCode);
      }
    });

    it(`matches node:crypto, an independent implementation: ${vector.name}`, () => {
      const dappSecret = hex(vector.dappSecretKey);
      const walletPublic = base64UrlToBytes(vector.walletPublicKey);
      const shared = nodeX25519(dappSecret, walletPublic);
      assert.equal(toHex(shared), vector.sharedSecret);
      const salt = hex(vector.transcript);
      const expand = (info: string, length: number) =>
        toHex(new Uint8Array(hkdfSync("sha256", shared, salt, `zunia.connect.v2 ${info}`, length)));
      assert.equal(expand("dapp->wallet", 32), vector.dappToWallet);
      assert.equal(expand("wallet->dapp", 32), vector.walletToDapp);
      assert.equal(verificationCodeFrom(hex(expand("verification code", 4))), vector.verificationCode);
    });
  }

  for (const vector of vectors.frames) {
    it(`seals and opens: ${vector.name}`, () => {
      const key = hex(vector.key);
      const nonce = base64UrlToBytes(vector.nonce);
      const aad = utf8ToBytes(vector.aad);
      assert.deepEqual(aad, frameAad(vector.sessionId, vector.sender));
      const plaintext = utf8ToBytes(vector.plaintext);
      assert.equal(bytesToBase64Url(encryptFrame(key, nonce, aad, plaintext)), vector.ciphertext);
      assert.equal(bytesToBase64Url(nodeSeal(key, nonce, aad, plaintext)), vector.ciphertext);
      assert.deepEqual(decryptFrame(key, nonce, aad, base64UrlToBytes(vector.ciphertext)), plaintext);
    });
  }

  it("turns four bytes into six digits", () => {
    for (const { bytes, code } of vectors.verificationCodes) assert.equal(verificationCodeFrom(hex(bytes)), code);
  });

  it("reads pairing URIs", () => {
    for (const uri of vectors.pairingUris.valid) assert.notEqual(parsePairingUri(uri), null, uri);
    for (const uri of vectors.pairingUris.invalid) assert.equal(parsePairingUri(uri), null, uri);
    const link = vectors.pairingUris.valid[0]!.replace("zunia://connect", "https://zunialab.com/connect");
    assert.deepEqual(parsePairingUri(link), parsePairingUri(vectors.pairingUris.valid[0]!));
  });
});

describe("ConnectCipher", () => {
  const sessionId = "Zf3kQ9xTn2LmP8vR4sWb1A";

  function pair() {
    const dappKeys = generateConnectKeyPair();
    const walletKeys = generateConnectKeyPair();
    const fromDapp = deriveConnectKeys({ role: "dapp", sessionId, secretKey: dappKeys.secretKey, peerPublicKey: walletKeys.publicKey });
    const fromWallet = deriveConnectKeys({ role: "wallet", sessionId, secretKey: walletKeys.secretKey, peerPublicKey: dappKeys.publicKey });
    return {
      dapp: new ConnectCipher({ role: "dapp", sessionId, keys: fromDapp }),
      wallet: new ConnectCipher({ role: "wallet", sessionId, keys: fromWallet }),
      fromDapp,
      fromWallet,
    };
  }

  it("carries messages both ways with increasing sequence numbers", () => {
    const { dapp, wallet, fromDapp, fromWallet } = pair();
    assert.equal(fromDapp.verificationCode, fromWallet.verificationCode);
    const first = wallet.open(dapp.seal({ type: "connect_request", id: "1", payload: { chains: ["cosmoshub-4"] } }));
    assert.deepEqual(first, { seq: 1, type: "connect_request", id: "1", payload: { chains: ["cosmoshub-4"] } });
    assert.equal(dapp.open(wallet.seal({ type: "result", id: "1", payload: true })).seq, 1);
    assert.equal(wallet.open(dapp.seal({ type: "sign_amino", id: "2" })).seq, 2);
    assert.deepEqual(dapp.state, { sendSeq: 2, receiveSeq: 1 });
  });

  it("refuses replays, reordering, tampering, the wrong direction and another session", () => {
    const { dapp, wallet, fromDapp } = pair();
    const one = dapp.seal({ type: "a" });
    const two = dapp.seal({ type: "b" });
    wallet.open(two);
    failsWith(() => wallet.open(one), "PAIRING_FAILED");
    failsWith(() => wallet.open(two), "PAIRING_FAILED");

    const three = dapp.seal({ type: "c" });
    const bytes = base64UrlToBytes(three.c);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    failsWith(() => wallet.open({ n: three.n, c: bytesToBase64Url(bytes) }), "PAIRING_FAILED");

    failsWith(() => dapp.open(dapp.seal({ type: "own" })), "PAIRING_FAILED");

    const elsewhere = new ConnectCipher({ role: "wallet", sessionId: "aB-_09zzYYxxWWvvUUttSs", keys: fromDapp });
    failsWith(() => elsewhere.open(dapp.seal({ type: "d" })), "PAIRING_FAILED");
  });

  it("tells a resent copy apart from a forgery", () => {
    const { dapp, wallet } = pair();
    const frame = dapp.seal({ type: "a" });
    assert.equal(wallet.openFresh(frame)?.type, "a");
    assert.equal(wallet.openFresh(frame), null);
    assert.deepEqual(wallet.state, { sendSeq: 0, receiveSeq: 1 });
    const bytes = base64UrlToBytes(dapp.seal({ type: "b" }).c);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    failsWith(() => wallet.openFresh({ n: frame.n, c: bytesToBase64Url(bytes) }), "PAIRING_FAILED");
  });

  it("resumes from saved sequence numbers", () => {
    const { dapp, wallet, fromDapp } = pair();
    wallet.open(dapp.seal({ type: "a" }));
    const reloaded = new ConnectCipher({ role: "dapp", sessionId, keys: fromDapp, state: dapp.state });
    assert.equal(wallet.open(reloaded.seal({ type: "b" })).seq, 2);
  });

  it("refuses unusable peer keys", () => {
    const own = generateConnectKeyPair();
    failsWith(
      () => deriveConnectKeys({ role: "dapp", sessionId, secretKey: own.secretKey, peerPublicKey: new Uint8Array(32) }),
      "PAIRING_FAILED",
    );
    failsWith(
      () => deriveConnectKeys({ role: "dapp", sessionId, secretKey: own.secretKey, peerPublicKey: new Uint8Array(31) }),
      "PAIRING_FAILED",
    );
  });
});
