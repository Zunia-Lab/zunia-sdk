/**
 * Which document to ask the Zunia extension to sign, Direct or Amino.
 *
 * Zunia 0.1.0 to 0.1.4 report the provider API version "0.1.0" and nothing
 * more, and they share two gaps that do not overlap:
 *
 * - Direct: a `MsgExecuteContract` to a 32-byte CosmWasm contract (every wasmd
 *   contract), and a `MsgSend` to a 32-byte address (a contract, an interchain
 *   account, a DAO treasury), are refused before any prompt opens,
 *   `UNSUPPORTED` "Blind signing disabled for unknown messages". 0.1.3 refuses
 *   Osmosis poolmanager swaps the same way; 0.1.4 decodes them.
 * - Amino: the sign bytes skip the `&`, `<`, `>` escaping the chain applies, so
 *   a document holding one of them gets a signature the chain refuses.
 *
 * So, on those builds, a contract call or a send to a 32-byte address signs
 * Amino unless its document holds `&<>`, and everything else signs Direct.
 * From 0.1.5 the extension reports `extensionVersion` and `features`, both gaps
 * are closed, and everything signs Direct, where the prompt is the decoded
 * transaction.
 *
 * Other wallets (Keplr, Leap, Zunia Mobile, WalletConnect wallets) are not
 * affected: this rule is only for the Zunia extension.
 */
import { bech32 } from "@scure/base";
import { base64ToBytes } from "./encoding.js";
import type { ZuniaProvider } from "./types.js";

/** `features` strings the extension reports from 0.1.5. */
export const ZUNIA_SIGNING_FEATURES = {
  /** Direct mode decodes `MsgExecuteContract` to 32-byte contracts. */
  directContractCalls: "sign-direct:wasm-contract-32",
  /** Direct mode decodes `MsgSend` to a 32-byte address (a contract, an interchain account). */
  directSends32: "sign-direct:send-32",
  /** Direct mode decodes Osmosis poolmanager swaps (single and split routes). */
  directPoolmanager: "sign-direct:osmosis-poolmanager",
  /** Direct mode decodes Osmosis exact-out swaps (single and split routes). */
  directExactOut: "sign-direct:osmosis-exact-out",
  /** Amino sign bytes escape `&`, `<`, `>`, U+2028 and U+2029 as the chain does. */
  aminoEscaping: "sign-amino:escaped",
  /** Amino mode describes Osmosis poolmanager swaps instead of refusing them. */
  aminoPoolmanager: "sign-amino:osmosis-poolmanager",
} as const;

export interface ZuniaCapabilities {
  /** The extension's version when it reports one (0.1.5+). Null for 0.1.0 to 0.1.4, which cannot be told apart. */
  extensionVersion: string | null;
  directContractCalls: boolean;
  directSends32: boolean;
  /** Null when unknown: 0.1.3 cannot, 0.1.4 can, and both report the same version. */
  directPoolmanager: boolean | null;
  directExactOut: boolean;
  aminoEscaping: boolean;
  /** Optional in 0.1.5, so only `features` reports it. */
  aminoPoolmanager: boolean;
}

/** A message as CosmJS (`EncodeObject`) or `@zunialab/interchain` (`BuiltMsg`) describes it. */
export interface SignableMessage {
  readonly typeUrl: string;
  readonly value?: unknown;
}

const FIXED_IN: readonly [number, number, number] = [0, 1, 5];
const EXECUTE_CONTRACT = "/cosmwasm.wasm.v1.MsgExecuteContract";
const SEND = "/cosmos.bank.v1beta1.MsgSend";
const POOLMANAGER = "/osmosis.poolmanager.";
// Characters the chain's Amino JSON (Go encoding/json) writes escaped and Zunia
// 0.1.4 and older write raw: & < > and the two line separators. Written as
// escapes, never as raw U+2028/U+2029, which are line terminators in JS.
const ESCAPED = /[&<>\u2028\u2029]/;
const decoder = new TextDecoder();

