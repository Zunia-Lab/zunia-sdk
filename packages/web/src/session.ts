import {
  ZuniaConnectError,
  ZUNIA_CONNECT_BUTTON,
  ZUNIA_NATIVE_CONNECT,
  accountsFromKey,
  createEnvelope,
  normalizeChainIds,
  type ConnectOptions,
  type CreateConnectSessionRequest,
  type CreateConnectSessionResponse,
  type ZuniaConnectEnvelope,
  type ZuniaKey,
  type ZuniaOfflineSigner,
  type ZuniaSession,
  type ZuniaSessionAccount,
  type ZuniaSessionEvents,
  type ZuniaSessionStatus,
  type ZuniaTransport,
  type ZuniaTransportKind,
} from "@zunialab/sdk-core";
import { enableZunia, getZunia, isZuniaInstalled } from "./detect.js";

type ListenerMap = {
  [K in keyof ZuniaSessionEvents]?: Set<ZuniaSessionEvents[K]>;
};

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function dataToString(data: string | Uint8Array): string {
  if (typeof data === "string") return data;
  return new TextDecoder().decode(data);
}

class EventBus {
  private listeners: ListenerMap = {};

  on<K extends keyof ZuniaSessionEvents>(
    event: K,
    listener: ZuniaSessionEvents[K],
  ): void {
    if (!this.listeners[event]) this.listeners[event] = new Set() as never;
    (this.listeners[event] as Set<ZuniaSessionEvents[K]>).add(listener);
  }

  off<K extends keyof ZuniaSessionEvents>(
    event: K,
    listener: ZuniaSessionEvents[K],
  ): void {
    this.listeners[event]?.delete(listener as never);
  }

  emit<K extends keyof ZuniaSessionEvents>(
    event: K,
    ...args: Parameters<ZuniaSessionEvents[K]>
  ): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const listener of set) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
}

export class ExtensionTransport implements ZuniaTransport {
  readonly kind = "extension" as const;
  private bus = new EventBus();
  private accounts: ZuniaSessionAccount[] = [];
  private chains: string[] = [];

  on = this.bus.on.bind(this.bus);
  off = this.bus.off.bind(this.bus);

  async connect(options: ConnectOptions): Promise<void> {
    this.bus.emit("status", "connecting");
    const chains = normalizeChainIds(options.chains);
    const provider = await enableZunia(chains, {
      timeoutMs: options.timeoutMs,
    });
    this.chains = chains;
    this.accounts = [];
    for (const chainId of chains) {
      const key = await provider.getKey(chainId);
      this.accounts.push(accountsFromKey(chainId, key));
    }
    this.bus.emit("accountsChanged", this.accounts);
    this.bus.emit("status", "connected");
  }

  async disconnect(): Promise<void> {
    const provider = await getZunia({ timeoutMs: 500 });
    if (provider?.disable) {
      await provider.disable(this.chains);
    }
    this.accounts = [];
    this.bus.emit("status", "disconnected");
    this.bus.emit("disconnect", "user");
  }

  async getAccounts(): Promise<ZuniaSessionAccount[]> {
    return this.accounts;
  }

  async getKey(chainId: string): Promise<ZuniaKey> {
    const provider = await getZunia({ timeoutMs: 1_000 });
    if (!provider) throw new ZuniaConnectError("NOT_INSTALLED", "Extension missing");
    return provider.getKey(chainId);
  }

  getOfflineSigner(chainId: string): ZuniaOfflineSigner {
    return {
      getAccounts: async () =>
        this.accounts
          .filter((a) => a.chainId === chainId)
          .map((a) => ({
            address: a.address,
            algo: a.algo,
            pubkey: base64ToBytes(a.pubkey),
          })),
      signAmino: async (signer, signDoc) =>
        this.signAmino(chainId, String(signer), signDoc),
      signDirect: async (signer, signDoc) =>
        this.signDirect(chainId, String(signer), signDoc as never),
    };
  }

  async signAmino(chainId: string, signer: string, signDoc: unknown) {
    const provider = await getZunia({ timeoutMs: 1_000 });
    if (!provider?.signAmino) {
      throw new ZuniaConnectError("UNSUPPORTED", "signAmino unavailable");
    }
    this.bus.emit("status", "signing");
    try {
      return await provider.signAmino(chainId, signer, signDoc);
    } finally {
      this.bus.emit("status", "connected");
    }
  }

