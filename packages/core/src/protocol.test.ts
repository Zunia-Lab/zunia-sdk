import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ConnectCipher, generateConnectKeyPair, deriveConnectKeys, sealedFrameBytes } from "./connect-crypto.js";
import { ZuniaConnectError, explainZuniaError } from "./errors.js";
import {
  ZUNIA_CONNECT_LIMITS,
  buildPairingUri,
  buildWakeUri,
  isValidReturnUrl,
  parsePairingUri,
  parseWakeUri,
} from "./protocol.js";

interface Vectors {
  pairingUris: { valid: string[]; invalid: string[]; withReturn: Array<{ uri: string; returnUrl: string }> };
  returnUrls: { valid: string[]; invalid: string[] };
  wakeUris: { valid: Array<{ uri: string; sessionId: string }>; invalid: string[] };
}

const vectors = JSON.parse(
  readFileSync(new URL("../test-vectors/connect-v2-vectors.json", import.meta.url), "utf8"),
) as Vectors;

const SID = "Zf3kQ9xTn2LmP8vR4sWb1A";

function cipherPair(): { dapp: ConnectCipher } {
  const dapp = generateConnectKeyPair();
  const wallet = generateConnectKeyPair();
  const keys = deriveConnectKeys({ role: "dapp", sessionId: SID, secretKey: dapp.secretKey, peerPublicKey: wallet.publicKey });
  return { dapp: new ConnectCipher({ role: "dapp", sessionId: SID, keys }) };
}

describe("return target (ret)", () => {
  it("accepts https and an app's own scheme, refuses the rest", () => {
    for (const value of vectors.returnUrls.valid) assert.equal(isValidReturnUrl(value), true, value);
    for (const value of vectors.returnUrls.invalid) assert.equal(isValidReturnUrl(value), false, value);
    assert.equal(isValidReturnUrl(undefined), false);
    assert.equal(isValidReturnUrl(42), false);
  });

  it("round-trips through the pairing link", () => {
    for (const { uri, returnUrl } of vectors.pairingUris.withReturn) {
      const parsed = parsePairingUri(uri);
      assert.equal(parsed?.returnUrl, returnUrl, uri);
      assert.equal(buildPairingUri(parsed!), uri);
    }
    const plain = parsePairingUri(vectors.pairingUris.valid[0]!);
    assert.equal(plain?.returnUrl, undefined);
    assert.ok(!buildPairingUri(plain!).includes("ret="));
  });

  it("refuses to build a link with a target wallets ignore, and parses one without it", () => {
    const base = parsePairingUri(vectors.pairingUris.valid[0]!)!;
    for (const returnUrl of ["http://app.example.com", "javascript:alert(1)", "zunia://connect"]) {
      assert.throws(
        () => buildPairingUri({ ...base, returnUrl }),
        (error: unknown) => error instanceof ZuniaConnectError && error.code === "INVALID_PARAMS",
      );
    }
    const withBad = `${vectors.pairingUris.valid[0]}&ret=${encodeURIComponent("javascript:alert(1)")}`;
    const parsed = parsePairingUri(withBad);
    assert.ok(parsed, "the link still pairs");
    assert.equal(parsed.returnUrl, undefined);
  });
});

describe("wake links", () => {
  it("carry the session id only", () => {
    for (const { uri, sessionId } of vectors.wakeUris.valid) assert.deepEqual(parseWakeUri(uri), { sessionId }, uri);
    for (const uri of vectors.wakeUris.invalid) assert.equal(parseWakeUri(uri), null, uri);
    assert.equal(buildWakeUri(SID), `zunia://connect/wake?sid=${SID}`);
    assert.equal(buildWakeUri(SID, { universal: true }), `https://zunialab.com/connect/wake?sid=${SID}`);
    assert.throws(() => buildWakeUri("short"), ZuniaConnectError);
  });

  it("never read as a pairing link, and a pairing link never reads as one", () => {
    for (const { uri } of vectors.wakeUris.valid) assert.equal(parsePairingUri(uri), null, uri);
    for (const uri of vectors.pairingUris.valid) assert.equal(parseWakeUri(uri), null, uri);
  });
});

describe("frame size", () => {
  it("predicts the relay frame byte for byte, without using a sequence number", () => {
    const { dapp } = cipherPair();
    for (const data of ["", "a", "ab", "abc", "é".repeat(1000), "x".repeat(70_000)]) {
      const message = { type: "sign_arbitrary", id: "req", payload: { data } };
      const predicted = dapp.sealedBytes(message);
      const seq = dapp.state.sendSeq;
      assert.equal(dapp.state.sendSeq, seq);
      const frame = dapp.seal(message);
      const wire = Buffer.byteLength(JSON.stringify({ t: "msg", n: frame.n, c: frame.c }), "utf8");
      assert.equal(predicted, wire, `${data.length} characters`);
    }
    assert.equal(sealedFrameBytes(0), 41 + 22);
  });

  it("knows the relay limits", () => {
    assert.equal(ZUNIA_CONNECT_LIMITS.maxFrameBytes, 524_288);
    assert.equal(ZUNIA_CONNECT_LIMITS.queueMaxFrames, 32);
    assert.equal(ZUNIA_CONNECT_LIMITS.queueMaxBytes, 1_048_576);
  });
});

describe("relay errors in words", () => {
  it("explains a request too large and a full queue", () => {
    const tooLarge = explainZuniaError(new ZuniaConnectError("INVALID_PARAMS", "640 KiB", undefined, "too-large"));
    assert.equal(tooLarge.title, "Request too large");
    assert.equal(tooLarge.retryable, false);
    const full = explainZuniaError(new ZuniaConnectError("NETWORK", "queue", undefined, "queue-full"));
    assert.equal(full.title, "Phone unreachable");
    assert.equal(full.retryable, true);
  });
});
