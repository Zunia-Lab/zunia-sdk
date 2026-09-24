import {
  ZUNIA_WALLETCONNECT,
  ZUNIA_WALLET,
  ZuniaConnectError,
  accountFromWire,
  accountNumberToString,
  bytesToBase64,
  normalizeAminoResponse,
  normalizeChainIds,
  normalizeDirectResponse,
  normalizeStdSignature,
  toZuniaConnectError,
  type AminoSignResponse,
  type ConnectOptions,
  type DirectSignResponse,
  type RestoreOptions,
  type SignDocInput,
  type StdSignDoc,
  type StdSignature,
  type WireAccount,
  type ZuniaAccountInfo,
  type ZuniaPairing,
  type ZuniaSessionEvents,
  type ZuniaSessionStatus,
  type ZuniaStorage,
  type ZuniaTransport,
} from "@zunialab/sdk-core";
import { EventBus } from "../events.js";
import { STORAGE_KEYS, readJson, removeKey, resolveStorage, writeJson } from "../storage.js";

/** The parts of a WalletConnect `SignClient` this transport uses. */
export interface WalletConnectSession {
  topic: string;
  /** Seconds since the epoch. */
  expiry: number;
  namespaces: Record<string, { accounts: string[]; methods?: string[]; events?: string[]; chains?: string[] }>;
}

export interface WalletConnectClient {
  connect(params: { optionalNamespaces: Record<string, unknown> }): Promise<{ uri?: string; approval(): Promise<WalletConnectSession> }>;
  request(params: { topic: string; chainId: string; request: { method: string; params: unknown } }): Promise<unknown>;
  disconnect(params: { topic: string; reason: { code: number; message: string } }): Promise<void>;
  on(event: string, listener: (args: never) => void): unknown;
  off?(event: string, listener: (args: never) => void): unknown;
  session: { getAll(): WalletConnectSession[] };
}

export interface WalletConnectClientFactory {
  init(options: {
    projectId: string;
    metadata: { name: string; description: string; url: string; icons: string[] };
  }): Promise<WalletConnectClient>;
}

/** Connect options for the web SDK. */
export interface ZuniaWebConnectOptions extends ConnectOptions {
  /**
   * Loads WalletConnect, e.g. `() => import("@walletconnect/sign-client")`.
   * Passed in rather than imported so apps without WalletConnect still build.
   */
  loadWalletConnect?: () => Promise<unknown>;
}

export type ZuniaWebRestoreOptions = RestoreOptions & Pick<ZuniaWebConnectOptions, "loadWalletConnect">;

interface StoredWalletConnect {
  topic: string;
  accounts: WireAccount[];
  chains: string[];
}

interface WcEventArgs {
  topic: string;
  params?: { event?: { name?: string }; namespaces?: WalletConnectSession["namespaces"] };
}

const PAIRING_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function factoryFrom(mod: unknown): WalletConnectClientFactory {
  const candidates = [mod, (mod as { SignClient?: unknown })?.SignClient, (mod as { default?: unknown })?.default];
  const found = candidates.find((item) => typeof (item as { init?: unknown } | undefined)?.init === "function");
  if (!found) throw new ZuniaConnectError("UNSUPPORTED", "loadWalletConnect did not return @walletconnect/sign-client");
  return found as WalletConnectClientFactory;
}

