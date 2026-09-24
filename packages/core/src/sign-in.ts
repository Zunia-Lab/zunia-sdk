import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { ZuniaConnectError } from "./errors.js";

/**
 * Sign in with Zunia: a CAIP-122 message (the Cosmos form of Sign-In with
 * Ethereum) that the wallet signs with ADR-036.
 *
 *   app.example.com wants you to sign in with your Cosmos account:
 *   cosmos1...
 *
 *   Optional statement.
 *
 *   URI: https://app.example.com
 *   Version: 1
 *   Chain ID: cosmoshub-4
 *   Nonce: 32891756
 *   Issued At: 2026-09-24T10:00:00.000Z
 *   Expiration Time: 2026-09-24T10:10:00.000Z
 *
 * The parser is the one the Zunia extension and mobile wallet run. The shared
 * vectors in `test-vectors/sign-in-vectors.json` keep them identical.
 */

export interface SignInMessage {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: "1";
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

export const SIGN_IN_LIMITS = {
  maxLength: 4096,
  maxStatement: 512,
  maxRequestId: 256,
  maxResources: 32,
  /** How far ahead of the verifier's clock the signer's clock may run. */
  clockSkewMs: 5 * 60_000,
} as const;

const HEADER = " wants you to sign in with your Cosmos account:";

const DOMAIN =
  /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)(?::\d{1,5})?$/;
const ADDRESS = /^[a-z][a-z0-9]{0,40}1[02-9ac-hj-np-z]{6,100}$/;
const CHAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NONCE = /^[A-Za-z0-9]{8,128}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** Control, format (bidi overrides, zero-width) and line separator characters. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * True for anything that reads like a sign-in request, in any wording or line
 * ending. Wallets never sign such text as a plain message.
 */
export function looksLikeSignIn(text: string): boolean {
  return /wants you to sign in with your/i.test(text);
}

function invalid(message: string): never {
  throw new ZuniaConnectError("INVALID_PARAMS", message);
}

function checkDate(label: string, value: string): string {
  if (!DATE_TIME.test(value) || !Number.isFinite(Date.parse(value))) {
    invalid(`${label} must be an RFC 3339 date-time`);
  }
  return value;
}

function checkUri(label: string, value: string): string {
  if (!value || /\s/.test(value) || HIDDEN.test(value)) invalid(`${label} is not a valid URI`);
  try {
    new URL(value);
  } catch {
    invalid(`${label} is not a valid URI`);
  }
  return value;
}

