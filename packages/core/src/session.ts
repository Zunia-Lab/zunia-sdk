import type { ZuniaConnectError } from "./errors.js";
import type { ZuniaDappMetadata } from "./protocol.js";
import type {
  AccountData,
  AminoSignResponse,
  DirectSignResponse,
  SignDocInput,
  StdSignDoc,
  StdSignature,
  ZuniaKey,
  ZuniaOfflineSigner,
} from "./types.js";

export type ZuniaTransportKind = "extension" | "native-ws" | "walletconnect";

export type ZuniaSessionStatus =
  | "idle"
  | "connecting"
  /** A QR code or WalletConnect link is waiting to be scanned. */
  | "awaiting_wallet"
  | "connected"
  /** The link to the relay dropped; retrying with the session token. */
  | "reconnecting"
  /** Connected, but the wallet is locked. Requests wait for the unlock. */
  | "locked"
  | "disconnected"
  | "error";

/** An account with its chain. Compatible with CosmJS `AccountData`. */
export interface ZuniaAccountInfo extends AccountData {
  readonly chainId: string;
  readonly name?: string;
}

/** What to render while a phone pairs: a QR code of `uri`, or a deep link to it on mobile. */
export interface ZuniaPairing {
  transport: "native-ws" | "walletconnect";
  uri: string;
  expiresAt?: number;
}

export interface ZuniaSessionEvents {
  status: (status: ZuniaSessionStatus) => void;
  accountsChanged: (accounts: ZuniaAccountInfo[]) => void;
  chainChanged: (chains: string[]) => void;
  pairing: (pairing: ZuniaPairing) => void;
  /** QR pairing only: the 6-digit code the phone must also show. */
  verification: (code: string) => void;
  disconnect: (reason: string) => void;
  error: (error: ZuniaConnectError) => void;
}

/** Where sessions persist for `restoreSession`. `localStorage` by default in browsers. */
export interface ZuniaStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ConnectOptions {
  chains: string | string[];
  metadata?: ZuniaDappMetadata;
  /** Transport to use. `auto` picks the extension, then the QR relay, then WalletConnect. */
  prefer?: ZuniaTransportKind | "auto";
  /** WalletConnect Cloud project id, for the WalletConnect transport. */
  walletConnectProjectId?: string;
  /** Relay HTTP base for QR pairing, e.g. `https://api.zunialab.com`. */
  apiBase?: string;
  /** Relay WebSocket base, when it differs from what the relay announces. */
  wsBase?: string;
  /** How long to wait for the user to approve the connection. Default 5 minutes. */
  timeoutMs?: number;
  /** How long to wait for each signature. Default 5 minutes. */
  requestTimeoutMs?: number;
  /** Where to persist the session. `null` keeps it in memory only. */
  storage?: ZuniaStorage | null;
  /** Open the install page when nothing can connect. Default true. */
  openInstallIfMissing?: boolean;
}

export type RestoreOptions = Omit<ConnectOptions, "chains" | "prefer" | "openInstallIfMissing"> & {
  chains?: string | string[];
};

export interface SignInOptions {
  /** A fresh nonce from your server (`createNonce()`), accepted once. */
  nonce: string;
  /** Chain to sign in with. Defaults to the first connected chain. */
  chainId?: string;
  statement?: string;
  /** When the sign-in stops being valid. Defaults to 10 minutes after issue. */
  expirationTime?: string | Date;
  notBefore?: string | Date;
  requestId?: string;
  resources?: string[];
  /** Defaults to `location.host`. */
  domain?: string;
  /** Defaults to `location.origin`. */
  uri?: string;
}

/** Send all of it to your server and call `verifySignIn` there. */
export interface SignInResult {
  message: string;
  signature: StdSignature;
  address: string;
  chainId: string;
  pubKey: Uint8Array;
}

export interface ZuniaTransport {
  readonly kind: ZuniaTransportKind;
  connect(options: ConnectOptions): Promise<void>;
  /** Reattach to a session without prompting. Resolves false when there is none. */
  restore(options: RestoreOptions): Promise<boolean>;
  disconnect(reason?: string): Promise<void>;
  getAccounts(): ZuniaAccountInfo[];
  getChains(): string[];
  signAmino(chainId: string, signer: string, signDoc: StdSignDoc): Promise<AminoSignResponse>;
  signDirect(chainId: string, signer: string, signDoc: SignDocInput): Promise<DirectSignResponse>;
  signArbitrary(chainId: string, signer: string, data: string | Uint8Array): Promise<StdSignature>;
  on<K extends keyof ZuniaSessionEvents>(event: K, listener: ZuniaSessionEvents[K]): void;
  off<K extends keyof ZuniaSessionEvents>(event: K, listener: ZuniaSessionEvents[K]): void;
}

export interface ZuniaSession {
  readonly transport: ZuniaTransportKind | null;
  readonly status: ZuniaSessionStatus;
  readonly accounts: ZuniaAccountInfo[];
  readonly chains: string[];
  readonly pairing: ZuniaPairing | undefined;
  readonly verificationCode: string | undefined;
  connect(options: ConnectOptions): Promise<void>;
  restore(options?: RestoreOptions): Promise<boolean>;
  disconnect(reason?: string): Promise<void>;
  getAccounts(): ZuniaAccountInfo[];
  getKey(chainId: string): ZuniaKey;
  getOfflineSigner(chainId: string): ZuniaOfflineSigner;
  signAmino(chainId: string, signer: string, signDoc: StdSignDoc): Promise<AminoSignResponse>;
  signDirect(chainId: string, signer: string, signDoc: SignDocInput): Promise<DirectSignResponse>;
  signArbitrary(chainId: string, signer: string, data: string | Uint8Array): Promise<StdSignature>;
  signIn(options: SignInOptions): Promise<SignInResult>;
  on<K extends keyof ZuniaSessionEvents>(event: K, listener: ZuniaSessionEvents[K]): void;
  off<K extends keyof ZuniaSessionEvents>(event: K, listener: ZuniaSessionEvents[K]): void;
}

export function normalizeChainIds(chainIds: string | readonly string[]): string[] {
  const list = typeof chainIds === "string" ? [chainIds] : [...chainIds];
  return [...new Set(list.map((id) => id.trim()).filter(Boolean))];
}
