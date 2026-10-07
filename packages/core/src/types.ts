import type { ZuniaProviderErrorCode } from "./errors.js";

/**
 * Provider and signing types. The signing shapes match CosmJS structurally, so
 * a Zunia offline signer can be passed to `SigningStargateClient` as is,
 * without this package depending on CosmJS.
 */

export type Algo = "secp256k1" | "ed25519" | "sr25519";

/** CosmJS `AccountData`. */
export interface AccountData {
  readonly address: string;
  readonly algo: Algo;
  readonly pubkey: Uint8Array;
}

/** CosmJS `StdSignature`: base64 key and signature. */
export interface StdSignature {
  readonly pub_key: { readonly type: string; readonly value: string };
  readonly signature: string;
}

export interface Coin {
  readonly denom: string;
  readonly amount: string;
}

export interface StdFee {
  readonly amount: readonly Coin[];
  readonly gas: string;
  readonly granter?: string;
  readonly payer?: string;
}

export interface AminoMsg {
  readonly type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly value: any;
}

/** CosmJS `StdSignDoc`. */
export interface StdSignDoc {
  readonly chain_id: string;
  readonly account_number: string;
  readonly sequence: string;
  readonly fee: StdFee;
  readonly msgs: readonly AminoMsg[];
  readonly memo: string;
  readonly timeout_height?: string;
}

/** CosmJS `SignDoc` as returned: the account number is a bigint. */
export interface SignDoc {
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  chainId: string;
  accountNumber: bigint;
}

/** What callers may pass: CosmJS uses bigint, older code Long, number or string. */
export interface SignDocInput {
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  chainId: string;
  accountNumber: bigint | number | string | { toString(): string };
}

export interface DirectSignResponse {
  readonly signed: SignDoc;
  readonly signature: StdSignature;
}

export interface AminoSignResponse {
  readonly signed: StdSignDoc;
  readonly signature: StdSignature;
}

/** A CosmJS `OfflineDirectSigner` and `OfflineAminoSigner` in one. */
export interface ZuniaOfflineSigner {
  getAccounts(): Promise<readonly AccountData[]>;
  signDirect(signerAddress: string, signDoc: SignDocInput): Promise<DirectSignResponse>;
  signAmino(signerAddress: string, signDoc: StdSignDoc): Promise<AminoSignResponse>;
}

/** Keplr-compatible key, as `window.zunia.getKey` returns it. */
export interface ZuniaKey {
  name: string;
  algo: string;
  pubKey: Uint8Array;
  address: Uint8Array | string;
  bech32Address: string;
  isNanoLedger?: boolean;
  isKeystone?: boolean;
}

/** Events `window.zunia` emits to connected sites. */
export type ZuniaProviderEvent =
  /** The active account changed, or was renamed. Read `getKey` again. */
  | "accountsChanged"
  /** The site's granted chains changed. Data: `{ chainIds }`, the chains still granted. */
  | "chainChanged"
  /** Access was revoked or expired. Data: `null` for every chain, or `{ chainIds }` for those lost. */
  | "disconnect"
  /** The wallet locked. Requests wait for the user to unlock. */
  | "locked"
  | "keplr_keystorechange";

/** Error thrown by `window.zunia` calls. */
export interface ZuniaProviderError extends Error {
  code: ZuniaProviderErrorCode;
}

/** The provider the Zunia extension injects as `window.zunia` (and `window.keplr`). */
export interface ZuniaProvider {
  /** Provider API version. Zunia 0.1.0 to 0.1.4 all answer "0.1.0": use `zuniaCapabilities`. */
  readonly version: string;
  /** The extension's own (manifest) version, from Zunia 0.1.5. */
  readonly extensionVersion?: string;
  /** What this build can sign (`ZUNIA_SIGNING_FEATURES`), from Zunia 0.1.5. */
  readonly features?: readonly string[];
  /** True on Zunia's provider, also when it is aliased as `window.keplr`. */
  readonly isZunia?: boolean;
  readonly mode: "extension" | "mobile" | "core" | "unknown";
  enable(chainIds: string | string[]): Promise<void>;
  disable?(chainIds?: string | string[]): Promise<void>;
  getKey(chainId: string): Promise<ZuniaKey>;
  getOfflineSigner(chainId: string): unknown;
  getOfflineSignerOnlyAmino?(chainId: string): unknown;
  getOfflineSignerAuto?(chainId: string): Promise<unknown>;
  experimentalSuggestChain?(chainInfo: unknown): Promise<void>;
  /** Chains this site may use now, without prompting. `[]` when not connected. */
  getConnectedChains?(): Promise<string[]>;
  /** Whether the wallet is locked. Connected sites only. */
  isLocked?(): Promise<boolean>;
  signAmino?(chainId: string, signer: string, signDoc: StdSignDoc, signOptions?: unknown): Promise<unknown>;
  signDirect?(chainId: string, signer: string, signDoc: unknown, signOptions?: unknown): Promise<unknown>;
  signArbitrary?(chainId: string, signer: string, data: string | Uint8Array): Promise<StdSignature>;
  verifyArbitrary?(chainId: string, signer: string, data: string | Uint8Array, signature: StdSignature): Promise<boolean>;
  on?(event: ZuniaProviderEvent | (string & {}), listener: (data?: unknown) => void): void;
  off?(event: ZuniaProviderEvent | (string & {}), listener: (data?: unknown) => void): void;
}
