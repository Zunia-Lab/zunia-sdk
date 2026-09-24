import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { base64UrlToBytes, bytesToBase64Url, bytesToUtf8, utf8ToBytes } from "./encoding.js";
import { ZuniaConnectError } from "./errors.js";

/**
 * End-to-end encryption for zunia.connect.v2.
 *
 * - X25519 between the dApp key (in the QR code) and the wallet key (in its
 *   `hello` frame). The session id and both public keys are bound into the
 *   HKDF-SHA256 salt.
 * - One ChaCha20-Poly1305 key per direction, a random 96-bit nonce per frame,
 *   and `zunia.connect.v2|<sessionId>|<direction>` as associated data.
 * - A sequence number inside each plaintext; a receiver drops anything not
 *   newer than the last frame it accepted.
 * - A 6-digit code from the same secret. Both screens show it; a relay that
 *   swapped keys produces two different codes.
 *
 * `test-vectors/connect-v2-vectors.json` pins every step for the Dart wallet.
 */

export const CONNECT_V2 = "zunia.connect.v2";

export type ConnectRole = "dapp" | "wallet";

export interface ConnectKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface ConnectSessionKeys {
  dappToWallet: Uint8Array;
  walletToDapp: Uint8Array;
  /** Six digits, zero-padded, shown on both screens. */
  verificationCode: string;
}

export interface SealedFrame {
  /** 12-byte nonce, unpadded base64url. */
  n: string;
  /** Ciphertext and 16-byte tag, unpadded base64url. */
  c: string;
}

export interface ConnectEnvelope {
  seq: number;
  type: string;
  id?: string;
  payload?: unknown;
}

export interface ConnectCipherState {
  sendSeq: number;
  receiveSeq: number;
}

const DIRECTION: Record<ConnectRole, string> = {
  dapp: "dapp->wallet",
  wallet: "wallet->dapp",
};

export function generateConnectKeyPair(): ConnectKeyPair {
  return connectKeyPairFromSecret(x25519.utils.randomSecretKey());
}

export function connectKeyPairFromSecret(secretKey: Uint8Array): ConnectKeyPair {
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** The salt: SHA-256("zunia.connect.v2" 0x00 sessionId 0x00 dappPublicKey walletPublicKey). */
export function connectTranscript(
  sessionId: string,
  dappPublicKey: Uint8Array,
  walletPublicKey: Uint8Array,
): Uint8Array {
  return sha256(
    concatBytes(
      utf8ToBytes(CONNECT_V2),
      Uint8Array.of(0),
      utf8ToBytes(sessionId),
      Uint8Array.of(0),
      dappPublicKey,
      walletPublicKey,
    ),
  );
}

/** Four HKDF bytes, big-endian, modulo one million, zero-padded to six digits. */
export function verificationCodeFrom(bytes: Uint8Array): string {
  const value = (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0;
  return String(value % 1_000_000).padStart(6, "0");
}

export function deriveConnectKeys(input: {
  role: ConnectRole;
  sessionId: string;
  secretKey: Uint8Array;
  peerPublicKey: Uint8Array;
}): ConnectSessionKeys {
  if (input.peerPublicKey.length !== 32) {
    throw new ZuniaConnectError("PAIRING_FAILED", "The peer key must be 32 bytes");
  }
  const ownPublicKey = x25519.getPublicKey(input.secretKey);
  const dappPublicKey = input.role === "dapp" ? ownPublicKey : input.peerPublicKey;
  const walletPublicKey = input.role === "dapp" ? input.peerPublicKey : ownPublicKey;
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(input.secretKey, input.peerPublicKey);
  } catch (error) {
    throw new ZuniaConnectError("PAIRING_FAILED", "The peer key is not usable", error);
  }
  if (shared.every((byte) => byte === 0)) {
    throw new ZuniaConnectError("PAIRING_FAILED", "The peer key is not usable");
  }
  const salt = connectTranscript(input.sessionId, dappPublicKey, walletPublicKey);
  const expand = (info: string, length: number) => hkdf(sha256, shared, salt, utf8ToBytes(`${CONNECT_V2} ${info}`), length);
  return {
    dappToWallet: expand("dapp->wallet", 32),
    walletToDapp: expand("wallet->dapp", 32),
    verificationCode: verificationCodeFrom(expand("verification code", 4)),
  };
}

export function frameAad(sessionId: string, sender: ConnectRole): Uint8Array {
  return utf8ToBytes(`${CONNECT_V2}|${sessionId}|${DIRECTION[sender]}`);
}

export function encryptFrame(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

export function decryptFrame(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce, aad).decrypt(ciphertext);
}

/** Seals outgoing frames and opens incoming ones for one side of a session. */
export class ConnectCipher {
  private sendSeq: number;
  private receiveSeq: number;
  private readonly sendKey: Uint8Array;
  private readonly receiveKey: Uint8Array;
  private readonly sendAad: Uint8Array;
  private readonly receiveAad: Uint8Array;

  constructor(options: {
    role: ConnectRole;
    sessionId: string;
    keys: Pick<ConnectSessionKeys, "dappToWallet" | "walletToDapp">;
    state?: ConnectCipherState;
  }) {
    const { role, sessionId, keys } = options;
    const peer: ConnectRole = role === "dapp" ? "wallet" : "dapp";
    this.sendKey = role === "dapp" ? keys.dappToWallet : keys.walletToDapp;
    this.receiveKey = role === "dapp" ? keys.walletToDapp : keys.dappToWallet;
    this.sendAad = frameAad(sessionId, role);
    this.receiveAad = frameAad(sessionId, peer);
    this.sendSeq = options.state?.sendSeq ?? 0;
    this.receiveSeq = options.state?.receiveSeq ?? 0;
  }

  get state(): ConnectCipherState {
    return { sendSeq: this.sendSeq, receiveSeq: this.receiveSeq };
  }

  seal(message: { type: string; id?: string; payload?: unknown }): SealedFrame {
    const seq = this.sendSeq + 1;
    const envelope: ConnectEnvelope = { seq, type: message.type };
    if (message.id !== undefined) envelope.id = message.id;
    if (message.payload !== undefined) envelope.payload = message.payload;
    const nonce = randomBytes(12);
    const ciphertext = encryptFrame(this.sendKey, nonce, this.sendAad, utf8ToBytes(JSON.stringify(envelope)));
    this.sendSeq = seq;
    return { n: bytesToBase64Url(nonce), c: bytesToBase64Url(ciphertext) };
  }

  /** Throws `PAIRING_FAILED` for a forged, tampered, replayed or reordered frame. */
  open(frame: SealedFrame): ConnectEnvelope {
    let envelope: unknown;
    try {
      const plaintext = decryptFrame(
        this.receiveKey,
        base64UrlToBytes(frame.n),
        this.receiveAad,
        base64UrlToBytes(frame.c),
      );
      envelope = JSON.parse(bytesToUtf8(plaintext));
    } catch (error) {
      throw new ZuniaConnectError("PAIRING_FAILED", "A frame failed to decrypt", error);
    }
    const candidate = envelope as Partial<ConnectEnvelope> | null;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !Number.isSafeInteger(candidate.seq) ||
      typeof candidate.type !== "string"
    ) {
      throw new ZuniaConnectError("PAIRING_FAILED", "A frame has no valid envelope");
    }
    if ((candidate.seq as number) <= this.receiveSeq) {
      throw new ZuniaConnectError("PAIRING_FAILED", "A frame was replayed or reordered");
    }
    this.receiveSeq = candidate.seq as number;
    return candidate as ConnectEnvelope;
  }
}
