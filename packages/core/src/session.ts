import type { ZuniaAccount, ZuniaKey, ZuniaOfflineSigner } from "./types.js";
import type { ZuniaConnectError } from "./errors.js";
import type {
  CreateConnectSessionResponse,
  ZuniaConnectAccount,
  ZuniaDappMetadata,
} from "./protocol.js";

export type ZuniaTransportKind = "extension" | "native-ws" | "walletconnect";

export type ZuniaSessionStatus =
  | "idle"
  | "connecting"
  | "awaiting_wallet"
  | "connected"
  | "signing"
  | "disconnected"
  | "error";

export interface ConnectOptions {
  chains: string | string[];
  metadata?: ZuniaDappMetadata;
  /** Prefer this transport; otherwise auto-select. */
  prefer?: ZuniaTransportKind | "auto";
  /** WalletConnect Cloud project id (required for WC transport). */
  walletConnectProjectId?: string;
  /** Backend API base for native WS, e.g. http://localhost:8788 */
  apiBase?: string;
  /** Public WS base override, e.g. ws://localhost:8788 */
  wsBase?: string;
  timeoutMs?: number;
  /** Open install URL when extension missing and no mobile path. */
  openInstallIfMissing?: boolean;
}

export interface ZuniaSessionAccount extends ZuniaConnectAccount {
  bech32Address?: string;
}

export interface ZuniaSessionEvents {
  status: (status: ZuniaSessionStatus) => void;
  accountsChanged: (accounts: ZuniaSessionAccount[]) => void;
  chainChanged: (chains: string[]) => void;
  pairing: (info: CreateConnectSessionResponse) => void;
  error: (error: ZuniaConnectError) => void;
  disconnect: (reason?: string) => void;
}

export interface ZuniaTransport {
  readonly kind: ZuniaTransportKind;
  connect(options: ConnectOptions): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  getAccounts(): Promise<ZuniaSessionAccount[]>;
  getKey(chainId: string): Promise<ZuniaKey>;
  getOfflineSigner(chainId: string): ZuniaOfflineSigner;
  signAmino(
    chainId: string,
    signer: string,
    signDoc: unknown,
  ): Promise<unknown>;
  signDirect(
    chainId: string,
    signer: string,
    signDoc: { bodyBytes: Uint8Array; authInfoBytes: Uint8Array },
  ): Promise<unknown>;
  signArbitrary?(
    chainId: string,
    signer: string,
    data: string | Uint8Array,
  ): Promise<unknown>;
  on?<K extends keyof ZuniaSessionEvents>(
    event: K,
    listener: ZuniaSessionEvents[K],
  ): void;
  off?<K extends keyof ZuniaSessionEvents>(
    event: K,
    listener: ZuniaSessionEvents[K],
  ): void;
}

export interface ZuniaSession {
  readonly transport: ZuniaTransportKind;
  readonly status: ZuniaSessionStatus;
  readonly accounts: ZuniaSessionAccount[];
  readonly chains: string[];
  /** Pairing info while awaiting wallet (native WS / WC). */
  readonly pairing?: CreateConnectSessionResponse;
  connect(options: ConnectOptions): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  getAccounts(): Promise<ZuniaSessionAccount[]>;
  getKey(chainId: string): Promise<ZuniaKey>;
  getOfflineSigner(chainId: string): ZuniaOfflineSigner;
  enable(chainIds: string | string[]): Promise<void>;
  signAmino(
    chainId: string,
    signer: string,
    signDoc: unknown,
  ): Promise<unknown>;
  signDirect(
    chainId: string,
    signer: string,
    signDoc: { bodyBytes: Uint8Array; authInfoBytes: Uint8Array },
  ): Promise<unknown>;
  signArbitrary(
    chainId: string,
    signer: string,
    data: string | Uint8Array,
  ): Promise<unknown>;
  on<K extends keyof ZuniaSessionEvents>(
    event: K,
    listener: ZuniaSessionEvents[K],
  ): void;
  off<K extends keyof ZuniaSessionEvents>(
    event: K,
    listener: ZuniaSessionEvents[K],
  ): void;
}

export function normalizeChainIds(chainIds: string | string[]): string[] {
  return Array.isArray(chainIds) ? chainIds : [chainIds];
}

export function accountsFromKey(
  chainId: string,
  key: ZuniaKey,
): ZuniaSessionAccount {
  let binary = "";
  for (const b of key.pubKey) binary += String.fromCharCode(b);
  const pubkey =
    typeof btoa !== "undefined"
      ? btoa(binary)
      : Buffer.from(key.pubKey).toString("base64");
  return {
    chainId,
    address: key.bech32Address || key.address,
    algo: key.algo,
    pubkey,
    name: key.name,
    bech32Address: key.bech32Address || key.address,
  };
}

export function toZuniaAccounts(
  accounts: ZuniaSessionAccount[],
): ZuniaAccount[] {
  return accounts.map((a) => {
    const decode =
      typeof atob !== "undefined"
        ? atob
        : (s: string) => Buffer.from(s, "base64").toString("binary");
    const raw = decode(a.pubkey);
    const pubkey = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) pubkey[i] = raw.charCodeAt(i);
    return {
      address: a.address,
      algo: a.algo,
      pubkey,
    };
  });
}
