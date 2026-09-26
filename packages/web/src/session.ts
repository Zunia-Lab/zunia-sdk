import {
  ZUNIA_CONNECT_BUTTON,
  ZuniaConnectError,
  buildSignInMessage,
  keyFromAccount,
  normalizeChainIds,
  toZuniaConnectError,
  type AccountData,
  type AminoSignResponse,
  type DirectSignResponse,
  type SignDocInput,
  type SignInOptions,
  type SignInResult,
  type StdSignDoc,
  type StdSignature,
  type SuggestedChain,
  type ZuniaAccountInfo,
  type ZuniaKey,
  type ZuniaOfflineSigner,
  type ZuniaPairing,
  type ZuniaSession,
  type ZuniaSessionEvents,
  type ZuniaSessionStatus,
  type ZuniaTransport,
  type ZuniaTransportKind,
} from "@zunialab/sdk-core";
import { getZunia } from "./detect.js";
import { EventBus } from "./events.js";
import { STORAGE_KEYS, readJson, removeKey, resolveStorage, writeJson } from "./storage.js";
import { ExtensionTransport, type ExtensionTransportOptions } from "./transports/extension.js";
import { NativeWsTransport, type NativeWsTransportOptions } from "./transports/native-ws.js";
import {
  WalletConnectTransport,
  type ZuniaWebConnectOptions,
  type ZuniaWebRestoreOptions,
} from "./transports/walletconnect.js";

export interface ZuniaSessionOptions {
  extension?: ExtensionTransportOptions;
  nativeWs?: NativeWsTransportOptions;
  walletConnect?: { loadSignClient?: () => Promise<unknown> };
}

/** Everything a UI shows, as one immutable object that changes identity on every update. */
export interface ZuniaSessionSnapshot {
  readonly status: ZuniaSessionStatus;
  readonly transport: ZuniaTransportKind | null;
  readonly accounts: readonly ZuniaAccountInfo[];
  readonly chains: readonly string[];
  readonly pairing: ZuniaPairing | undefined;
  readonly verificationCode: string | undefined;
  readonly error: ZuniaConnectError | undefined;
}

const KINDS: readonly ZuniaTransportKind[] = ["extension", "native-ws", "walletconnect"];
const SIGN_IN_TTL_MS = 10 * 60_000;

