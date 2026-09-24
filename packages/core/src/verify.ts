import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import { base64ToBytes, bytesToBase64, utf8ToBytes } from "./encoding.js";
import { ZuniaSignInError } from "./errors.js";
import { parseSignInMessage, SIGN_IN_LIMITS, type SignInMessage } from "./sign-in.js";
import type { StdSignature } from "./types.js";

/** CosmJS `serializeSignDoc`: keys sorted recursively, compact JSON, `&<>` escaped. */
export function serializeAminoSignDoc(signDoc: unknown): Uint8Array {
  const json = JSON.stringify(sortKeysDeep(signDoc))
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return utf8ToBytes(json);
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/** The ADR-036 amino document a wallet signs for `signArbitrary(chainId, signer, data)`. */
export function adr36SignDoc(signer: string, data: Uint8Array) {
  return {
    account_number: "0",
    chain_id: "",
    fee: { amount: [], gas: "0" },
    memo: "",
    msgs: [{ type: "sign/MsgSignData", value: { data: bytesToBase64(data), signer } }],
    sequence: "0",
  };
}

/** Bech32 address of a compressed secp256k1 key: ripemd160(sha256(key)). */
export function pubkeyToAddress(pubKey: Uint8Array, prefix: string): string {
  return bech32.encode(prefix, bech32.toWords(ripemd160(sha256(pubKey))));
}

/** Verifies an ADR-036 signature over `data` by `signer`, with low-S enforced. */
export function verifyAdr36Signature(input: {
  signer: string;
  data: string | Uint8Array;
  pubKey: Uint8Array;
  signature: Uint8Array;
}): boolean {
  const data = typeof input.data === "string" ? utf8ToBytes(input.data) : input.data;
  try {
    const digest = sha256(serializeAminoSignDoc(adr36SignDoc(input.signer, data)));
    return secp256k1.verify(input.signature, digest, input.pubKey, { prehash: false });
  } catch {
    return false;
  }
}

export interface VerifySignInOptions {
  /** The exact text the wallet signed. */
  message: string;
  /** What `session.signIn()` or `signArbitrary` returned. */
  signature: StdSignature;
  /** Host, with port when not default, that your site is served on, e.g. `app.example.com`. */
  domain: string;
  /** The nonce your server issued for this attempt. Delete it once used. */
  nonce: string;
  /** Chains you accept. Any chain when omitted. */
  chainId?: string | readonly string[];
  /** Require this address. */
  address?: string;
  /** Oldest accepted `Issued At`, in milliseconds. Defaults to 10 minutes. */
  maxAgeMs?: number;
  now?: number | Date;
}

export interface VerifiedSignIn {
  address: string;
  chainId: string;
  domain: string;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  pubKey: Uint8Array;
  message: SignInMessage;
}

function refuse(code: ConstructorParameters<typeof ZuniaSignInError>[0], message: string): never {
  throw new ZuniaSignInError(code, message);
}

/**
 * Server-side check of a Sign in with Zunia result. Throws {@link ZuniaSignInError}
 * with a reason code; returns the proven address on success.
 *
 * You still own nonce storage: issue a fresh nonce per attempt and accept it once.
 */
export function verifySignIn(options: VerifySignInOptions): VerifiedSignIn {
  const now = options.now instanceof Date ? options.now.getTime() : (options.now ?? Date.now());
  const maxAgeMs = options.maxAgeMs ?? 10 * 60_000;

  let message: SignInMessage;
  try {
    message = parseSignInMessage(options.message);
  } catch (error) {
    refuse("INVALID_MESSAGE", error instanceof Error ? error.message : "Unreadable sign-in message");
  }

  const domain = options.domain.toLowerCase();
  if (message.domain.toLowerCase() !== domain) {
    refuse("DOMAIN_MISMATCH", `Signed for ${message.domain}, expected ${options.domain}`);
  }
  let uriHost = "";
  try {
    uriHost = new URL(message.uri).host.toLowerCase();
  } catch {
    // Refused below.
  }
  if (uriHost !== domain) refuse("URI_MISMATCH", `The URI ${message.uri} is not on ${options.domain}`);
  if (message.nonce !== options.nonce) refuse("NONCE_MISMATCH", "The nonce is not the one issued");

  if (options.chainId !== undefined) {
    const allowed = typeof options.chainId === "string" ? [options.chainId] : options.chainId;
    if (!allowed.includes(message.chainId)) refuse("CHAIN_MISMATCH", `Chain ${message.chainId} is not accepted`);
  }
  if (options.address !== undefined && message.address !== options.address) {
    refuse("ADDRESS_MISMATCH", "Signed by another address");
  }

  const issuedAt = Date.parse(message.issuedAt);
  if (issuedAt > now + SIGN_IN_LIMITS.clockSkewMs) refuse("ISSUED_IN_FUTURE", "Issued in the future");
  if (issuedAt < now - maxAgeMs) refuse("TOO_OLD", "Issued too long ago");
  if (message.expirationTime !== undefined && Date.parse(message.expirationTime) <= now) {
    refuse("EXPIRED", "The sign-in message has expired");
  }
  if (message.notBefore !== undefined && Date.parse(message.notBefore) > now + SIGN_IN_LIMITS.clockSkewMs) {
    refuse("NOT_YET_VALID", "The sign-in message is not valid yet");
  }

  const { pub_key: pubKeyField, signature: signatureField } = options.signature ?? {};
  if (pubKeyField?.type !== "tendermint/PubKeySecp256k1" || typeof pubKeyField.value !== "string") {
    refuse("UNSUPPORTED_KEY", "Only secp256k1 Cosmos keys can sign in");
  }
  let pubKey: Uint8Array;
  let signature: Uint8Array;
  try {
    pubKey = base64ToBytes(pubKeyField.value);
    signature = base64ToBytes(signatureField);
  } catch {
    refuse("INVALID_SIGNATURE", "The signature or key is not base64");
  }
  if (pubKey.length !== 33 || (pubKey[0] !== 2 && pubKey[0] !== 3)) {
    refuse("UNSUPPORTED_KEY", "Expected a compressed secp256k1 key");
  }

  let prefix: string;
  try {
    prefix = bech32.decode(message.address as `${string}1${string}`).prefix;
  } catch {
    refuse("INVALID_MESSAGE", "The address is not valid bech32");
  }
  if (pubkeyToAddress(pubKey, prefix) !== message.address) {
    refuse("KEY_MISMATCH", "The key does not belong to the signed address");
  }
  if (signature.length !== 64 || !verifyAdr36Signature({ signer: message.address, data: options.message, pubKey, signature })) {
    refuse("INVALID_SIGNATURE", "The signature does not match");
  }

  return {
    address: message.address,
    chainId: message.chainId,
    domain: message.domain,
    nonce: message.nonce,
    issuedAt: message.issuedAt,
    ...(message.expirationTime !== undefined ? { expirationTime: message.expirationTime } : {}),
    pubKey,
    message,
  };
}
