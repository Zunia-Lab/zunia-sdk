import assert from "node:assert/strict";
import { test } from "node:test";

import {
  base64ToJson,
  bytesToUtf8,
  decodeBase64,
  decodeBase64Url,
  decodeBase64UrlUtf8,
  decodeBase64Utf8,
  encodeBase64,
  encodeBase64Url,
  encodeBase64UrlUtf8,
  encodeBase64Utf8,
  jsonToBase64,
  jsonToBase64Url,
  utf8ToBytes,
} from "./base64.js";
import { isInterchainError } from "./types.js";

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/** RFC 4648 section 10 test vectors. */
const VECTORS: ReadonlyArray<readonly [string, string]> = [
  ["", ""],
  ["f", "Zg=="],
  ["fo", "Zm8="],
  ["foo", "Zm9v"],
  ["foob", "Zm9vYg=="],
  ["fooba", "Zm9vYmE="],
  ["foobar", "Zm9vYmFy"],
];

test("base64 matches the RFC 4648 vectors in both directions", () => {
  for (const [plain, encoded] of VECTORS) {
    assert.equal(encodeBase64Utf8(plain), encoded, `encode ${plain}`);
    assert.equal(decodeBase64Utf8(encoded), plain, `decode ${encoded}`);
  }
});

test("base64 round-trips every byte value", () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  assert.deepEqual(decodeBase64(encodeBase64(all)), all);
  assert.deepEqual(decodeBase64Url(encodeBase64Url(all)), all);
});

test("base64url avoids +, / and padding", () => {
  // 0xfb 0xff 0xbf encodes to the two characters the URL alphabet replaces.
  const source = bytes(0xfb, 0xff, 0xbf, 0x00);
  const standard = encodeBase64(source);
  const urlSafe = encodeBase64Url(source);

  assert.ok(standard.includes("+") || standard.includes("/"), standard);
  assert.equal(/[+/=]/.test(urlSafe), false, urlSafe);
  assert.deepEqual(decodeBase64Url(urlSafe), source);
});

test("decoding accepts either alphabet and optional padding", () => {
  const source = bytes(0xfb, 0xff, 0xbf, 0x01);
  const standard = encodeBase64(source);
  const urlSafe = encodeBase64Url(source);

  // Postel: a wasm query path and an LCD body disagree about the alphabet, and
  // rejecting the other spelling would only ever cost us a false failure.
  assert.deepEqual(decodeBase64(urlSafe), source);
  assert.deepEqual(decodeBase64Url(standard), source);
  assert.deepEqual(decodeBase64(standard.replace(/=+$/, "")), source);
});

test("decoding rejects malformed input as malformed-response", () => {
  const cases = ["Zm9v*", "Z", "Zg=====", "Zm 9v", "Zm9v=Yg=="];
  for (const value of cases) {
    assert.throws(
      () => decodeBase64(value),
      (error: unknown) =>
        isInterchainError(error) && error.code === "malformed-response",
      `expected ${value} to be rejected`,
    );
  }
});

test("UTF-8 survives the round trip, including multi-byte characters", () => {
  const text = "Safrochain · addr_safro1 · 你好 · 🜲";
  assert.equal(decodeBase64Utf8(encodeBase64Utf8(text)), text);
  assert.equal(decodeBase64UrlUtf8(encodeBase64UrlUtf8(text)), text);
  assert.equal(bytesToUtf8(utf8ToBytes(text)), text);
});

test("invalid UTF-8 bytes are rejected, not replaced", () => {
  // A lone continuation byte. A non-fatal decoder would hand back U+FFFD and
  // we would ship a corrupt token name.
  assert.throws(
    () => bytesToUtf8(bytes(0x80)),
    (error: unknown) =>
      isInterchainError(error) && error.code === "malformed-response",
  );
});

test("jsonToBase64Url encodes a CW721 smart query for a URL path", () => {
  const query = { nft_info: { token_id: "42" } };
  const encoded = jsonToBase64Url(query);

  assert.equal(/[+/=]/.test(encoded), false, encoded);
  assert.deepEqual(base64ToJson(encoded), query);
});

test("jsonToBase64 encodes an ICS721 send_nft payload", () => {
  const msg = { receiver: "addr_safro1abc", channel_id: "channel-1" };
  assert.deepEqual(base64ToJson(jsonToBase64(msg)), msg);
});

test("base64ToJson rejects a payload that is not JSON", () => {
  assert.throws(
    () => base64ToJson(encodeBase64Utf8("<html>rate limited</html>")),
    (error: unknown) =>
      isInterchainError(error) && error.code === "malformed-response",
  );
});