function isoOrUndefined(value: string | Date | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * One connection to a Zunia wallet, whatever carries it: the extension, a
 * phone paired by QR code, or WalletConnect. Results have the same shape on
 * every transport.
 */
export class ZuniaSessionImpl implements ZuniaSession {
  private active: ZuniaTransport | null = null;
  private unwire: (() => void) | null = null;
  private restoring: Promise<boolean> | null = null;
  private readonly bus = new EventBus<ZuniaSessionEvents>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ZuniaSessionSnapshot = {
    status: "idle",
    transport: null,
    accounts: [],
    chains: [],
    pairing: undefined,
    verificationCode: undefined,
    error: undefined,
  };

  constructor(private readonly options: ZuniaSessionOptions = {}) {}

  get transport(): ZuniaTransportKind | null {
    return this.snapshot.transport;
  }

  get status(): ZuniaSessionStatus {
    return this.snapshot.status;
  }

  get accounts(): ZuniaAccountInfo[] {
    return [...this.snapshot.accounts];
  }

  get chains(): string[] {
    return [...this.snapshot.chains];
  }

  get pairing(): ZuniaPairing | undefined {
    return this.snapshot.pairing;
  }

  get verificationCode(): string | undefined {
    return this.snapshot.verificationCode;
  }

  on<K extends keyof ZuniaSessionEvents>(event: K, listener: ZuniaSessionEvents[K]): void {
    this.bus.on(event, listener);
  }

  off<K extends keyof ZuniaSessionEvents>(event: K, listener: ZuniaSessionEvents[K]): void {
    this.bus.off(event, listener);
  }

  /** For `useSyncExternalStore` and other stores: called after every change. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ZuniaSessionSnapshot => this.snapshot;

  async connect(options: ZuniaWebConnectOptions): Promise<void> {
    if (normalizeChainIds(options.chains).length === 0) {
      throw new ZuniaConnectError("INVALID_PARAMS", "Pass at least one chain id");
    }
    await this.drop();
    this.update({ error: undefined, pairing: undefined, verificationCode: undefined });
    let kind: ZuniaTransportKind;
    try {
      kind = await this.pick(options);
    } catch (error) {
      const failure = toZuniaConnectError(error);
      this.update({ error: failure });
      this.bus.emit("error", failure);
      throw failure;
    }
    const transport = this.create(kind);
    this.attach(transport);
    try {
      await transport.connect(options);
    } catch (error) {
      const failure = toZuniaConnectError(error);
      this.detach();
      this.update({ status: "disconnected", transport: null, accounts: [], chains: [], pairing: undefined, error: failure });
      this.bus.emit("error", failure);
      throw failure;
    }
    writeJson(resolveStorage(options.storage), STORAGE_KEYS.transport, { kind });
  }

  /** Reattaches to the last session without prompting. Resolves false when there is none. */
  restore(options: ZuniaWebRestoreOptions = {}): Promise<boolean> {
    if (this.restoring) return this.restoring;
    const live = ["connected", "locked", "reconnecting"].includes(this.snapshot.status);
    if (this.active && live) return Promise.resolve(true);
    this.restoring = this.restoreNow(options).finally(() => {
      this.restoring = null;
    });
    return this.restoring;
  }

  private async restoreNow(options: ZuniaWebRestoreOptions): Promise<boolean> {
    const storage = resolveStorage(options.storage);
    const saved = (readJson(storage, STORAGE_KEYS.transport) as { kind?: unknown } | null)?.kind;
    const first = KINDS.find((kind) => kind === saved);
    const order = first ? [first, ...KINDS.filter((kind) => kind !== first)] : KINDS;
    for (const kind of order) {
      const transport = this.create(kind);
      this.attach(transport);
      let ok = false;
      try {
        ok = await transport.restore(options);
      } catch {
        ok = false;
      }
      if (ok) {
        writeJson(storage, STORAGE_KEYS.transport, { kind });
        return true;
      }
      this.detach();
    }
    removeKey(storage, STORAGE_KEYS.transport);
    this.update({ status: "idle", transport: null, accounts: [], chains: [] });
    return false;
  }

  async disconnect(reason = "user"): Promise<void> {
    await this.drop(reason);
  }

  getAccounts(): ZuniaAccountInfo[] {
    return this.accounts;
  }

  /** Keplr-style key for `chainId`, from the accounts already shared. */
  getKey(chainId: string): ZuniaKey {
    const account = this.snapshot.accounts.find((item) => item.chainId === chainId);
    if (!account) throw new ZuniaConnectError("NOT_CONNECTED", `No account on ${chainId}`);
    return keyFromAccount(account);
  }

  /** A CosmJS signer (Direct and Amino) for `SigningStargateClient`. */
  getOfflineSigner(chainId: string): ZuniaOfflineSigner {
    return {
      getAccounts: async () => this.accountData(chainId),
      signDirect: (signerAddress, signDoc) => this.signDirect(chainId, signerAddress, signDoc),
      signAmino: (signerAddress, signDoc) => this.signAmino(chainId, signerAddress, signDoc),
    };
  }

  /** A CosmJS Amino-only signer, for chains or hardware that need Amino JSON. */
  getOfflineSignerOnlyAmino(chainId: string): Pick<ZuniaOfflineSigner, "getAccounts" | "signAmino"> {
    return {
      getAccounts: async () => this.accountData(chainId),
      signAmino: (signerAddress, signDoc) => this.signAmino(chainId, signerAddress, signDoc),
    };
  }

  signAmino(chainId: string, signer: string, signDoc: StdSignDoc): Promise<AminoSignResponse> {
    return this.run((transport) => transport.signAmino(chainId, signer, signDoc));
  }

  signDirect(chainId: string, signer: string, signDoc: SignDocInput): Promise<DirectSignResponse> {
    return this.run((transport) => transport.signDirect(chainId, signer, signDoc));
  }

  signArbitrary(chainId: string, signer: string, data: string | Uint8Array): Promise<StdSignature> {
    return this.run((transport) => transport.signArbitrary(chainId, signer, data));
  }

  suggestChain(chain: SuggestedChain): Promise<void> {
    return this.run((transport) => transport.suggestChain(chain));
  }

  /**
   * Asks the wallet to sign a sign-in message for this site. Send the result
   * to your server and check it there with `verifySignIn` from sdk-core.
   */
  async signIn(options: SignInOptions): Promise<SignInResult> {
    const chainId = options.chainId ?? this.snapshot.chains[0];
    const account = this.snapshot.accounts.find((item) => item.chainId === chainId);
    if (!chainId || !account) throw new ZuniaConnectError("NOT_CONNECTED", "Connect a wallet before signing in");
    const loc = typeof location === "undefined" ? undefined : location;
    const domain = options.domain ?? loc?.host;
    const uri = options.uri ?? loc?.origin;
    if (!domain || !uri) throw new ZuniaConnectError("INVALID_PARAMS", "Pass domain and uri when not running in a page");
    const issuedAt = new Date();
    const message = buildSignInMessage({
      domain,
      address: account.address,
      statement: options.statement,
      uri,
      chainId,
      nonce: options.nonce,
      issuedAt: issuedAt.toISOString(),
      expirationTime: isoOrUndefined(options.expirationTime) ?? new Date(issuedAt.getTime() + SIGN_IN_TTL_MS).toISOString(),
      notBefore: isoOrUndefined(options.notBefore),
      requestId: options.requestId,
      resources: options.resources,
    });
    const signature = await this.signArbitrary(chainId, account.address, message);
    return { message, signature, address: account.address, chainId, pubKey: account.pubkey };
  }

  private accountData(chainId: string): AccountData[] {
    return this.snapshot.accounts
      .filter((account) => account.chainId === chainId)
      .map(({ address, algo, pubkey }) => ({ address, algo, pubkey }));
  }

  private async run<T>(call: (transport: ZuniaTransport) => Promise<T>): Promise<T> {
    const transport = this.active;
    if (!transport || this.snapshot.status === "disconnected" || this.snapshot.status === "idle") {
      throw new ZuniaConnectError("NOT_CONNECTED", "Connect a wallet first");
    }
    try {
      return await call(transport);
    } catch (error) {
      throw toZuniaConnectError(error);
    }
  }

  private async pick(options: ZuniaWebConnectOptions): Promise<ZuniaTransportKind> {
    const prefer = options.prefer ?? "auto";
    if (prefer !== "auto") {
      if (!KINDS.includes(prefer)) throw new ZuniaConnectError("INVALID_PARAMS", `Unknown transport ${String(prefer)}`);
      return prefer;
    }
    if (this.options.extension?.provider || (await getZunia({ timeoutMs: 1_000 }))) return "extension";
    if (options.apiBase) return "native-ws";
    if (options.walletConnectProjectId && (options.loadWalletConnect || this.options.walletConnect?.loadSignClient)) {
      return "walletconnect";
    }
    if (options.openInstallIfMissing !== false && typeof window !== "undefined") {
      window.open(ZUNIA_CONNECT_BUTTON.installUrl, "_blank", "noopener,noreferrer");
    }
    throw new ZuniaConnectError(
      "NOT_INSTALLED",
      "The Zunia extension is not installed, and neither QR pairing (apiBase) nor WalletConnect is set up",
    );
  }

  private create(kind: ZuniaTransportKind): ZuniaTransport {
    if (kind === "extension") return new ExtensionTransport(this.options.extension);
    if (kind === "native-ws") return new NativeWsTransport(this.options.nativeWs);
    return new WalletConnectTransport(this.options.walletConnect);
  }

  private attach(transport: ZuniaTransport): void {
    this.detach();
    this.active = transport;
    this.update({ transport: transport.kind });
    const live = () => this.active === transport;
    const handlers: { [K in keyof ZuniaSessionEvents]: ZuniaSessionEvents[K] } = {
      status: (status) => {
        if (!live()) return;
        const settled = status === "connected" || status === "disconnected";
        this.update({
          status,
          ...(settled ? { pairing: undefined } : {}),
          ...(status === "disconnected" ? { verificationCode: undefined, accounts: [], chains: [] } : {}),
        });
        this.bus.emit("status", status);
      },
      accountsChanged: (accounts) => {
        if (!live()) return;
        this.update({ accounts });
        this.bus.emit("accountsChanged", accounts);
      },
      chainChanged: (chains) => {
        if (!live()) return;
        this.update({ chains });
        this.bus.emit("chainChanged", chains);
      },
      pairing: (pairing) => {
        if (!live()) return;
        this.update({ pairing });
        this.bus.emit("pairing", pairing);
      },
      verification: (code) => {
        if (!live()) return;
        this.update({ verificationCode: code });
        this.bus.emit("verification", code);
      },
      disconnect: (reason) => {
        if (!live()) return;
        this.update({ accounts: [], chains: [], pairing: undefined, verificationCode: undefined });
        this.bus.emit("disconnect", reason);
      },
      error: (error) => {
        if (!live()) return;
        this.update({ error });
        this.bus.emit("error", error);
      },
    };
    for (const event of Object.keys(handlers) as Array<keyof ZuniaSessionEvents>) {
      transport.on(event, handlers[event] as never);
    }
    this.unwire = () => {
      for (const event of Object.keys(handlers) as Array<keyof ZuniaSessionEvents>) {
        transport.off(event, handlers[event] as never);
      }
    };
  }

  private detach(): void {
    this.unwire?.();
    this.unwire = null;
    this.active = null;
  }

  private async drop(reason?: string): Promise<void> {
    const transport = this.active;
    if (!transport) return;
    try {
      await transport.disconnect(reason);
    } finally {
      this.detach();
      this.update({ status: "disconnected", transport: null, accounts: [], chains: [], pairing: undefined, verificationCode: undefined });
    }
  }

  private update(patch: Partial<ZuniaSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        setTimeout(() => {
          throw error;
        }, 0);
      }
    }
  }
}