  async signDirect(
    chainId: string,
    signer: string,
    signDoc: { bodyBytes: Uint8Array; authInfoBytes: Uint8Array },
  ) {
    const provider = await getZunia({ timeoutMs: 1_000 });
    if (!provider?.signDirect) {
      throw new ZuniaConnectError("UNSUPPORTED", "signDirect unavailable");
    }
    this.bus.emit("status", "signing");
    try {
      return await provider.signDirect(chainId, signer, signDoc);
    } finally {
      this.bus.emit("status", "connected");
    }
  }

  async signArbitrary(
    chainId: string,
    signer: string,
    data: string | Uint8Array,
  ) {
    const provider = await getZunia({ timeoutMs: 1_000 });
    if (!provider?.signArbitrary) {
      throw new ZuniaConnectError("UNSUPPORTED", "signArbitrary unavailable");
    }
    return provider.signArbitrary(chainId, signer, data);
  }
}

export class NativeWsTransport implements ZuniaTransport {
  readonly kind = "native-ws" as const;
  private bus = new EventBus();
  private ws: WebSocket | null = null;
  private accounts: ZuniaSessionAccount[] = [];
  private chains: string[] = [];
  private pairing?: CreateConnectSessionResponse;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  on = this.bus.on.bind(this.bus);
  off = this.bus.off.bind(this.bus);

  get pairingInfo(): CreateConnectSessionResponse | undefined {
    return this.pairing;
  }

