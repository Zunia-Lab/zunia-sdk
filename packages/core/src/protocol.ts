/**
 * zunia.connect.v2: pairing a dApp with the Zunia mobile wallet through a relay.
 *
 * Relay frames (`t` field) are the only thing the relay reads. Application
 * messages travel sealed inside `msg` frames; see connect-crypto.ts.
 */
import type { ZuniaProviderErrorCode } from "./errors.js";
import type { StdSignDoc, StdSignature } from "./types.js";

export const ZUNIA_CONNECT_PROTOCOL = "zunia.connect.v2" as const;
export const ZUNIA_CONNECT_TOKEN_PROTOCOL_PREFIX = "zunia.token.";

export const ZUNIA_CONNECT_PATHS = {
  sessions: "/v1/connect/sessions",
  ws: "/v1/connect/ws",
} as const;

/** WebSocket close codes the relay uses. */
export const ZUNIA_CONNECT_CLOSE_CODES = {
  replaced: 4000,
  ended: 4001,
  rateLimited: 4008,
  unauthorized: 4401,
} as const;

/** `POST /v1/connect/sessions`. Keep `dappToken` private; `walletJoinToken` goes in the QR code. */
export interface CreateConnectSessionResponse {
  v: typeof ZUNIA_CONNECT_PROTOCOL;
  sessionId: string;
  dappToken: string;
  walletJoinToken: string;
  verifiedOrigin: string | null;
  expiresAt: number;
  wsUrl: string;
}

export type RelayErrorCode = "BAD_FRAME" | "FORBIDDEN" | "QUEUE_FULL";
export type SessionEndReason = "closed" | "deleted" | "expired";

export type RelayServerFrame =
  | {
      t: "welcome";
      v: typeof ZUNIA_CONNECT_PROTOCOL;
      role: "dapp" | "wallet";
      sessionId: string;
      verifiedOrigin: string | null;
      paired: boolean;
      peer: boolean;
      expiresAt: number;
      resumeToken?: string;
    }
  | { t: "peer"; online: boolean }
  | { t: "hello"; pk: string }
  | { t: "msg"; n: string; c: string }
  | { t: "paired"; expiresAt: number }
  | { t: "pong" }
  | { t: "error"; code: RelayErrorCode; message: string }
  | { t: "closed"; reason: SessionEndReason };

export type RelayClientFrame =
  | { t: "ping" }
  | { t: "hello"; pk: string }
  | { t: "msg"; n: string; c: string }
  | { t: "paired" }
  | { t: "close"; reason?: string };

export interface ZuniaDappMetadata {
  name: string;
  description?: string;
  url: string;
  icons?: string[];
}

/** An account as it crosses the wire: the public key is base64. */
export interface WireAccount {
  chainId: string;
  address: string;
  algo: string;
  pubKey: string;
  name?: string;
}

/** Sealed application messages, dApp to wallet. */
export type DappMessage =
  | {
      type: "connect_request";
      id: string;
      payload: {
        metadata: ZuniaDappMetadata;
        chains: string[];
        methods: string[];
        events: string[];
      };
    }
  | { type: "get_accounts"; id: string; payload: { chainIds: string[] } }
  | { type: "sign_amino"; id: string; payload: { chainId: string; signer: string; signDoc: StdSignDoc } }
  | {
      type: "sign_direct";
      id: string;
      payload: {
        chainId: string;
        signer: string;
        signDoc: { bodyBytes: string; authInfoBytes: string; chainId: string; accountNumber: string };
      };
    }
  | {
      type: "sign_arbitrary";
      id: string;
      payload: { chainId: string; signer: string; data: string; encoding: "utf8" | "base64" };
    };

/** Sealed application messages, wallet to dApp. */
export type WalletMessage =
  | {
      type: "connect_approve";
      id: string;
      payload: { accounts: WireAccount[]; chains: string[]; wallet?: { name: string; version?: string } };
    }
  | { type: "connect_reject"; id: string; payload: { code: ZuniaProviderErrorCode; message: string } }
  | { type: "result"; id: string; payload: unknown }
  | { type: "error"; id: string; payload: { code: ZuniaProviderErrorCode; message: string } }
  | { type: "accounts_changed"; payload: { accounts: WireAccount[] } }
  | { type: "chains_changed"; payload: { chains: string[] } };

/** Result payloads of wallet `result` messages, by request type. */
export interface WireSignResults {
  sign_amino: { signed: StdSignDoc; signature: StdSignature };
  sign_direct: {
    signed: { bodyBytes: string; authInfoBytes: string; chainId: string; accountNumber: string };
    signature: StdSignature;
  };
  sign_arbitrary: StdSignature;
  get_accounts: WireAccount[];
}

export interface ZuniaPairingUri {
  sessionId: string;
  joinToken: string;
  /** The dApp's X25519 public key, unpadded base64url. */
  dappPublicKey: string;
  /** Relay WebSocket base, e.g. `wss://api.zunialab.com`. Wallets only accept relays they trust. */
  relay: string;
}

const SESSION_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

/** `zunia://connect?v=2&sid=…&t=…&pk=…&r=…`, the QR code payload. */
export function buildPairingUri(params: ZuniaPairingUri): string {
  const query = new URLSearchParams({
    v: "2",
    sid: params.sessionId,
    t: params.joinToken,
    pk: params.dappPublicKey,
    r: params.relay,
  });
  return `zunia://connect?${query.toString()}`;
}

/** Reads a v2 pairing URI (custom scheme or https link). Returns null for anything else. */
export function parsePairingUri(uri: string): ZuniaPairingUri | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const isScheme = url.protocol === "zunia:" && (url.host === "connect" || url.pathname.replace(/^\/+/, "") === "connect");
  const isLink = url.protocol === "https:" && url.pathname.replace(/\/$/, "") === "/connect";
  if (!isScheme && !isLink) return null;
  const q = url.searchParams;
  const sessionId = q.get("sid") ?? "";
  const joinToken = q.get("t") ?? "";
  const dappPublicKey = q.get("pk") ?? "";
  const relay = q.get("r") ?? "";
  if (q.get("v") !== "2" || !SESSION_ID.test(sessionId) || !TOKEN.test(joinToken) || !PUBLIC_KEY.test(dappPublicKey)) {
    return null;
  }
  try {
    const relayUrl = new URL(relay);
    if (relayUrl.protocol !== "wss:" && relayUrl.protocol !== "ws:") return null;
  } catch {
    return null;
  }
  return { sessionId, joinToken, dappPublicKey, relay };
}