/** Reads a sign-in text, or throws `INVALID_PARAMS` naming the first problem. */
export function parseSignInMessage(text: string): SignInMessage {
  if (text.length > SIGN_IN_LIMITS.maxLength) invalid("The sign-in message is too long");
  const lines = text.split("\n");
  let at = 0;

  const header = lines[at++] ?? "";
  if (!header.endsWith(HEADER)) {
    invalid("Zunia signs in with Cosmos accounts only, in the CAIP-122 format");
  }
  const domain = header.slice(0, -HEADER.length);
  if (!DOMAIN.test(domain)) invalid("The sign-in message names an invalid domain");

  const address = lines[at++] ?? "";
  if (!ADDRESS.test(address)) invalid("The sign-in message names an invalid address");
  if (lines[at++] !== "") invalid("A blank line must follow the address");

  let statement: string | undefined;
  const next = lines[at];
  if (next !== undefined && !next.startsWith("URI: ")) {
    statement = next;
    at += 1;
    if (!statement.trim() || HIDDEN.test(statement)) {
      invalid("The sign-in statement must be one line of visible text");
    }
    if (statement.length > SIGN_IN_LIMITS.maxStatement) invalid("The sign-in statement is too long");
    if (lines[at++] !== "") invalid("A blank line must follow the statement");
  }

  function field(name: string): string {
    const line = lines[at];
    const prefix = `${name}: `;
    if (line === undefined || !line.startsWith(prefix)) invalid(`Expected "${name}:" on line ${at + 1}`);
    at += 1;
    return line.slice(prefix.length);
  }
  function optional(name: string): string | undefined {
    return lines[at]?.startsWith(`${name}: `) ? field(name) : undefined;
  }

  const uri = checkUri("URI", field("URI"));
  if (field("Version") !== "1") invalid("Only version 1 sign-in messages are supported");
  const chainId = field("Chain ID");
  if (!CHAIN_ID.test(chainId)) invalid("The sign-in message names an invalid chain ID");
  const nonce = field("Nonce");
  if (!NONCE.test(nonce)) invalid("The nonce must be 8 to 128 letters or digits");
  const issuedAt = checkDate("Issued At", field("Issued At"));

  const expirationTime = optional("Expiration Time");
  if (expirationTime !== undefined) checkDate("Expiration Time", expirationTime);
  const notBefore = optional("Not Before");
  if (notBefore !== undefined) checkDate("Not Before", notBefore);
  const requestId = optional("Request ID");
  if (
    requestId !== undefined &&
    (!requestId || HIDDEN.test(requestId) || requestId.length > SIGN_IN_LIMITS.maxRequestId)
  ) {
    invalid("The request ID must be one line of visible text");
  }

  let resources: string[] | undefined;
  if (lines[at] === "Resources:") {
    at += 1;
    resources = [];
    while (lines[at]?.startsWith("- ")) {
      resources.push(checkUri("Resource", lines[at]!.slice(2)));
      at += 1;
    }
    if (resources.length === 0) invalid("Resources: must list at least one URI");
    if (resources.length > SIGN_IN_LIMITS.maxResources) invalid("The sign-in message lists too many resources");
  }

  if (at !== lines.length) invalid(`Unexpected content on line ${at + 1}`);

  return {
    domain,
    address,
    ...(statement !== undefined ? { statement } : {}),
    uri,
    version: "1",
    chainId,
    nonce,
    issuedAt,
    ...(expirationTime !== undefined ? { expirationTime } : {}),
    ...(notBefore !== undefined ? { notBefore } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(resources !== undefined ? { resources } : {}),
  };
}

export type SignInFields = Omit<SignInMessage, "version" | "issuedAt"> & {
  /** Defaults to now. */
  issuedAt?: string;
};

/**
 * Writes the exact text a wallet expects. Throws `INVALID_PARAMS` when a field
 * would not survive the wallet's parser unchanged.
 */
export function buildSignInMessage(fields: SignInFields): string {
  const message: SignInMessage = {
    ...fields,
    version: "1",
    issuedAt: fields.issuedAt ?? new Date().toISOString(),
  };
  const lines = [`${message.domain}${HEADER}`, message.address, ""];
  if (message.statement !== undefined) lines.push(message.statement, "");
  lines.push(
    `URI: ${message.uri}`,
    `Version: ${message.version}`,
    `Chain ID: ${message.chainId}`,
    `Nonce: ${message.nonce}`,
    `Issued At: ${message.issuedAt}`,
  );
  if (message.expirationTime !== undefined) lines.push(`Expiration Time: ${message.expirationTime}`);
  if (message.notBefore !== undefined) lines.push(`Not Before: ${message.notBefore}`);
  if (message.requestId !== undefined) lines.push(`Request ID: ${message.requestId}`);
  if (message.resources !== undefined) {
    lines.push("Resources:", ...message.resources.map((resource) => `- ${resource}`));
  }
  const text = lines.join("\n");
  const parsed = parseSignInMessage(text);
  const same = (Object.keys(message) as Array<keyof SignInMessage>).every(
    (key) => JSON.stringify(parsed[key]) === JSON.stringify(message[key]),
  );
  if (!same) invalid("A sign-in field contains text the wallet would read differently");
  return text;
}

/** 128 random bits as 32 hex characters, a valid sign-in nonce. Issue one per attempt. */
export function createNonce(): string {
  return bytesToHex(randomBytes(16));
}

export interface SignInBinding {
  /** Origin of the page asking, as the browser or the relay reported it. */
  origin: string;
  /** Chain the signature was requested on. */
  chainId: string;
  /** Address the site asked to sign with. */
  signer: string;
  now?: number;
}

/**
 * The wallet-side check: refuses a sign-in that is not for the site asking, the
 * chain it asked on, or the account it asked to sign with, or whose dates are
 * out of bounds. Throws `ORIGIN_MISMATCH` or `INVALID_PARAMS`.
 */
export function checkSignInBinding(message: SignInMessage, binding: SignInBinding): void {
  const now = binding.now ?? Date.now();
  let host: string;
  try {
    host = new URL(binding.origin).host;
  } catch {
    throw new ZuniaConnectError("ORIGIN_MISMATCH", "The requesting site has no usable origin");
  }
  if (message.domain.toLowerCase() !== host) {
    throw new ZuniaConnectError(
      "ORIGIN_MISMATCH",
      `This sign-in request is for ${message.domain}, but ${host} sent it`,
    );
  }
  let uriOrigin: string | null = null;
  try {
    uriOrigin = new URL(message.uri).origin;
  } catch {
    // Refused below.
  }
  if (uriOrigin !== binding.origin) {
    throw new ZuniaConnectError(
      "ORIGIN_MISMATCH",
      `The sign-in URI ${message.uri} is not on ${binding.origin}`,
    );
  }
  if (message.chainId !== binding.chainId) {
    invalid(
      `The sign-in message names ${message.chainId}, but the signature was requested on ${binding.chainId}`,
    );
  }
  if (message.address !== binding.signer) {
    invalid("The sign-in message names another address than the signer");
  }
  const issuedAt = Date.parse(message.issuedAt);
  if (issuedAt > now + SIGN_IN_LIMITS.clockSkewMs) invalid("The sign-in message is dated in the future");
  if (message.expirationTime !== undefined) {
    const expires = Date.parse(message.expirationTime);
    if (expires <= issuedAt) invalid("The sign-in message expires before it was issued");
    if (expires <= now) invalid("The sign-in message has expired");
  }
  if (message.notBefore !== undefined && Date.parse(message.notBefore) > now + SIGN_IN_LIMITS.clockSkewMs) {
    invalid("The sign-in message is not valid yet");
  }
}
