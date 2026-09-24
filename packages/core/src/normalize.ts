import { base64ToBytes, bytesToBase64, toBytes } from "./encoding.js";
import type { WireAccount } from "./protocol.js";
import type { ZuniaAccountInfo } from "./session.js";
import type {
  Algo,
  AminoSignResponse,
  DirectSignResponse,
  SignDocInput,
  StdSignDoc,
  StdSignature,
  ZuniaKey,
} from "./types.js";

/**
 * Every transport returns results in these shapes: keys and body bytes as
 * `Uint8Array`, account numbers as `bigint`, signatures as base64 strings.
 */

export function normalizeAlgo(algo: unknown): Algo {
  return algo === "ed25519" || algo === "sr25519" ? algo : "secp256k1";
}

export function accountFromKey(chainId: string, key: ZuniaKey): ZuniaAccountInfo {
  return {
    chainId,
    address: key.bech32Address,
    algo: normalizeAlgo(key.algo),
    pubkey: toBytes(key.pubKey, "pubKey"),
    ...(key.name ? { name: key.name } : {}),
  };
}

export function accountFromWire(account: WireAccount): ZuniaAccountInfo {
  return {
    chainId: account.chainId,
    address: account.address,
    algo: normalizeAlgo(account.algo),
    pubkey: base64ToBytes(account.pubKey),
    ...(account.name ? { name: account.name } : {}),
  };
}

export function accountToWire(account: ZuniaAccountInfo): WireAccount {
  return {
    chainId: account.chainId,
    address: account.address,
    algo: account.algo,
    pubKey: bytesToBase64(account.pubkey),
    ...(account.name ? { name: account.name } : {}),
  };
}

/** A Keplr-style key built from an account, for dApps that call `getKey`. */
export function keyFromAccount(account: ZuniaAccountInfo): ZuniaKey {
  return {
    name: account.name ?? "Zunia",
    algo: account.algo,
    pubKey: account.pubkey,
    address: account.address,
    bech32Address: account.address,
  };
}

export function accountNumberToString(value: SignDocInput["accountNumber"]): string {
  const text = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^\d+$/.test(text)) throw new TypeError("accountNumber must be a non-negative integer");
  return text;
}

export function normalizeStdSignature(raw: unknown): StdSignature {
  const value = raw as { pub_key?: { type?: unknown; value?: unknown }; signature?: unknown } | null;
  if (!value || typeof value !== "object" || !value.pub_key) {
    throw new TypeError("The wallet returned no signature");
  }
  const key = value.pub_key.value;
  const signature = value.signature;
  return {
    pub_key: {
      type: typeof value.pub_key.type === "string" ? value.pub_key.type : "tendermint/PubKeySecp256k1",
      value: typeof key === "string" ? key : bytesToBase64(toBytes(key, "pub_key.value")),
    },
    signature: typeof signature === "string" ? signature : bytesToBase64(toBytes(signature, "signature")),
  };
}

export function normalizeDirectResponse(raw: unknown, request?: SignDocInput): DirectSignResponse {
  const value = raw as { signed?: Record<string, unknown>; signature?: unknown } | null;
  if (!value || typeof value !== "object") throw new TypeError("The wallet returned no signature");
  const signed = value.signed ?? {};
  const accountNumber = signed.accountNumber ?? request?.accountNumber ?? 0;
  return {
    signed: {
      bodyBytes: toBytes(signed.bodyBytes ?? request?.bodyBytes, "bodyBytes"),
      authInfoBytes: toBytes(signed.authInfoBytes ?? request?.authInfoBytes, "authInfoBytes"),
      chainId: typeof signed.chainId === "string" ? signed.chainId : (request?.chainId ?? ""),
      accountNumber: BigInt(accountNumberToString(accountNumber as SignDocInput["accountNumber"])),
    },
    signature: normalizeStdSignature(value.signature),
  };
}

export function normalizeAminoResponse(raw: unknown, request?: StdSignDoc): AminoSignResponse {
  const value = raw as { signed?: StdSignDoc; signature?: unknown } | null;
  if (!value || typeof value !== "object") throw new TypeError("The wallet returned no signature");
  const signed = value.signed ?? request;
  if (!signed) throw new TypeError("The wallet returned no signed document");
  return { signed, signature: normalizeStdSignature(value.signature) };
}