  async connect(options: ConnectOptions): Promise<void> {
    this.bus.emit("status", "connecting");
    const chains = normalizeChainIds(options.chains);
    this.chains = chains;
    const apiBase = (options.apiBase ?? "").replace(/\/$/, "");
    if (!apiBase) {
      throw new ZuniaConnectError(
        "NETWORK",
        "apiBase is required for native-ws (e.g. http://localhost:8788)",
      );
    }

    const metadata = options.metadata ?? {
      name: typeof document !== "undefined" ? document.title || "dApp" : "dApp",
      url: typeof location !== "undefined" ? location.origin : "https://localhost",
    };

    const body: CreateConnectSessionRequest = {
      metadata,
      chains,
      methods: [...ZUNIA_NATIVE_CONNECT.defaultMethods],
      events: [...ZUNIA_NATIVE_CONNECT.defaultEvents],
    };

    const res = await fetch(`${apiBase}${ZUNIA_NATIVE_CONNECT.httpPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new ZuniaConnectError(
        "NETWORK",
        `Failed to create connect session (${res.status})`,
      );
    }
    this.pairing = (await res.json()) as CreateConnectSessionResponse;
    this.bus.emit("pairing", this.pairing);
    this.bus.emit("status", "awaiting_wallet");

    const wsUrl = new URL(this.pairing.wsUrl);
    wsUrl.searchParams.set("role", "dapp");
    if (options.wsBase) {
      const base = new URL(options.wsBase);
      wsUrl.protocol = base.protocol;
      wsUrl.host = base.host;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(
          new ZuniaConnectError("TIMEOUT", "Wallet did not approve in time"),
        );
      }, options.timeoutMs ?? 120_000);

      this.ws = new WebSocket(wsUrl.toString());
      this.ws.onopen = () => {
        this.ws?.send(
          JSON.stringify(
            createEnvelope("hello", { role: "dapp", metadata }),
          ),
        );
        this.ws?.send(
          JSON.stringify(
            createEnvelope("connect_request", {
              origin: metadata.url,
              metadata,
              chains,
              methods: body.methods,
              events: body.events,
            }),
          ),
        );
      };
      this.ws.onerror = () => {
        window.clearTimeout(timeout);
        reject(new ZuniaConnectError("NETWORK", "WebSocket connection failed"));
      };
      this.ws.onmessage = (ev) => {
        let msg: ZuniaConnectEnvelope;
        try {
          msg = JSON.parse(String(ev.data)) as ZuniaConnectEnvelope;
        } catch {
          return;
        }
        if (msg.type === "connect_approve") {
          const payload = msg.payload as {
            accounts: ZuniaSessionAccount[];
            chains: string[];
          };
          this.accounts = payload.accounts;
          this.chains = payload.chains ?? chains;
          window.clearTimeout(timeout);
          this.bus.emit("accountsChanged", this.accounts);
          this.bus.emit("status", "connected");
          resolve();
          return;
        }
        if (msg.type === "connect_reject") {
          window.clearTimeout(timeout);
          reject(
            new ZuniaConnectError(
              "USER_REJECTED",
              (msg.payload as { reason?: string })?.reason ?? "Rejected",
            ),
          );
          return;
        }
        if (msg.type === "event_accounts_changed") {
          this.accounts = msg.payload as ZuniaSessionAccount[];
          this.bus.emit("accountsChanged", this.accounts);
        }
        if (msg.type === "event_chain_changed") {
          this.chains = msg.payload as string[];
          this.bus.emit("chainChanged", this.chains);
        }
        if (msg.type === "sign_result" || msg.type === "sign_reject") {
          const waiter = msg.id ? this.pending.get(msg.id) : undefined;
          if (waiter) {
            this.pending.delete(msg.id!);
            if (msg.type === "sign_reject") {
              waiter.reject(
                new ZuniaConnectError(
                  "USER_REJECTED",
                  (msg.payload as { reason?: string })?.reason ?? "Rejected",
                ),
              );
            } else {
              waiter.resolve(msg.payload);
            }
          }
        }
        if (msg.type === "disconnect") {
          this.bus.emit("disconnect", (msg.payload as { reason?: string })?.reason);
          this.bus.emit("status", "disconnected");
        }
      };
    });
  }

  async disconnect(reason?: string): Promise<void> {
    this.ws?.send(
      JSON.stringify(createEnvelope("disconnect", { reason: reason ?? "user" })),
    );
    this.ws?.close();
    this.ws = null;
    if (this.pairing && this.pairing.httpUrl) {
      try {
        await fetch(this.pairing.httpUrl, { method: "DELETE" });
      } catch {
        /* ignore */
      }
    }
    this.bus.emit("status", "disconnected");
  }

  async getAccounts(): Promise<ZuniaSessionAccount[]> {
    return this.accounts;
  }

  async getKey(chainId: string): Promise<ZuniaKey> {
    const account = this.accounts.find((a) => a.chainId === chainId);
    if (!account) throw new ZuniaConnectError("UNAUTHORIZED", "No account");
    return {
      name: account.name ?? "Zunia",
      algo: account.algo,
      pubKey: base64ToBytes(account.pubkey),
      address: account.address,
      bech32Address: account.bech32Address ?? account.address,
    };
  }

  getOfflineSigner(chainId: string): ZuniaOfflineSigner {
    return {
      getAccounts: async () =>
        this.accounts
          .filter((a) => a.chainId === chainId)
          .map((a) => ({
            address: a.address,
            algo: a.algo,
            pubkey: base64ToBytes(a.pubkey),
          })),
      signAmino: (signer, signDoc) =>
        this.signAmino(chainId, String(signer), signDoc),
      signDirect: (signer, signDoc) =>
        this.signDirect(chainId, String(signer), signDoc as never),
    };
  }

  private request<T>(
    type: "sign_amino" | "sign_direct" | "sign_arbitrary",
    payload: unknown,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new ZuniaConnectError("DISCONNECTED", "Native WS not connected"),
      );
    }
    const id = crypto.randomUUID();
    this.bus.emit("status", "signing");
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => {
          this.bus.emit("status", "connected");
          resolve(v as T);
        },
        reject: (e) => {
          this.bus.emit("status", "connected");
          reject(e);
        },
      });
      this.ws!.send(JSON.stringify(createEnvelope(type, payload, id)));
    });
  }

  signAmino(chainId: string, signer: string, signDoc: unknown) {
    return this.request("sign_amino", { chainId, signer, signDoc });
  }

  signDirect(
    chainId: string,
    signer: string,
    signDoc: { bodyBytes: Uint8Array; authInfoBytes: Uint8Array },
  ) {
    return this.request("sign_direct", {
      chainId,
      signer,
      bodyBytes: bytesToBase64(signDoc.bodyBytes),
      authInfoBytes: bytesToBase64(signDoc.authInfoBytes),
    });
  }

  signArbitrary(chainId: string, signer: string, data: string | Uint8Array) {
    const encoding = typeof data === "string" ? "utf8" : "base64";
    const encoded =
      typeof data === "string" ? data : bytesToBase64(data);
    return this.request("sign_arbitrary", {
      chainId,
      signer,
      data: encoded,
      encoding,
    });
  }
}

/** WalletConnect SignClient transport (browser). Requires projectId. */
export class WalletConnectTransport implements ZuniaTransport {
  readonly kind = "walletconnect" as const;
  private bus = new EventBus();
  private accounts: ZuniaSessionAccount[] = [];
  private chains: string[] = [];
  private pairing?: CreateConnectSessionResponse;
  private sessionTopic: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;

  on = this.bus.on.bind(this.bus);
  off = this.bus.off.bind(this.bus);

  get pairingInfo(): CreateConnectSessionResponse | undefined {
    return this.pairing;
  }

  async connect(options: ConnectOptions): Promise<void> {
    const projectId = options.walletConnectProjectId;
    if (!projectId) {
      throw new ZuniaConnectError(
        "NETWORK",
        "walletConnectProjectId is required for WalletConnect",
      );
    }
    this.bus.emit("status", "connecting");
    this.chains = normalizeChainIds(options.chains);

    try {
      const { SignClient } = await import("@walletconnect/sign-client");
      this.client = await SignClient.init({
        projectId,
        metadata: {
          name: options.metadata?.name ?? "Zunia dApp",
          description: options.metadata?.description ?? "",
          url: options.metadata?.url ?? "https://zunialab.com",
          icons: options.metadata?.icons ?? [],
        },
      });
    } catch (e) {
      throw new ZuniaConnectError(
        "UNSUPPORTED",
        "Install @walletconnect/sign-client to use WalletConnect transport",
        e,
      );
    }

    const namespaces = {
      cosmos: {
        methods: [
          "cosmos_getAccounts",
          "cosmos_signAmino",
          "cosmos_signDirect",
          "cosmos_signArbitrary",
        ],
        chains: this.chains.map((id) => `cosmos:${id}`),
        events: ["accountsChanged", "chainChanged"],
      },
    };

    const { uri, approval } = await this.client.connect({
      requiredNamespaces: namespaces,
    });

    if (uri) {
      this.pairing = {
        sessionId: uri.slice(0, 32),
        pairingSecret: "",
        expiresAt: Date.now() + 900_000,
        wsUrl: "",
        deepLink: `zunia://wc?uri=${encodeURIComponent(uri)}`,
        qrPayload: uri,
        httpUrl: "",
      };
      this.bus.emit("pairing", this.pairing);
      this.bus.emit("status", "awaiting_wallet");
    }