function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function atLeast(version: readonly number[], floor: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    const a = version[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** What the connected Zunia extension can sign, from what its provider reports. */
export function zuniaCapabilities(
  provider: Pick<ZuniaProvider, "version" | "extensionVersion" | "features"> | null | undefined,
): ZuniaCapabilities {
  const api = parseVersion(provider?.version);
  // 0.1.5 reports "" when it cannot read its manifest: no version, its features still count.
  const reported = typeof provider?.extensionVersion === "string" ? provider.extensionVersion.trim() || null : null;
  // Every build before 0.1.5 answers the API version "0.1.0"; only a higher one is a release.
  const extensionVersion = reported ?? (api && atLeast(api, [0, 1, 1]) ? (provider?.version ?? null) : null);
  const parsed = parseVersion(extensionVersion);
  const fixed = parsed !== null && atLeast(parsed, FIXED_IN);
  const features = Array.isArray(provider?.features) ? provider.features : null;
  const has = (feature: string): boolean => (features ? features.includes(feature) : fixed);
  return {
    extensionVersion,
    directContractCalls: has(ZUNIA_SIGNING_FEATURES.directContractCalls),
    directSends32: has(ZUNIA_SIGNING_FEATURES.directSends32),
    directPoolmanager: features || fixed ? has(ZUNIA_SIGNING_FEATURES.directPoolmanager) : null,
    directExactOut: has(ZUNIA_SIGNING_FEATURES.directExactOut),
    aminoEscaping: has(ZUNIA_SIGNING_FEATURES.aminoEscaping),
    aminoPoolmanager: features?.includes(ZUNIA_SIGNING_FEATURES.aminoPoolmanager) ?? false,
  };
}

/** A contract call's body as text: bytes (CosmJS), base64 (proto-JSON) or an object. */
function contractBody(value: unknown): string | null {
  const msg = (value as { msg?: unknown } | null | undefined)?.msg;
  if (msg instanceof Uint8Array) return decoder.decode(msg);
  if (typeof msg === "string") {
    try {
      return decoder.decode(base64ToBytes(msg));
    } catch {
      return msg;
    }
  }
  if (msg && typeof msg === "object") return JSON.stringify(msg);
  return null;
}

function holdsEscaped(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (typeof value === "string") return ESCAPED.test(value);
  if (value instanceof Uint8Array) return ESCAPED.test(decoder.decode(value));
  if (Array.isArray(value)) return value.some((item) => holdsEscaped(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => holdsEscaped(item, depth + 1));
  }
  return false;
}

/** A `MsgSend` whose recipient bech32-decodes to 32 bytes, in CosmJS (`toAddress`) or proto-JSON (`to_address`) spelling. */
function sendsTo32Bytes(message: SignableMessage): boolean {
  if (message.typeUrl !== SEND) return false;
  const value = message.value as { toAddress?: unknown; to_address?: unknown } | null | undefined;
  const to = value?.toAddress ?? value?.to_address;
  if (typeof to !== "string") return false;
  const decoded = bech32.decodeUnsafe(to);
  const bytes = decoded ? bech32.fromWordsUnsafe(decoded.words) : undefined;
  return bytes instanceof Uint8Array && bytes.length === 32;
}

/**
 * Whether the Amino document would hold `&`, `<` or `>`: in the memo, or in
 * any free text of a message (a contract call's body, a packet memo).
 */
export function aminoNeedsEscaping(messages: readonly SignableMessage[], memo?: string): boolean {
  if (memo && ESCAPED.test(memo)) return true;
  return messages.some((message) => {
    if (message.typeUrl === EXECUTE_CONTRACT) {
      const body = contractBody(message.value);
      if (body !== null && ESCAPED.test(body)) return true;
    }
    return holdsEscaped(message.value, 0);
  });
}

export interface ZuniaSignModeInput {
  readonly messages: readonly SignableMessage[];
  readonly memo?: string;
  /** From `zuniaCapabilities(provider)`. Omitted means a build that reports nothing (0.1.4 or older). */
  readonly capabilities?: ZuniaCapabilities | null;
  /** Ethereum-key chains (Injective, Evmos): their ante handlers refuse legacy Amino, and their contracts are 20 bytes. */
  readonly ethKeyChain?: boolean;
}

/** The mode the Zunia extension can sign these messages in. See the module notes. */
export function zuniaSignMode(input: ZuniaSignModeInput): "direct" | "amino" {
  const capabilities = input.capabilities ?? zuniaCapabilities(undefined);
  if (capabilities.directContractCalls || input.ethKeyChain) return "direct";
  // Poolmanager has no Amino summary in the extension ("unknown"): Direct decodes it from 0.1.4.
  if (input.messages.some((message) => message.typeUrl.startsWith(POOLMANAGER))) return "direct";
  // What Direct refuses on these builds and Amino signs: a contract call, a send to a 32-byte address.
  const directRefuses = input.messages.some(
    (message) => message.typeUrl === EXECUTE_CONTRACT || (!capabilities.directSends32 && sendsTo32Bytes(message)),
  );
  if (!directRefuses) return "direct";
  return capabilities.aminoEscaping || !aminoNeedsEscaping(input.messages, input.memo) ? "amino" : "direct";
}
