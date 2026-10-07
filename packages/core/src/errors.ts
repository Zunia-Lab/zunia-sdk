/**
 * Error codes shared by every transport.
 *
 * The first group matches the codes the Zunia extension and the mobile wallet
 * put on rejected requests, so a dApp handles one list whatever the transport.
 * The second group covers the connection itself.
 */
export const ZUNIA_PROVIDER_ERROR_CODES = [
  "USER_REJECTED",
  "NOT_CONNECTED",
  "LOCKED",
  "UNKNOWN_CHAIN",
  "ORIGIN_MISMATCH",
  "UNSUPPORTED",
  "INVALID_PARAMS",
  "INTERNAL",
] as const;

export type ZuniaProviderErrorCode = (typeof ZUNIA_PROVIDER_ERROR_CODES)[number];

export type ZuniaConnectErrorCode =
  | ZuniaProviderErrorCode
  /** No extension, no relay configured and no WalletConnect project id. */
  | "NOT_INSTALLED"
  /** The wallet did not answer in time. */
  | "TIMEOUT"
  /** The session ended while a request was pending, or there is no session. */
  | "DISCONNECTED"
  /** QR pairing could not complete: bad key, undecryptable frame, relay refusal. */
  | "PAIRING_FAILED"
  /** The relay no longer knows the session. Pair again. */
  | "SESSION_EXPIRED"
  /** The relay or WalletConnect could not be reached. */
  | "NETWORK";

/** Finer reasons behind a code, for the cases where the next step differs. */
export type ZuniaErrorReason =
  /** `UNSUPPORTED`: this Zunia build cannot show the transaction (it would need blind signing). */
  | "blind-signing"
  /** `UNSUPPORTED`: this Zunia build signed Amino without escaping `&<>`; the chain would refuse it. */
  | "amino-escaping"
  /** `TIMEOUT`: the wallet's prompt ran out before anyone answered. */
  | "prompt-expired"
  /** `DISCONNECTED`: the extension was updated or reloaded under this page. */
  | "stale-page";

export class ZuniaConnectError extends Error {
  readonly code: ZuniaConnectErrorCode;
  override readonly cause?: unknown;
  readonly reason?: ZuniaErrorReason;

  constructor(code: ZuniaConnectErrorCode, message: string, cause?: unknown, reason?: ZuniaErrorReason) {
    super(message);
    this.name = "ZuniaConnectError";
    this.code = code;
    this.cause = cause;
    if (reason) this.reason = reason;
  }
}

/** Zunia's words for a prompt that ran out. It carries `USER_REJECTED`, but nobody declined. */
const PROMPT_EXPIRED = /request expired before it was answered/i;
/** The page lost its extension (updated or reloaded): Chrome's words for any extension, then Zunia's. */
const STALE_PAGE = /extension context invalidated|provider handshake timed out|provider port not ready/i;
const BLIND_SIGNING = /blind signing/i;

