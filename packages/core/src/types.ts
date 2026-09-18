/** Shared provider / account types for Zunia integrations. */

export interface ZuniaAccount {
  address: string;
  algo: string;
  pubkey: Uint8Array;
}

export interface ZuniaKey {
  name: string;
  algo: string;
  pubKey: Uint8Array;
  address: string;
  bech32Address: string;
  isNanoLedger?: boolean;
  isKeystone?: boolean;
}

export interface ZuniaOfflineSigner {
  getAccounts(): Promise<ZuniaAccount[]>;
  signAmino?(...args: unknown[]): Promise<unknown>;
  signDirect?(...args: unknown[]): Promise<unknown>;
}

export type ZuniaProviderEvent =
  | "keplr_keystorechange"
  | "accountsChanged"
  | "chainChanged"
  | "zunia#initialized";

/** Cosmos-compatible wallet provider (extension injects this as window.zunia). */
export interface ZuniaProvider {
  readonly version: string;
  readonly mode: "extension" | "mobile" | "unknown";
  enable(chainIds: string | string[]): Promise<void>;
  disable?(chainIds?: string | string[]): Promise<void>;
  getKey(chainId: string): Promise<ZuniaKey>;
  getAccounts?(chainId: string): Promise<ZuniaAccount[]>;
  getOfflineSigner(chainId: string): ZuniaOfflineSigner;
  getOfflineSignerOnlyAmino?(chainId: string): ZuniaOfflineSigner;
  getOfflineSignerAuto?(chainId: string): Promise<ZuniaOfflineSigner>;
  experimentalSuggestChain?(chainInfo: unknown): Promise<void>;
  getChainInfosWithoutEndpoints?(): Promise<unknown[]>;
  /**
   * Intentionally unsupported on the provider: dApps must broadcast themselves.
   * Wallet-originated txs broadcast inside the wallet apps.
   */
  sendTx?(...args: unknown[]): Promise<never>;
  signAmino?(...args: unknown[]): Promise<unknown>;
  signDirect?(...args: unknown[]): Promise<unknown>;
  signArbitrary?(
    chainId: string,
    signer: string,
    data: string | Uint8Array,
  ): Promise<unknown>;
  verifyArbitrary?(...args: unknown[]): Promise<boolean>;
  on?(event: ZuniaProviderEvent | string, listener: (...args: unknown[]) => void): void;
  off?(event: ZuniaProviderEvent | string, listener: (...args: unknown[]) => void): void;
}