    const session = await approval();
    this.sessionTopic = session.topic;
    const accounts =
      session.namespaces?.cosmos?.accounts?.map((a: string) => {
        const parts = a.split(":");
        const chainId = parts[1] ?? "";
        const address = parts[2] ?? "";
        return {
          chainId,
          address,
          algo: "secp256k1",
          pubkey: "",
        } satisfies ZuniaSessionAccount;
      }) ?? [];
    this.accounts = accounts;
    this.bus.emit("accountsChanged", this.accounts);
    this.bus.emit("status", "connected");
  }

  async disconnect(): Promise<void> {
    if (this.client && this.sessionTopic) {
      await this.client.disconnect({
        topic: this.sessionTopic,
        reason: { code: 6000, message: "User disconnected" },
      });
    }
    this.sessionTopic = null;
    this.bus.emit("status", "disconnected");
  }

  async getAccounts(): Promise<ZuniaSessionAccount[]> {
    return this.accounts;
  }

  async getKey(chainId: string): Promise<ZuniaKey> {
    const account = this.accounts.find((a) => a.chainId === chainId);
    if (!account) throw new ZuniaConnectError("UNAUTHORIZED", "No account");
    return {
      name: "Zunia",
      algo: account.algo,
      pubKey: account.pubkey ? base64ToBytes(account.pubkey) : new Uint8Array(),
      address: account.address,
      bech32Address: account.address,
    };
  }

  getOfflineSigner(chainId: string): ZuniaOfflineSigner {
    return {
      getAccounts: async () =>
        this.accounts
          .filter((a) => a.chainId === chainId)
          .map((a) => ({
            address: a.address,
            algo: a.algo,
            pubkey: a.pubkey ? base64ToBytes(a.pubkey) : new Uint8Array(),
          })),
      signAmino: (signer, signDoc) =>
        this.signAmino(chainId, String(signer), signDoc),
      signDirect: (signer, signDoc) =>
        this.signDirect(chainId, String(signer), signDoc as never),
    };
  }

  async signAmino(chainId: string, signer: string, signDoc: unknown) {
    if (!this.client || !this.sessionTopic) {
      throw new ZuniaConnectError("DISCONNECTED", "No WC session");
    }
    this.bus.emit("status", "signing");
    try {
      return await this.client.request({
        topic: this.sessionTopic,
        chainId: `cosmos:${chainId}`,
        request: {
          method: "cosmos_signAmino",
          params: { signerAddress: signer, signDoc },
        },
      });
    } finally {
      this.bus.emit("status", "connected");
    }
  }

  async signDirect(
    chainId: string,
    signer: string,
    signDoc: { bodyBytes: Uint8Array; authInfoBytes: Uint8Array },
  ) {
    if (!this.client || !this.sessionTopic) {
      throw new ZuniaConnectError("DISCONNECTED", "No WC session");
    }
    this.bus.emit("status", "signing");
    try {
      return await this.client.request({
        topic: this.sessionTopic,
        chainId: `cosmos:${chainId}`,
        request: {
          method: "cosmos_signDirect",
          params: {
            signerAddress: signer,
            signDoc: {
              bodyBytes: bytesToBase64(signDoc.bodyBytes),
              authInfoBytes: bytesToBase64(signDoc.authInfoBytes),
            },
          },
        },
      });
    } finally {
      this.bus.emit("status", "connected");
    }
  }

  async signArbitrary(
    chainId: string,
    signer: string,
    data: string | Uint8Array,
  ) {
    if (!this.client || !this.sessionTopic) {
      throw new ZuniaConnectError("DISCONNECTED", "No WC session");
    }
    return this.client.request({
      topic: this.sessionTopic,
      chainId: `cosmos:${chainId}`,
      request: {
        method: "cosmos_signArbitrary",
        params: { signerAddress: signer, data: dataToString(data) },
      },
    });
  }
}