export function isZuniaProviderErrorCode(value: unknown): value is ZuniaProviderErrorCode {
  return (
    typeof value === "string" &&
    (ZUNIA_PROVIDER_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Wraps anything a wallet threw into a {@link ZuniaConnectError}, keeping the
 * wallet's code when it sent one. Keplr-style messages without a code map to
 * the closest code.
 */
export function toZuniaConnectError(
  error: unknown,
  fallback: ZuniaConnectErrorCode = "INTERNAL",
): ZuniaConnectError {
  if (error instanceof ZuniaConnectError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (PROMPT_EXPIRED.test(message)) return new ZuniaConnectError("TIMEOUT", message, error, "prompt-expired");
  if (STALE_PAGE.test(message)) return new ZuniaConnectError("DISCONNECTED", message, error, "stale-page");
  if (code === "UNSUPPORTED" && BLIND_SIGNING.test(message)) {
    return new ZuniaConnectError("UNSUPPORTED", message, error, "blind-signing");
  }
  if (isZuniaProviderErrorCode(code)) return new ZuniaConnectError(code, message, error);
  if (/request rejected|user rejected|rejected by user/i.test(message)) {
    return new ZuniaConnectError("USER_REJECTED", message, error);
  }
  if (/not authorized|not connected/i.test(message)) {
    return new ZuniaConnectError("NOT_CONNECTED", message, error);
  }
  return new ZuniaConnectError(fallback, message, error);
}

export type ZuniaSignInErrorCode =
  | "INVALID_MESSAGE"
  | "DOMAIN_MISMATCH"
  | "URI_MISMATCH"
  | "NONCE_MISMATCH"
  | "CHAIN_MISMATCH"
  | "ADDRESS_MISMATCH"
  | "ISSUED_IN_FUTURE"
  | "TOO_OLD"
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "UNSUPPORTED_KEY"
  | "KEY_MISMATCH"
  | "INVALID_SIGNATURE";

/** Why a server refused a sign-in. Safe to log; do not echo details to the client. */
export class ZuniaSignInError extends Error {
  readonly code: ZuniaSignInErrorCode;

  constructor(code: ZuniaSignInErrorCode, message: string) {
    super(message);
    this.name = "ZuniaSignInError";
    this.code = code;
  }
}

/** A wallet error in words a person can act on, for a toast or an inline message. */
export interface ZuniaErrorExplanation {
  code: ZuniaConnectErrorCode;
  reason?: ZuniaErrorReason;
  /** Two or three words. */
  title: string;
  /** One or two sentences: what happened and what to do. */
  message: string;
  /** Trying the same request again can succeed. */
  retryable: boolean;
  /** The wallet's own text, for a details fold. */
  detail: string;
}

type Copy = Pick<ZuniaErrorExplanation, "title" | "message" | "retryable">;

const REASON_COPY: Record<ZuniaErrorReason, Copy> = {
  "blind-signing": {
    title: "Update Zunia",
    message: "This version of Zunia can't show this transaction, so nothing was signed. Update Zunia to the latest version, or use another wallet.",
    retryable: false,
  },
  "amino-escaping": {
    title: "Update Zunia",
    message:
      "This version of Zunia signed the &, < or > in this transaction in a way the network refuses, so nothing was sent. Update Zunia, or remove those characters from the memo.",
    retryable: false,
  },
  "prompt-expired": { title: "No answer in time", message: "The Zunia prompt expired before it was answered. Try again.", retryable: true },
  "stale-page": { title: "Reload this page", message: "Zunia was updated or reloaded. Reload this page, then try again.", retryable: false },
};

const CODE_COPY: Record<ZuniaConnectErrorCode, Copy> = {
  USER_REJECTED: { title: "Declined", message: "You declined the request in your wallet. Nothing was signed.", retryable: true },
  NOT_CONNECTED: { title: "Not connected", message: "Your wallet is no longer connected to this site. Connect it again, then try again.", retryable: false },
  LOCKED: { title: "Wallet locked", message: "Zunia stayed locked. Unlock it, then try again.", retryable: true },
  UNKNOWN_CHAIN: { title: "Network missing", message: "Your wallet does not have this network yet. Add it, then try again.", retryable: false },
  ORIGIN_MISMATCH: { title: "Wrong site", message: "The request named a different site than this one, so the wallet refused it.", retryable: false },
  UNSUPPORTED: { title: "Not supported", message: "Your wallet does not support this request.", retryable: false },
  INVALID_PARAMS: { title: "Request refused", message: "The wallet refused the request as written. If you switched accounts, reconnect and try again.", retryable: false },
  INTERNAL: { title: "Wallet error", message: "Your wallet could not complete the request.", retryable: true },
  NOT_INSTALLED: { title: "Zunia not found", message: "Zunia is not installed in this browser. Install it, or connect a phone instead.", retryable: false },
  TIMEOUT: { title: "No answer in time", message: "Your wallet did not answer in time, so nothing was signed. With Zunia Mobile, open the app, then try again.", retryable: true },
  DISCONNECTED: { title: "Disconnected", message: "The wallet session ended, so nothing was signed. Connect again, then try again.", retryable: false },
  PAIRING_FAILED: { title: "Pairing failed", message: "The phone could not be paired. Scan a new code.", retryable: true },
  SESSION_EXPIRED: { title: "Session expired", message: "The phone session expired. Pair again.", retryable: false },
  NETWORK: { title: "Connection problem", message: "The wallet relay could not be reached. Check your connection and try again.", retryable: true },
};

/** Any error a session, a transport or `window.zunia` threw, explained. Never throws. */
export function explainZuniaError(error: unknown): ZuniaErrorExplanation {
  const failure = toZuniaConnectError(error);
  const copy = (failure.reason && REASON_COPY[failure.reason]) || CODE_COPY[failure.code] || CODE_COPY.INTERNAL;
  return {
    code: failure.code,
    ...(failure.reason ? { reason: failure.reason } : {}),
    ...copy,
    detail: failure.message,
  };
}