function wcError(error: unknown): ZuniaConnectError {
  if (error instanceof ZuniaConnectError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? error);
  if (code === 4001 || code === 5000 || code === 5002 || /reject/i.test(message)) {
    return new ZuniaConnectError("USER_REJECTED", message || "The wallet declined", error);
  }
  return toZuniaConnectError(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ZuniaConnectError("TIMEOUT", message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** `cosmos:<chainId>:<address>` entries the session approved, by chain. */
function approvedAddresses(session: WalletConnectSession): Map<string, Set<string>> {
  const byChain = new Map<string, Set<string>>();
  for (const entry of session.namespaces.cosmos?.accounts ?? []) {
    const [namespace, chainId, address] = entry.split(":");
    if (namespace !== "cosmos" || !chainId || !address) continue;
    const set = byChain.get(chainId) ?? new Set<string>();
    set.add(address);
    byChain.set(chainId, set);
  }
  return byChain;
}

/**
 * Any WalletConnect v2 Cosmos wallet. Public keys come from
 * `cosmos_getAccounts`, so CosmJS can build transactions with them.
 */
export class WalletConnectTransport implements ZuniaTransport {
  readonly kind = "walletconnect" as const;
  private readonly bus = new EventBus<ZuniaSessionEvents>();
  private client: WalletConnectClient | null = null;
  private topic: string | null = null;
  private accounts: ZuniaAccountInfo[] = [];
  private chains: string[] = [];
  private status: ZuniaSessionStatus = "idle";
  private storage: ZuniaStorage | null = null;
  private requestTimeoutMs = DEFAULT_TIMEOUT_MS;
  private currentPairing: ZuniaPairing | undefined;
  private detach: (() => void) | null = null;

  constructor(private readonly options: { loadSignClient?: () => Promise<unknown> } = {}) {}

  get pairing(): ZuniaPairing | undefined {
    return this.currentPairing;
  }

  on<K extends keyof ZuniaSessionEvents>(event: K, listener: ZuniaSessionEvents[K]): void {
    this.bus.on(event, listener);
  }

  off<K extends keyof ZuniaSessionEvents>(event: K, listener: ZuniaSessionEvents[K]): void {
    this.bus.off(event, listener);
  }

  getAccounts(): ZuniaAccountInfo[] {
    return [...this.accounts];
  }

  getChains(): string[] {
    return [...this.chains];
  }

  async connect(options: ZuniaWebConnectOptions): Promise<void> {
    const chains = normalizeChainIds(options.chains);
    if (chains.length === 0) throw new ZuniaConnectError("INVALID_PARAMS", "Pass at least one chain id");
    if (this.topic) await this.disconnect("replaced");
    this.storage = resolveStorage(options.storage);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setStatus("connecting");
    try {
      const client = await this.init(options);
      const { uri, approval } = await client.connect({
        optionalNamespaces: {
          cosmos: {
            chains: chains.map((id) => `cosmos:${id}`),
            methods: [...ZUNIA_WALLETCONNECT.cosmosMethods],
            events: [...ZUNIA_WALLETCONNECT.cosmosEvents],
          },
        },
      });
      if (uri) {
        this.currentPairing = { transport: "walletconnect", uri, expiresAt: Date.now() + PAIRING_TTL_MS };
        this.bus.emit("pairing", this.currentPairing);
        this.setStatus("awaiting_wallet");
      }
      const session = await withTimeout(approval(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "Nobody approved the connection in time");
      const approved = approvedAddresses(session);
      const granted = chains.filter((id) => approved.has(id));
      if (granted.length === 0) {
        await client.disconnect({ topic: session.topic, reason: { code: 6000, message: "No requested chain approved" } }).catch(() => {});
        throw new ZuniaConnectError("UNKNOWN_CHAIN", "The wallet approved none of the requested chains");
      }
      this.topic = session.topic;
      this.chains = granted;
      this.subscribe(client);
      await this.loadAccounts(session);
    } catch (error) {
      const topic = this.topic;
      this.release();
      if (topic) void this.client?.disconnect({ topic, reason: { code: 6000, message: "User disconnected." } }).catch(() => {});
      this.setStatus("disconnected");
      throw wcError(error);
    }
    this.currentPairing = undefined;
    this.persist();
    this.bus.emit("chainChanged", this.getChains());
    this.setStatus("connected");
  }

  async restore(options: ZuniaWebRestoreOptions): Promise<boolean> {
    if (!options.walletConnectProjectId || !(this.options.loadSignClient ?? options.loadWalletConnect)) return false;
    this.storage = resolveStorage(options.storage);
    const stored = readJson(this.storage, STORAGE_KEYS.walletConnectSession) as StoredWalletConnect | null;
    if (!stored || typeof stored.topic !== "string" || !Array.isArray(stored.accounts) || !Array.isArray(stored.chains)) return false;
    try {
      const client = await this.init(options);
      const session = client.session.getAll().find((item) => item.topic === stored.topic && item.expiry * 1000 > Date.now());
      if (!session) {
        removeKey(this.storage, STORAGE_KEYS.walletConnectSession);
        return false;
      }
      const approved = approvedAddresses(session);
      const wanted = options.chains ? normalizeChainIds(options.chains) : null;
      const chains = normalizeChainIds(stored.chains).filter((id) => approved.has(id) && (!wanted || wanted.includes(id)));
      if (chains.length === 0) return false;
      this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.topic = session.topic;
      this.chains = chains;
      this.accounts = stored.accounts
        .map(accountFromWire)
        .filter((account) => chains.includes(account.chainId) && approved.get(account.chainId)?.has(account.address));
      this.subscribe(client);
    } catch {
      this.release();
      return false;
    }
    this.bus.emit("accountsChanged", this.getAccounts());
    this.bus.emit("chainChanged", this.getChains());
    this.setStatus("connected");
    return true;
  }

  async disconnect(reason = "user"): Promise<void> {
    const client = this.client;
    const topic = this.topic;
    if (!topic) return;
    this.end(reason);
    try {
      await client?.disconnect({ topic, reason: { code: 6000, message: "User disconnected." } });
    } catch {
      // The wallet already dropped the session.
    }
  }

  async signAmino(chainId: string, signer: string, signDoc: StdSignDoc): Promise<AminoSignResponse> {
    const raw = await this.request(chainId, "cosmos_signAmino", { signerAddress: signer, signDoc });
    return normalizeAminoResponse(raw, signDoc);
  }

  async signDirect(chainId: string, signer: string, signDoc: SignDocInput): Promise<DirectSignResponse> {
    const raw = await this.request(chainId, "cosmos_signDirect", {
      signerAddress: signer,
      signDoc: {
        chainId: signDoc.chainId,
        accountNumber: accountNumberToString(signDoc.accountNumber),
        authInfoBytes: bytesToBase64(signDoc.authInfoBytes),
        bodyBytes: bytesToBase64(signDoc.bodyBytes),
      },
    });
    return normalizeDirectResponse(raw, signDoc);
  }

  /** Not part of the WalletConnect Cosmos spec; works with wallets that add it. */
  async signArbitrary(chainId: string, signer: string, data: string | Uint8Array): Promise<StdSignature> {
    const raw = await this.request(
      chainId,
      "cosmos_signArbitrary",
      typeof data === "string"
        ? { signerAddress: signer, data, encoding: "utf8" }
        : { signerAddress: signer, data: bytesToBase64(data), encoding: "base64" },
    );
    return normalizeStdSignature(raw);
  }

  private async init(options: ZuniaWebConnectOptions | ZuniaWebRestoreOptions): Promise<WalletConnectClient> {
    if (this.client) return this.client;
    const projectId = options.walletConnectProjectId;
    if (!projectId) throw new ZuniaConnectError("INVALID_PARAMS", "Pass walletConnectProjectId to use WalletConnect");
    const load = this.options.loadSignClient ?? options.loadWalletConnect;
    if (!load) {
      throw new ZuniaConnectError(
        "UNSUPPORTED",
        'Install @walletconnect/sign-client and pass loadWalletConnect: () => import("@walletconnect/sign-client")',
      );
    }
    const factory = factoryFrom(await load());
    const metadata = options.metadata;
    const loc = typeof location === "undefined" ? undefined : location;
    this.client = await factory.init({
      projectId,
      metadata: {
        name: metadata?.name ?? loc?.host ?? ZUNIA_WALLET.name,
        description: metadata?.description ?? "",
        url: metadata?.url ?? loc?.origin ?? ZUNIA_WALLET.url,
        icons: metadata?.icons ?? [],
      },
    });
    return this.client;
  }

  private async request(chainId: string, method: string, params: unknown): Promise<unknown> {
    const client = this.client;
    const topic = this.topic;
    if (!client || !topic) throw new ZuniaConnectError("NOT_CONNECTED", "Connect a WalletConnect wallet first");
    if (!this.chains.includes(chainId)) throw new ZuniaConnectError("NOT_CONNECTED", `The session does not include ${chainId}`);
    try {
      return await withTimeout(
        client.request({ topic, chainId: `cosmos:${chainId}`, request: { method, params } }),
        this.requestTimeoutMs,
        "The wallet did not answer in time",
      );
    } catch (error) {
      throw wcError(error);
    }
  }

  private async loadAccounts(session: WalletConnectSession): Promise<void> {
    const approved = approvedAddresses(session);
    const accounts: ZuniaAccountInfo[] = [];
    for (const chainId of this.chains) {
      const raw = await this.request(chainId, "cosmos_getAccounts", {});
      if (!Array.isArray(raw)) throw new ZuniaConnectError("UNSUPPORTED", "The wallet did not share its public keys");
      for (const item of raw as Array<{ address?: unknown; algo?: unknown; pubkey?: unknown }>) {
        if (typeof item?.address !== "string" || typeof item.pubkey !== "string") continue;
        if (!approved.get(chainId)?.has(item.address)) continue;
        accounts.push(
          accountFromWire({ chainId, address: item.address, algo: typeof item.algo === "string" ? item.algo : "secp256k1", pubKey: item.pubkey }),
        );
      }
    }
    if (accounts.length === 0) throw new ZuniaConnectError("UNSUPPORTED", "The wallet did not share its public keys");
    this.accounts = accounts;
    this.bus.emit("accountsChanged", this.getAccounts());
  }

  private subscribe(client: WalletConnectClient): void {
    this.detach?.();
    const mine = (args: WcEventArgs) => Boolean(this.topic) && args?.topic === this.topic;
    const onEvent = (args: WcEventArgs) => {
      if (!mine(args)) return;
      const name = args.params?.event?.name;
      if (name === "accountsChanged" || name === "chainChanged") void this.refresh();
    };
    const onUpdate = (args: WcEventArgs) => {
      if (!mine(args) || !args.params?.namespaces) return;
      void this.refresh(args.params.namespaces);
    };
    const onDelete = (args: WcEventArgs) => {
      if (mine(args)) this.end("deleted");
    };
    const onExpire = (args: WcEventArgs) => {
      if (mine(args)) this.end("expired");
    };
    client.on("session_event", onEvent);
    client.on("session_update", onUpdate);
    client.on("session_delete", onDelete);
    client.on("session_expire", onExpire);
    this.detach = () => {
      client.off?.("session_event", onEvent);
      client.off?.("session_update", onUpdate);
      client.off?.("session_delete", onDelete);
      client.off?.("session_expire", onExpire);
    };
  }

  private async refresh(namespaces?: WalletConnectSession["namespaces"]): Promise<void> {
    const client = this.client;
    const topic = this.topic;
    if (!client || !topic) return;
    const session = client.session.getAll().find((item) => item.topic === topic);
    const current = namespaces ? { topic, expiry: session?.expiry ?? 0, namespaces } : session;
    if (!current) return;
    const approved = approvedAddresses(current);
    const chains = this.chains.filter((id) => approved.has(id));
    if (chains.length === 0) return this.end("revoked");
    if (chains.join() !== this.chains.join()) {
      this.chains = chains;
      this.bus.emit("chainChanged", this.getChains());
    }
    try {
      await this.loadAccounts(current);
      this.persist();
    } catch (error) {
      this.bus.emit("error", wcError(error));
    }
  }

  private persist(): void {
    if (!this.topic) return;
    const record: StoredWalletConnect = {
      topic: this.topic,
      chains: this.getChains(),
      accounts: this.accounts.map((account) => ({
        chainId: account.chainId,
        address: account.address,
        algo: account.algo,
        pubKey: bytesToBase64(account.pubkey),
      })),
    };
    writeJson(this.storage, STORAGE_KEYS.walletConnectSession, record);
  }

  private end(reason: string): void {
    if (!this.topic) return;
    this.release();
    removeKey(this.storage, STORAGE_KEYS.walletConnectSession);
    this.setStatus("disconnected");
    this.bus.emit("disconnect", reason);
  }

  private release(): void {
    this.detach?.();
    this.detach = null;
    this.topic = null;
    this.accounts = [];
    this.chains = [];
    this.currentPairing = undefined;
  }

  private setStatus(status: ZuniaSessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.bus.emit("status", status);
  }
}