export class ZuniaSessionImpl implements ZuniaSession {
  private transportImpl: ZuniaTransport | null = null;
  private bus = new EventBus();
  private _status: ZuniaSessionStatus = "idle";
  private _accounts: ZuniaSessionAccount[] = [];
  private _chains: string[] = [];
  private _pairing?: CreateConnectSessionResponse;

  get transport(): ZuniaTransportKind {
    return this.transportImpl?.kind ?? "extension";
  }
  get status(): ZuniaSessionStatus {
    return this._status;
  }
  get accounts(): ZuniaSessionAccount[] {
    return this._accounts;
  }
  get chains(): string[] {
    return this._chains;
  }
  get pairing(): CreateConnectSessionResponse | undefined {
    return this._pairing;
  }

  on = this.bus.on.bind(this.bus);
  off = this.bus.off.bind(this.bus);

  private wire(t: ZuniaTransport): void {
    this.transportImpl = t;
    t.on?.("status", (s) => {
      this._status = s;
      this.bus.emit("status", s);
    });
    t.on?.("accountsChanged", (a) => {
      this._accounts = a;
      this.bus.emit("accountsChanged", a);
    });
    t.on?.("chainChanged", (c) => {
      this._chains = c;
      this.bus.emit("chainChanged", c);
    });
    t.on?.("pairing", (p) => {
      this._pairing = p;
      this.bus.emit("pairing", p);
    });
    t.on?.("error", (e) => this.bus.emit("error", e));
    t.on?.("disconnect", (r) => this.bus.emit("disconnect", r));
  }

