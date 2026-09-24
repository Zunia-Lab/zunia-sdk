/**
 * Writes test-vectors/connect-v2-vectors.json from fixed keys and nonces.
 * Run: pnpm --filter @zunialab/sdk-core exec tsx scripts/generate-connect-vectors.ts
 */
import { writeFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  connectKeyPairFromSecret,
  connectTranscript,
  deriveConnectKeys,
  encryptFrame,
  frameAad,
  verificationCodeFrom,
} from "../src/connect-crypto.js";
import { bytesToBase64Url } from "../src/encoding.js";
import { buildPairingUri } from "../src/protocol.js";

const seed = (label: string) => sha256(utf8ToBytes(`zunia.connect.v2 vector ${label}`));

function keyAgreement(name: string, sessionId: string, label: string) {
  const dapp = connectKeyPairFromSecret(seed(`${label} dapp`));
  const wallet = connectKeyPairFromSecret(seed(`${label} wallet`));
  const keys = deriveConnectKeys({ role: "dapp", sessionId, secretKey: dapp.secretKey, peerPublicKey: wallet.publicKey });
  return {
    name,
    sessionId,
    dappSecretKey: bytesToHex(dapp.secretKey),
    walletSecretKey: bytesToHex(wallet.secretKey),
    dappPublicKey: bytesToBase64Url(dapp.publicKey),
    walletPublicKey: bytesToBase64Url(wallet.publicKey),
    sharedSecret: bytesToHex(x25519.getSharedSecret(dapp.secretKey, wallet.publicKey)),
    transcript: bytesToHex(connectTranscript(sessionId, dapp.publicKey, wallet.publicKey)),
    dappToWallet: bytesToHex(keys.dappToWallet),
    walletToDapp: bytesToHex(keys.walletToDapp),
    verificationCode: keys.verificationCode,
  };
}

const agreements = [
  keyAgreement("first session", "Zf3kQ9xTn2LmP8vR4sWb1A", "one"),
  keyAgreement("second session", "aB-_09zzYYxxWWvvUUttSs", "two"),
];

const first = agreements[0]!;
const firstKeys = {
  dapp: Buffer.from(first.dappToWallet, "hex"),
  wallet: Buffer.from(first.walletToDapp, "hex"),
};

function frame(name: string, sender: "dapp" | "wallet", envelope: Record<string, unknown>, label: string) {
  const nonce = seed(`nonce ${label}`).slice(0, 12);
  const aad = frameAad(first.sessionId, sender);
  const plaintext = JSON.stringify(envelope);
  const key = sender === "dapp" ? firstKeys.dapp : firstKeys.wallet;
  return {
    name,
    sessionId: first.sessionId,
    sender,
    key: bytesToHex(key),
    nonce: bytesToBase64Url(nonce),
    aad: new TextDecoder().decode(aad),
    plaintext,
    ciphertext: bytesToBase64Url(encryptFrame(key, nonce, aad, utf8ToBytes(plaintext))),
  };
}

const frames = [
  frame(
    "dApp connect request",
    "dapp",
    {
      seq: 1,
      type: "connect_request",
      id: "req-1",
      payload: {
        metadata: { name: "Example dApp", url: "https://app.example.com" },
        chains: ["cosmoshub-4"],
        methods: ["get_accounts", "sign_amino", "sign_direct", "sign_arbitrary"],
        events: ["accounts_changed", "chains_changed"],
      },
    },
    "connect request",
  ),
  frame(
    "wallet approval",
    "wallet",
    {
      seq: 1,
      type: "connect_approve",
      id: "req-1",
      payload: {
        accounts: [
          {
            chainId: "cosmoshub-4",
            address: "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu",
            algo: "secp256k1",
            pubKey: "A08EGB1Yr3xkMq8mq8ph1CL9JOhZEAVbc6CHcQJRTx4D",
          },
        ],
        chains: ["cosmoshub-4"],
      },
    },
    "approval",
  ),
  frame("wallet event", "wallet", { seq: 2, type: "chains_changed", payload: { chains: ["cosmoshub-4", "osmosis-1"] } }, "event"),
];

const codes = ["00000000", "000f423f", "000f4240", "ffffffff", "12345678"].map((hex) => ({
  bytes: hex,
  code: verificationCodeFrom(Buffer.from(hex, "hex")),
}));

const vectors = {
  version: 1,
  about:
    "zunia.connect.v2 vectors, shared by the JS SDK and the Dart wallet. Secret keys and nonces are fixed here; real sessions use random ones. " +
    "Keys: X25519, salt SHA-256('zunia.connect.v2' 0x00 sessionId 0x00 dappPublicKey walletPublicKey), HKDF-SHA256 with info " +
    "'zunia.connect.v2 dapp->wallet', 'zunia.connect.v2 wallet->dapp' (32 bytes each) and 'zunia.connect.v2 verification code' (4 bytes, big-endian, mod 1000000, 6 digits). " +
    "Frames: ChaCha20-Poly1305, 12-byte nonce, associated data 'zunia.connect.v2|<sessionId>|<sender>->...', plaintext the JSON envelope. Binary values are hex, public keys, nonces and ciphertexts unpadded base64url.",
  keyAgreement: agreements,
  frames,
  verificationCodes: codes,
  pairingUris: {
    valid: [
      buildPairingUri({
        sessionId: first.sessionId,
        joinToken: bytesToBase64Url(seed("join token")),
        dappPublicKey: first.dappPublicKey,
        relay: "wss://api.zunialab.com",
      }),
    ],
    invalid: [
      `zunia://connect?v=1&sid=${first.sessionId}&t=${bytesToBase64Url(seed("join token"))}&pk=${first.dappPublicKey}&r=wss%3A%2F%2Fapi.zunialab.com`,
      `zunia://connect?v=2&sid=short&t=${bytesToBase64Url(seed("join token"))}&pk=${first.dappPublicKey}&r=wss%3A%2F%2Fapi.zunialab.com`,
      `zunia://connect?v=2&sid=${first.sessionId}&t=${bytesToBase64Url(seed("join token"))}&pk=${first.dappPublicKey}&r=https%3A%2F%2Fapi.zunialab.com`,
      `zunia://wc?v=2&sid=${first.sessionId}&t=${bytesToBase64Url(seed("join token"))}&pk=${first.dappPublicKey}&r=wss%3A%2F%2Fapi.zunialab.com`,
    ],
  },
};

writeFileSync(new URL("../test-vectors/connect-v2-vectors.json", import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`);
console.log("wrote connect-v2-vectors.json");
