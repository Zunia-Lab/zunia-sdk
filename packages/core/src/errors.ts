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

export class ZuniaConnectError extends Error {
  readonly code: ZuniaConnectErrorCode;
  override readonly cause?: unknown;

  constructor(code: ZuniaConnectErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ZuniaConnectError";
    this.code = code;
    this.cause = cause;
  }
}

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