  async connect(options: ConnectOptions): Promise<void> {
    const prefer = options.prefer ?? "auto";
    let transport: ZuniaTransport;

    if (prefer === "extension" || (prefer === "auto" && isZuniaInstalled())) {
      transport = new ExtensionTransport();
    } else if (prefer === "native-ws" || (prefer === "auto" && options.apiBase)) {
      transport = new NativeWsTransport();
    } else if (
      prefer === "walletconnect" ||
      (prefer === "auto" && options.walletConnectProjectId)
    ) {
      transport = new WalletConnectTransport();
    } else if (prefer === "auto") {
      if (isZuniaInstalled()) transport = new ExtensionTransport();
      else if (options.apiBase) transport = new NativeWsTransport();
      else if (options.walletConnectProjectId)
        transport = new WalletConnectTransport();
      else {
        if (options.openInstallIfMissing !== false) {
          window.open(ZUNIA_CONNECT_BUTTON.installUrl, "_blank");
        }
        throw new ZuniaConnectError(
          "NOT_INSTALLED",
          "No Zunia extension, apiBase, or WalletConnect project id",
        );
      }
    } else {
      throw new ZuniaConnectError("UNSUPPORTED", `Unknown prefer=${prefer}`);
    }

    this.wire(transport);
    await transport.connect(options);
    this._accounts = await transport.getAccounts();
    this._chains = normalizeChainIds(options.chains);
    this._status = "connected";
  }

  async disconnect(reason?: string): Promise<void> {
    await this.transportImpl?.disconnect(reason);
    this._status = "disconnected";
  }

  async getAccounts(): Promise<ZuniaSessionAccount[]> {
    return this.transportImpl?.getAccounts() ?? [];
  }

  async getKey(chainId: string): Promise<ZuniaKey> {
    if (!this.transportImpl) {
      throw new ZuniaConnectError("DISCONNECTED", "No session");
    }
    return this.transportImpl.getKey(chainId);
  }

  getOfflineSigner(chainId: string): ZuniaOfflineSigner {
    if (!this.transportImpl) {
      throw new ZuniaConnectError("DISCONNECTED", "No session");
    }
    return this.transportImpl.getOfflineSigner(chainId);
  }

  async enable(chainIds: string | string[]): Promise<void> {
    await this.connect({ chains: chainIds, prefer: this.transport });
  }

  signAmino(chainId: string, signer: string, signDoc: unknown) {
    if (!this.transportImpl) {
      return Promise.reject(new ZuniaConnectError("DISCONNECTED", "No session"));
    }
    return this.transportImpl.signAmino(chainId, signer, signDoc);
  }

  signDirect(
    chainId: string,
    signer: string,
    signDoc: { bodyBytes: Uint8Array; authInfoBytes: Uint8Array },
  ) {
    if (!this.transportImpl) {
      return Promise.reject(new ZuniaConnectError("DISCONNECTED", "No session"));
    }
    return this.transportImpl.signDirect(chainId, signer, signDoc);
  }

  signArbitrary(chainId: string, signer: string, data: string | Uint8Array) {
    if (!this.transportImpl?.signArbitrary) {
      return Promise.reject(
        new ZuniaConnectError("UNSUPPORTED", "signArbitrary unavailable"),
      );
    }
    return this.transportImpl.signArbitrary(chainId, signer, data);
  }
}

export async function connectWithZunia(
  options: ConnectOptions,
): Promise<ZuniaSession> {
  const session = new ZuniaSessionImpl();
  await session.connect(options);
  return session;
}

export async function createExtensionSession(
  options: ConnectOptions,
): Promise<ZuniaSession> {
  return connectWithZunia({ ...options, prefer: "extension" });
}

export async function createZuniaWsSession(
  options: ConnectOptions,
): Promise<ZuniaSession> {
  return connectWithZunia({ ...options, prefer: "native-ws" });
}

export async function createWalletConnectSession(
  options: ConnectOptions,
): Promise<ZuniaSession> {
  return connectWithZunia({ ...options, prefer: "walletconnect" });
}

export async function waitForZuniaInitialized(
  timeoutMs = 5_000,
): Promise<boolean> {
  if (isZuniaInstalled()) return true;
  if (typeof window === "undefined") return false;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("zunia#initialized", onReady);
      resolve(isZuniaInstalled());
    }, timeoutMs);
    function onReady() {
      window.clearTimeout(timer);
      resolve(true);
    }
    window.addEventListener("zunia#initialized", onReady, { once: true });
  });
}
