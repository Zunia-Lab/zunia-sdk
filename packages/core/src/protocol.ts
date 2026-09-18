/** zunia.connect.v1 — native WebSocket session wire format. */

export const ZUNIA_CONNECT_PROTOCOL_VERSION = "zunia.connect.v1" as const;

export type ZuniaConnectRole = "dapp" | "wallet";

export type ZuniaConnectMessageType =
  | "hello"
  | "hello_ok"
  | "connect_request"
  | "connect_approve"
  | "connect_reject"
  | "accounts_get"
  | "accounts"
  | "sign_amino"
  | "sign_direct"
  | "sign_arbitrary"
  | "sign_result"
  | "sign_reject"
  | "event_accounts_changed"
  | "event_chain_changed"
  | "ping"
  | "pong"
  | "disconnect"
  | "error";

export interface ZuniaConnectEnvelope<T = unknown> {
  v: typeof ZUNIA_CONNECT_PROTOCOL_VERSION;
  type: ZuniaConnectMessageType;
  /** Correlation id for request/response pairs. */
  id?: string;
  ts: number;
  payload: T;
}

export interface ZuniaConnectAccount {
  chainId: string;
  address: string;
  algo: string;
  /** Base64-encoded compressed pubkey. */
  pubkey: string;
  name?: string;
}

export interface ZuniaDappMetadata {
  name: string;
  description?: string;
  url: string;
  icons?: string[];
}

export interface HelloPayload {
  role: ZuniaConnectRole;
  client?: string;
  metadata?: ZuniaDappMetadata;
}

export interface HelloOkPayload {
  role: ZuniaConnectRole;
  peers: ZuniaConnectRole[];
  expiresAt: number;
}

export interface ConnectRequestPayload {
  origin: string;
  metadata: ZuniaDappMetadata;
  chains: string[];
  methods: string[];
  events: string[];
}

export interface ConnectApprovePayload {
  accounts: ZuniaConnectAccount[];
  chains: string[];
  sessionExpiresAt: number;
}

export interface ConnectRejectPayload {
  reason: string;
}

export interface SignAminoPayload {
  chainId: string;
  signer: string;
  signDoc: unknown;
}

export interface SignDirectPayload {
  chainId: string;
  signer: string;
  /** Base64 body bytes */
  bodyBytes: string;
  /** Base64 auth info bytes */
  authInfoBytes: string;
}

export interface SignArbitraryPayload {
  chainId: string;
  signer: string;
  /** Base64 or utf-8 string data */
  data: string;
  encoding?: "base64" | "utf8";
}

export interface SignResultPayload {
  signature: string;
  pub_key?: { type: string; value: string };
  signed?: unknown;
}

export interface SignRejectPayload {
  reason: string;
  code?: string;
}

export interface DisconnectPayload {
  reason?: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
  id?: string;
}

export interface CreateConnectSessionRequest {
  metadata: ZuniaDappMetadata;
  chains: string[];
  methods?: string[];
  events?: string[];
  /** Requested TTL seconds (clamped server-side). */
  ttlSeconds?: number;
}

export interface CreateConnectSessionResponse {
  sessionId: string;
  pairingSecret: string;
  expiresAt: number;
  wsUrl: string;
  deepLink: string;
  qrPayload: string;
  httpUrl: string;
}

export function createEnvelope<T>(
  type: ZuniaConnectMessageType,
  payload: T,
  id?: string,
): ZuniaConnectEnvelope<T> {
  return {
    v: ZUNIA_CONNECT_PROTOCOL_VERSION,
    type,
    id,
    ts: Date.now(),
    payload,
  };
}
