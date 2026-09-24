import { base64, base64urlnopad } from "@scure/base";

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8ToBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decodes UTF-8, throwing on invalid sequences instead of substituting U+FFFD. */
export function bytesToUtf8(bytes: Uint8Array): string {
  return strictDecoder.decode(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

export function base64ToBytes(value: string): Uint8Array {
  return base64.decode(value);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes);
}

export function base64UrlToBytes(value: string): Uint8Array {
  return base64urlnopad.decode(value);
}

/**
 * Bytes from what wallets return for binary fields: a Uint8Array, a plain array
 * or indexed object (structured clones of Uint8Array), or a base64 string.
 */
export function toBytes(value: unknown, label = "value"): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return base64ToBytes(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (value && typeof value === "object") {
    const values = Object.values(value as Record<string, unknown>);
    if (values.every((v) => typeof v === "number")) return Uint8Array.from(values as number[]);
  }
  throw new TypeError(`${label} is not bytes`);
}