export function createZuniaSession(options?: ZuniaSessionOptions): ZuniaSessionImpl {
  return new ZuniaSessionImpl(options);
}

/** Connects with the best available transport: the extension, then QR pairing, then WalletConnect. */
export async function connectWithZunia(options: ZuniaWebConnectOptions, sessionOptions?: ZuniaSessionOptions): Promise<ZuniaSessionImpl> {
  const session = new ZuniaSessionImpl(sessionOptions);
  await session.connect(options);
  return session;
}

/** The session from a previous visit, or null. Never prompts the user. */
export async function restoreSession(
  options?: ZuniaWebRestoreOptions,
  sessionOptions?: ZuniaSessionOptions,
): Promise<ZuniaSessionImpl | null> {
  const session = new ZuniaSessionImpl(sessionOptions);
  return (await session.restore(options)) ? session : null;
}

export function createExtensionSession(options: ZuniaWebConnectOptions, sessionOptions?: ZuniaSessionOptions): Promise<ZuniaSessionImpl> {
  return connectWithZunia({ ...options, prefer: "extension" }, sessionOptions);
}

export function createZuniaWsSession(options: ZuniaWebConnectOptions, sessionOptions?: ZuniaSessionOptions): Promise<ZuniaSessionImpl> {
  return connectWithZunia({ ...options, prefer: "native-ws" }, sessionOptions);
}

export function createWalletConnectSession(options: ZuniaWebConnectOptions, sessionOptions?: ZuniaSessionOptions): Promise<ZuniaSessionImpl> {
  return connectWithZunia({ ...options, prefer: "walletconnect" }, sessionOptions);
}
