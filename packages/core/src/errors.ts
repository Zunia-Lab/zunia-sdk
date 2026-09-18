/** Shared error codes for Connect with Zunia / provider calls. */

export type ZuniaConnectErrorCode =
  | "NOT_INSTALLED"
  | "USER_REJECTED"
  | "UNAUTHORIZED"
  | "UNSUPPORTED"
  | "TIMEOUT"
  | "DISCONNECTED"
  | "PAIRING_FAILED"
  | "SESSION_EXPIRED"
  | "NETWORK"
  | "UNKNOWN";

export class ZuniaConnectError extends Error {
  readonly code: ZuniaConnectErrorCode;
  readonly cause?: unknown;

  constructor(code: ZuniaConnectErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ZuniaConnectError";
    this.code = code;
    this.cause = cause;
  }
}
