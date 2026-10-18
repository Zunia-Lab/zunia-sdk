/**
 * zunia.connect.v2: pairing a dApp with the Zunia mobile wallet through a relay.
 *
 * Relay frames (`t` field) are the only thing the relay reads. Application
 * messages travel sealed inside `msg` frames; see connect-crypto.ts.
 */
import { ZuniaConnectError, type ZuniaProviderErrorCode } from "./errors.js";
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

/**
 * What the relay at api.zunialab.com accepts (zunia-backend `config/connect.ts`).
 * A frame over `maxFrameBytes` closes the socket (1009), so the SDKs refuse such
 * a request before it leaves. Frames for a peer that is offline wait in a queue
 * bounded by `queueMaxFrames` per direction and `queueMaxBytes` per session; a
 * frame that does not fit is answered with a `QUEUE_FULL` error.
 */
export const ZUNIA_CONNECT_LIMITS = {
  maxFrameBytes: 512 * 1024,
  queueMaxFrames: 32,
  queueMaxBytes: 1024 * 1024,
  /** Queued frames older than this are dropped. */
  queueTtlMs: 10 * 60_000,
  /** Frames one socket may send per window before the relay closes it (4008). */
  socketFrameLimit: 120,
  socketFrameWindowMs: 10_000,
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
  /**
   * `ret`: where the wallet goes after the user answers, when this link opened it
   * on the same device. See {@link isValidReturnUrl}. Wallets ignore it on a scan.
   */
  returnUrl?: string;
}

const SESSION_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

/** Longest `ret` a wallet follows, in characters. */
export const RETURN_URL_MAX_LENGTH = 512;

/**
 * Schemes a wallet never returns to: its own and WalletConnect's (a loop), the
 * ones that run code or read local data, Android intents, and plain `http:`
 * (only `https:` is accepted for the web).
 */
export const BLOCKED_RETURN_SCHEMES: readonly string[] = [
  "zunia",
  "zuniamobile",
  "wc",
  "javascript",
  "data",
  "file",
  "blob",
  "about",
  "content",
  "intent",
  "http",
];

/** RFC 3986: a scheme, then only unreserved, reserved and percent-encoded characters. */
const RFC3986_URI = /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/;

/**
 * Whether a wallet follows this `ret`: an `https:` URL with a host, or a URL in an
 * app's own scheme (`myapp://done`) that is not one of {@link BLOCKED_RETURN_SCHEMES};
 * RFC 3986 characters only; at most 512 characters. Wallets ignore anything else.
 */
export function isValidReturnUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > RETURN_URL_MAX_LENGTH) return false;
  if (!RFC3986_URI.test(value)) return false;
  const scheme = value.slice(0, value.indexOf(":")).toLowerCase();
  if (BLOCKED_RETURN_SCHEMES.includes(scheme)) return false;
  if (scheme !== "https") return true;
  // WHATWG URLs read `https:/host` as `https://host`; RFC 3986 needs the authority.
  if (value.slice(6, 8) !== "//") return false;
  try {
    return new URL(value).hostname !== "";
  } catch {
    return false;
  }
}

/**
 * `zunia://connect?v=2&sid=…&t=…&pk=…&r=…`, the QR code payload. With
 * `returnUrl`, also `&ret=…`: put that version behind an "Open Zunia" link on the
 * same device, not in the QR code. Throws `INVALID_PARAMS` for a `returnUrl`
 * wallets would ignore.
 */
export function buildPairingUri(params: ZuniaPairingUri): string {
  const query = new URLSearchParams({
    v: "2",
    sid: params.sessionId,
    t: params.joinToken,
    pk: params.dappPublicKey,
    r: params.relay,
  });
  if (params.returnUrl !== undefined) {
    if (!isValidReturnUrl(params.returnUrl)) {
      throw new ZuniaConnectError(
        "INVALID_PARAMS",
        "returnUrl must be an https: URL or an app's own scheme, at most 512 characters",
      );
    }
    query.set("ret", params.returnUrl);
  }
  return `zunia://connect?${query.toString()}`;
}

/**
 * Reads a v2 pairing URI (custom scheme or https link). Returns null for anything
 * else. A `ret` wallets would ignore is left out rather than failing the link.
 */
export function parsePairingUri(uri: string): ZuniaPairingUri | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const isScheme = url.protocol === "zunia:" && url.host === "connect" && url.pathname.replace(/\/+$/, "") === "";
  const isSchemePath = url.protocol === "zunia:" && url.host === "" && url.pathname.replace(/^\/+|\/+$/g, "") === "connect";
  const isLink = url.protocol === "https:" && url.pathname.replace(/\/$/, "") === "/connect";
  if (!isScheme && !isSchemePath && !isLink) return null;
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
  const returnUrl = q.get("ret");
  return { sessionId, joinToken, dappPublicKey, relay, ...(isValidReturnUrl(returnUrl) ? { returnUrl } : {}) };
}

/**
 * `zunia://connect/wake?sid=…` (or `https://zunialab.com/connect/wake?sid=…` with
 * `universal`): brings an already paired session up in Zunia so it shows the
 * requests waiting there. It carries the session id only, no secret, so it can
 * never pair; a wallet ignores a session it does not know.
 */
export function buildWakeUri(sessionId: string, options: { universal?: boolean } = {}): string {
  if (!SESSION_ID.test(sessionId)) throw new ZuniaConnectError("INVALID_PARAMS", "A session id is 22 base64url characters");
  const base = options.universal ? "https://zunialab.com/connect/wake" : "zunia://connect/wake";
  return `${base}?sid=${sessionId}`;
}

/** Reads a wake link. Returns null for anything else, including pairing links. */
export function parseWakeUri(uri: string): { sessionId: string } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const isScheme =
    url.protocol === "zunia:" &&
    ((url.host === "connect" && url.pathname.replace(/\/+$/, "") === "/wake") ||
      (url.host === "" && url.pathname.replace(/^\/+|\/+$/g, "") === "connect/wake"));
  const isLink = url.protocol === "https:" && url.pathname.replace(/\/$/, "") === "/connect/wake";
  if (!isScheme && !isLink) return null;
  const sessionId = url.searchParams.get("sid") ?? "";
  return SESSION_ID.test(sessionId) ? { sessionId } : null;
}
