/**
 * Dependency-free base64 / base64url.
 *
 * Needed in three places: CosmWasm smart queries put base64url JSON in the URL
 * path (`/cosmwasm/wasm/v1/contract/{addr}/smart/{query}`), CW721 `send_nft`
 * carries a base64 `msg`, and account public keys come back as standard base64.
 *
 * Implemented by hand rather than with `Buffer` (not available in a browser
 * service worker) or `atob`/`btoa` (latin1-only, and lax about malformed
 * input — it silently accepts strings we want to reject as
 * `malformed-response`).
 */

import { InterchainError, type JsonValue } from "./types.js";

const STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Decode table covering both alphabets.
 *
 * Decoding accepts `+/` and `-_` interchangeably: the wire is not consistent
 * (Cosmos LCDs emit standard base64, wasm query paths use url-safe) and a
 * decoder that rejects the other spelling only ever costs us a false failure.
 * Encoding stays canonical.
 */
const DECODE = /* @__PURE__ */ (() => {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < STANDARD.length; i++) {
    table[STANDARD.charCodeAt(i)] = i;
    table[URL_SAFE.charCodeAt(i)] = i;
  }
  return table;
})();

const encoder = /* @__PURE__ */ new TextEncoder();
/** `fatal` so invalid UTF-8 raises instead of yielding replacement characters. */
const decoder = /* @__PURE__ */ new TextDecoder("utf-8", { fatal: true });

function invalid(message: string, cause?: unknown): InterchainError {
  return new InterchainError("malformed-response", message, { cause });
}

/** Encode a string to UTF-8 bytes. */
export function utf8ToBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * Decode UTF-8 bytes to a string.
 *
 * @throws {@link InterchainError} `malformed-response` if the bytes are not
 *   valid UTF-8.
 */
export function bytesToUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch (cause) {
    throw invalid("Response bytes are not valid UTF-8", cause);
  }
}

function encode(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = "";
  let i = 0;
  // Three input bytes become four output characters; the loop is unrolled to
  // avoid a per-byte branch on a hot path (NFT lists encode many queries).
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += alphabet.charAt(a >> 2);
    out += alphabet.charAt(((a & 0x03) << 4) | (b >> 4));
    out += alphabet.charAt(((b & 0x0f) << 2) | (c >> 6));
    out += alphabet.charAt(c & 0x3f);
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const a = bytes[i] ?? 0;
    out += alphabet.charAt(a >> 2);
    out += alphabet.charAt((a & 0x03) << 4);
    if (pad) out += "==";
  } else if (remaining === 2) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    out += alphabet.charAt(a >> 2);
    out += alphabet.charAt(((a & 0x03) << 4) | (b >> 4));
    out += alphabet.charAt((b & 0x0f) << 2);
    if (pad) out += "=";
  }
  return out;
}

function decode(text: string, label: string): Uint8Array {
  // Padding is optional on input; strip it, then validate what is left. A
  // length of 1 mod 4 cannot come from any byte string.
  let end = text.length;
  while (end > 0 && text.charAt(end - 1) === "=") end--;
  if (end !== text.length && text.length - end > 2) {
    throw invalid(`${label}: too much padding`);
  }
  if (end % 4 === 1) {
    throw invalid(`${label}: truncated input`);
  }

  const out = new Uint8Array((end * 3) >> 2);
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < end; i++) {
    const value = DECODE[text.charCodeAt(i)] ?? -1;
    if (value < 0) {
      throw invalid(`${label}: illegal character at position ${i}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

/** Encode bytes as standard base64, padded. */
export function encodeBase64(bytes: Uint8Array): string {
  return encode(bytes, STANDARD, true);
}

/**
 * Decode standard base64 to bytes. Padding is optional and the url-safe
 * alphabet is accepted.
 *
 * @throws {@link InterchainError} `malformed-response` on illegal characters or
 *   an impossible length.
 */
export function decodeBase64(text: string): Uint8Array {
  return decode(text, "base64");
}

/**
 * Encode bytes as base64url, unpadded.
 *
 * Unpadded because these strings go in URL paths, where `=` has to be escaped
 * and several LCD proxies mangle it.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  return encode(bytes, URL_SAFE, false);
}

/** Decode base64url to bytes. Padding is optional; both alphabets are accepted. */
export function decodeBase64Url(text: string): Uint8Array {
  return decode(text, "base64url");
}

/** Encode a string's UTF-8 bytes as standard base64. */
export function encodeBase64Utf8(text: string): string {
  return encodeBase64(utf8ToBytes(text));
}

/** Decode standard base64 into a UTF-8 string. */
export function decodeBase64Utf8(text: string): string {
  return bytesToUtf8(decodeBase64(text));
}

/** Encode a string's UTF-8 bytes as base64url. */
export function encodeBase64UrlUtf8(text: string): string {
  return encodeBase64Url(utf8ToBytes(text));
}

/** Decode base64url into a UTF-8 string. */
export function decodeBase64UrlUtf8(text: string): string {
  return bytesToUtf8(decodeBase64Url(text));
}

/**
 * Serialise a value and encode it as standard base64.
 *
 * The form CW721 `send_nft` wants for its inner `msg`.
 */
export function jsonToBase64(value: JsonValue): string {
  return encodeBase64Utf8(JSON.stringify(value));
}

/**
 * Serialise a value and encode it as base64url.
 *
 * The form a CosmWasm smart query path wants.
 */
export function jsonToBase64Url(value: JsonValue): string {
  return encodeBase64UrlUtf8(JSON.stringify(value));
}

/**
 * Decode base64 (either alphabet) and parse the result as JSON.
 *
 * CosmWasm query results arrive this way.
 *
 * @returns The parsed value as `unknown`; callers narrow it themselves.
 * @throws {@link InterchainError} `malformed-response` if the payload is not
 *   base64, not UTF-8, or not JSON.
 */
export function base64ToJson(text: string): unknown {
  const json = decodeBase64Utf8(text);
  try {
    return JSON.parse(json) as unknown;
  } catch (cause) {
    throw invalid("base64 payload is not JSON", cause);
  }
}
