import {
  ConnectCipher,
  ZUNIA_CONNECT_CLOSE_CODES,
  ZUNIA_CONNECT_PATHS,
  ZUNIA_CONNECT_PROTOCOL,
  ZUNIA_CONNECT_TOKEN_PROTOCOL_PREFIX,
  ZUNIA_NATIVE_CONNECT,
  ZuniaConnectError,
  accountFromWire,
  accountNumberToString,
  base64UrlToBytes,
  buildPairingUri,
  bytesToBase64,
  bytesToBase64Url,
  createNonce,
  deriveConnectKeys,
  generateConnectKeyPair,
  isZuniaProviderErrorCode,
  normalizeAminoResponse,
  normalizeChainIds,
  normalizeDirectResponse,
  normalizeStdSignature,
  toZuniaConnectError,
  type AminoSignResponse,
  type ConnectEnvelope,
  type ConnectKeyPair,
  type ConnectOptions,
  type ConnectSessionKeys,
  type CreateConnectSessionResponse,
  type DappMessage,
  type DirectSignResponse,
  type RelayClientFrame,
  type RelayServerFrame,
  type RestoreOptions,
  type SignDocInput,
  type StdSignDoc,
  type StdSignature,
  type WireAccount,
  type ZuniaAccountInfo,
  type ZuniaConnectErrorCode,
  type ZuniaDappMetadata,
  type ZuniaPairing,
  type ZuniaSessionEvents,
  type ZuniaSessionStatus,
  type ZuniaStorage,
  type ZuniaTransport,
} from "@zunialab/sdk-core";
import { EventBus } from "../events.js";
import { STORAGE_KEYS, readJson, removeKey, resolveStorage, writeJson } from "../storage.js";

type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocket;

export interface NativeWsTransportOptions {
  /** WebSocket implementation. Defaults to the global one. */
  WebSocket?: WebSocketCtor;
  /** fetch implementation. Defaults to the global one. */
  fetch?: typeof fetch;
  /** Ping interval. Default 20 s. */
  heartbeatMs?: number;
  /** Silence after which the link counts as dead and is reopened. Default 45 s. */
  deadAfterMs?: number;
  /** First reconnect delay. Default 1 s, doubling up to `reconnectMaxMs`. */
  reconnectMinMs?: number;
  /** Longest reconnect delay. Default 30 s. */
  reconnectMaxMs?: number;
  /** How long `restore` waits for the relay before resolving. Default 5 s. */
  restoreWaitMs?: number;
}

const OPEN = 1;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 30_000;
const UNACKED_LIMIT = 32;
const SESSION_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

type DappType = DappMessage["type"];
type DappPayload<T extends DappType> = Extract<DappMessage, { type: T }>["payload"];

interface RelaySession {
  apiBase: string;
  wsUrl: string;
  sessionId: string;
  dappToken: string;
  expiresAt: number;
  verifiedOrigin: string | null;
}

interface StoredSession extends RelaySession {
  v: 2;
  dappToWallet: string;
  walletToDapp: string;
  verificationCode: string;
  sendSeq: number;
  receiveSeq: number;
  accounts: WireAccount[];
  chains: string[];
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: ZuniaConnectError): void;
  timer: ReturnType<typeof setTimeout>;
}

/** A sealed frame still waiting for its answer. `sent` is the write counter when it last went out. */
interface Unacked {
  id: string;
  data: string;
  sent: number | null;
}

interface Attempt {
  requestId: string;
  chains: string[];
  metadata: ZuniaDappMetadata;
  resolve(): void;
  reject(error: ZuniaConnectError): void;
  timer: ReturnType<typeof setTimeout>;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isCreateResponse(value: unknown): value is CreateConnectSessionResponse {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    body.v === ZUNIA_CONNECT_PROTOCOL &&
    typeof body.sessionId === "string" &&
    SESSION_ID.test(body.sessionId) &&
    typeof body.dappToken === "string" &&
    TOKEN.test(body.dappToken) &&
    typeof body.walletJoinToken === "string" &&
    TOKEN.test(body.walletJoinToken) &&
    typeof body.expiresAt === "number" &&
    typeof body.wsUrl === "string" &&
    /^wss?:\/\//.test(body.wsUrl) &&
    (body.verifiedOrigin === null || typeof body.verifiedOrigin === "string")
  );
}

function parseStored(value: unknown): StoredSession | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Partial<StoredSession>;
  const strings = [s.apiBase, s.wsUrl, s.sessionId, s.dappToken, s.dappToWallet, s.walletToDapp, s.verificationCode];
  if (s.v !== 2 || strings.some((item) => typeof item !== "string")) return null;
  if (typeof s.expiresAt !== "number" || typeof s.sendSeq !== "number" || typeof s.receiveSeq !== "number") return null;
  if (!Array.isArray(s.accounts) || !Array.isArray(s.chains)) return null;
  return s as StoredSession;
}

function wireAccounts(value: unknown): WireAccount[] {
  if (!Array.isArray(value)) throw new ZuniaConnectError("INTERNAL", "The wallet sent malformed accounts");
  return value.map((item) => {
    const account = (item ?? {}) as Record<string, unknown>;
    const { chainId, address, algo, pubKey, name } = account;
    if (typeof chainId !== "string" || typeof address !== "string" || typeof pubKey !== "string") {
      throw new ZuniaConnectError("INTERNAL", "The wallet sent a malformed account");
    }
    return {
      chainId,
      address,
      algo: typeof algo === "string" ? algo : "secp256k1",
      pubKey,
      ...(typeof name === "string" ? { name } : {}),
    };
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? normalizeChainIds(value.filter((item): item is string => typeof item === "string")) : [];
}

function walletError(payload: unknown, fallback: ZuniaConnectErrorCode, fallbackMessage: string): ZuniaConnectError {
  const body = (payload ?? {}) as { code?: unknown; message?: unknown };
  const code = isZuniaProviderErrorCode(body.code) ? body.code : fallback;
  const message = typeof body.message === "string" && body.message ? body.message.slice(0, 300) : fallbackMessage;
  return new ZuniaConnectError(code, message);
}

function defaultMetadata(): ZuniaDappMetadata {
  const loc = typeof location === "undefined" ? undefined : location;
  const doc = typeof document === "undefined" ? undefined : document;
  const icon = doc?.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href;
  return {
    name: doc?.title || loc?.host || "dApp",
    url: loc?.origin ?? "",
    ...(icon ? { icons: [icon] } : {}),
  };
}

/**
 * QR pairing with the Zunia mobile wallet through the relay (zunia.connect.v2).
 * The relay only forwards sealed frames; the phone and the page agree on keys
 * the relay never sees, and the user compares a 6-digit code on both screens.
 */
export class NativeWsTransport implements ZuniaTransport {
  readonly kind = "native-ws" as const;
  private readonly bus = new EventBus<ZuniaSessionEvents>();
  private readonly WebSocketImpl: WebSocketCtor | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly heartbeatMs: number;
  private readonly deadAfterMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly restoreWaitMs: number;

  private phase: "idle" | "pairing" | "active" | "ended" = "idle";
  private status: ZuniaSessionStatus = "idle";
  private storage: ZuniaStorage | null = null;
  private requestTimeoutMs = DEFAULT_TIMEOUT_MS;
  private session: RelaySession | null = null;
  private keyPair: ConnectKeyPair | null = null;
  private walletPublicKey: string | null = null;
  private keys: ConnectSessionKeys | null = null;
  private cipher: ConnectCipher | null = null;
  private accounts: ZuniaAccountInfo[] = [];
  private chains: string[] = [];
  private attempt: Attempt | null = null;
  private restoreWaiter: { resolve(ok: boolean): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly pending = new Map<string, Pending>();
  private unacked: Unacked[] = [];
  /** Frames written on any socket so far. */
  private written = 0;
  /** Every frame up to this write count is known to have reached the relay. */
  private confirmed = 0;
  /** Write count when the outstanding ping went out. */
  private pingMark: number | null = null;
  private socket: WebSocket | null = null;
  private welcomed = false;
  private lastSeen = 0;
  private retries = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentPairing: ZuniaPairing | undefined;
  private code: string | undefined;

  constructor(options: NativeWsTransportOptions = {}) {
    this.WebSocketImpl = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    this.fetchImpl = options.fetch ?? (typeof fetch === "undefined" ? undefined : fetch.bind(globalThis));
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
    this.deadAfterMs = options.deadAfterMs ?? 45_000;
    this.reconnectMinMs = options.reconnectMinMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.restoreWaitMs = options.restoreWaitMs ?? 5_000;
  }

  /** The QR code to show while pairing. */
  get pairing(): ZuniaPairing | undefined {
    return this.currentPairing;
  }

  /** The 6-digit code the phone must show too, once it has scanned. */
  get verificationCode(): string | undefined {
    return this.code;
  }

  /** The dApp origin the relay saw when the session was created. */
  get verifiedOrigin(): string | null {
    return this.session?.verifiedOrigin ?? null;
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

  async connect(options: ConnectOptions): Promise<void> {
    const chains = normalizeChainIds(options.chains);
    if (chains.length === 0) throw new ZuniaConnectError("INVALID_PARAMS", "Pass at least one chain id");
    const apiBase = trimSlash(options.apiBase ?? "");
    if (!apiBase) throw new ZuniaConnectError("INVALID_PARAMS", "Pass apiBase, the relay URL, to pair a phone by QR code");
    if (!this.WebSocketImpl || !this.fetchImpl) {
      throw new ZuniaConnectError("UNSUPPORTED", "QR pairing needs WebSocket and fetch");
    }
    if (this.phase === "pairing" || this.phase === "active") await this.disconnect("replaced");

    this.phase = "idle";
    this.storage = resolveStorage(options.storage);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setStatus("connecting");
    let created: CreateConnectSessionResponse;
    try {
      created = await this.createSession(apiBase);
    } catch (error) {
      this.setStatus("disconnected");
      throw error;
    }

    const relayBase = options.wsBase
      ? trimSlash(options.wsBase)
      : created.wsUrl.endsWith(ZUNIA_CONNECT_PATHS.ws)
        ? created.wsUrl.slice(0, -ZUNIA_CONNECT_PATHS.ws.length)
        : trimSlash(created.wsUrl);
    this.session = {
      apiBase,
      wsUrl: `${relayBase}${ZUNIA_CONNECT_PATHS.ws}`,
      sessionId: created.sessionId,
      dappToken: created.dappToken,
      expiresAt: created.expiresAt,
      verifiedOrigin: created.verifiedOrigin,
    };
    this.keyPair = generateConnectKeyPair();
    this.phase = "pairing";
    this.retries = 0;
    this.currentPairing = {
      transport: "native-ws",
      uri: buildPairingUri({
        sessionId: created.sessionId,
        joinToken: created.walletJoinToken,
        dappPublicKey: bytesToBase64Url(this.keyPair.publicKey),
        relay: relayBase,
      }),
      expiresAt: created.expiresAt,
    };

    const done = new Promise<void>((resolve, reject) => {
      const wait = Math.max(0, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, created.expiresAt - Date.now()));
      this.attempt = {
        requestId: createNonce(),
        chains,
        metadata: options.metadata ?? defaultMetadata(),
        resolve,
        reject,
        timer: setTimeout(() => {
          void this.disconnect("timeout", new ZuniaConnectError("TIMEOUT", "Nobody approved the pairing in time"));
        }, wait),
      };
    });
    this.watchNetwork(true);
    this.bus.emit("pairing", this.currentPairing);
    this.setStatus("awaiting_wallet");
    this.open();
    return done;
  }

  async restore(options: RestoreOptions): Promise<boolean> {
    if (this.phase === "pairing" || this.phase === "active") return this.phase === "active";
    this.storage = resolveStorage(options.storage);
    const stored = parseStored(readJson(this.storage, STORAGE_KEYS.nativeSession));
    if (!stored) return false;
    if (stored.expiresAt <= Date.now()) {
      removeKey(this.storage, STORAGE_KEYS.nativeSession);
      return false;
    }
    if (options.apiBase && trimSlash(options.apiBase) !== stored.apiBase) return false;
    if (options.chains && !normalizeChainIds(options.chains).some((id) => stored.chains.includes(id))) return false;
    if (!this.WebSocketImpl) return false;

    let accounts: ZuniaAccountInfo[];
    try {
      this.keys = {
        dappToWallet: base64UrlToBytes(stored.dappToWallet),
        walletToDapp: base64UrlToBytes(stored.walletToDapp),
        verificationCode: stored.verificationCode,
      };
      this.cipher = new ConnectCipher({
        role: "dapp",
        sessionId: stored.sessionId,
        keys: this.keys,
        state: { sendSeq: stored.sendSeq, receiveSeq: stored.receiveSeq },
      });
      accounts = wireAccounts(stored.accounts).map(accountFromWire);
    } catch {
      this.keys = null;
      this.cipher = null;
      removeKey(this.storage, STORAGE_KEYS.nativeSession);
      return false;
    }

    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.session = {
      apiBase: stored.apiBase,
      wsUrl: stored.wsUrl,
      sessionId: stored.sessionId,
      dappToken: stored.dappToken,
      expiresAt: stored.expiresAt,
      verifiedOrigin: typeof stored.verifiedOrigin === "string" ? stored.verifiedOrigin : null,
    };
    this.accounts = accounts;
    this.chains = stringList(stored.chains);
    this.code = stored.verificationCode;
    this.phase = "active";
    this.retries = 0;
    this.watchNetwork(true);
    this.setStatus("reconnecting");
    this.bus.emit("accountsChanged", this.getAccounts());
    this.bus.emit("chainChanged", this.getChains());

    const settled = new Promise<boolean>((resolve) => {
      this.restoreWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.restoreWaiter = null;
          resolve(true);
        }, this.restoreWaitMs),
      };
    });
    this.open();
    const ok = await settled;
    if (ok && this.phase === "active") void this.refreshAccounts();
    return ok;
  }

  async disconnect(reason = "user", error?: ZuniaConnectError): Promise<void> {
    if (this.phase !== "pairing" && this.phase !== "active") return;
    const session = this.session;
    const socket = this.socket;
    let told = false;
    if (socket && socket.readyState === OPEN) {
      try {
        socket.send(JSON.stringify({ t: "close", reason: reason.slice(0, 64) } satisfies RelayClientFrame));
        told = true;
      } catch {
        told = false;
      }
    }
    this.terminate(reason, error ?? new ZuniaConnectError("DISCONNECTED", "The session was closed"));
    if (!told && session && this.fetchImpl) {
      try {
        await this.fetchImpl(`${session.apiBase}${ZUNIA_CONNECT_PATHS.sessions}/${session.sessionId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${session.dappToken}` },
          credentials: "omit",
        });
      } catch {
        // The relay forgets the session when it expires anyway.
      }
    }
  }

  async signAmino(chainId: string, signer: string, signDoc: StdSignDoc): Promise<AminoSignResponse> {
    const raw = await this.request("sign_amino", { chainId, signer, signDoc });
    return normalizeAminoResponse(raw, signDoc);
  }

  async signDirect(chainId: string, signer: string, signDoc: SignDocInput): Promise<DirectSignResponse> {
    const raw = await this.request("sign_direct", {
      chainId,
      signer,
      signDoc: {
        bodyBytes: bytesToBase64(signDoc.bodyBytes),
        authInfoBytes: bytesToBase64(signDoc.authInfoBytes),
        chainId: signDoc.chainId,
        accountNumber: accountNumberToString(signDoc.accountNumber),
      },
    });
    return normalizeDirectResponse(raw, signDoc);
  }

  async signArbitrary(chainId: string, signer: string, data: string | Uint8Array): Promise<StdSignature> {
    const raw = await this.request(
      "sign_arbitrary",
      typeof data === "string"
        ? { chainId, signer, data, encoding: "utf8" }
        : { chainId, signer, data: bytesToBase64(data), encoding: "base64" },
    );
    return normalizeStdSignature(raw);
  }

  private async createSession(apiBase: string): Promise<CreateConnectSessionResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl!(`${apiBase}${ZUNIA_CONNECT_PATHS.sessions}`, {
        method: "POST",
        headers: { accept: "application/json" },
        credentials: "omit",
      });
    } catch (error) {
      throw new ZuniaConnectError("NETWORK", "Could not reach the Zunia relay", error);
    }
    if (response.status === 429) {
      const after = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(after) && after > 0 ? `${after} seconds` : "a moment";
      throw new ZuniaConnectError("NETWORK", `Too many pairing attempts. Try again in ${wait}.`);
    }
    if (!response.ok) throw new ZuniaConnectError("NETWORK", `The Zunia relay answered ${response.status}`);
    const body: unknown = await response.json().catch(() => null);
    if (!isCreateResponse(body)) throw new ZuniaConnectError("NETWORK", "The Zunia relay sent an unexpected answer");
    return body;
  }

  private request<T extends DappType>(type: T, payload: DappPayload<T>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.phase !== "active" || !this.cipher) {
      return Promise.reject(new ZuniaConnectError("NOT_CONNECTED", "Pair a wallet first"));
    }
    const id = createNonce();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.settle(id);
        reject(new ZuniaConnectError("TIMEOUT", "The wallet did not answer in time"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendSealed({ type, id, payload });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(toZuniaConnectError(error));
      }
    });
  }

  private sendSealed(message: Omit<ConnectEnvelope, "seq"> & { id: string }): void {
    if (!this.cipher) throw new ZuniaConnectError("NOT_CONNECTED", "Pair a wallet first");
    if (this.unacked.length >= UNACKED_LIMIT) {
      throw new ZuniaConnectError("NETWORK", "Too many requests are waiting for the wallet");
    }
    const frame = this.cipher.seal(message);
    // Saved before the frame leaves, so a reload never reuses a sequence number.
    this.persist();
    const entry: Unacked = { id: message.id, data: JSON.stringify({ t: "msg", n: frame.n, c: frame.c } satisfies RelayClientFrame), sent: null };
    this.unacked.push(entry);
    if (this.ready()) {
      entry.sent = this.write(entry.data);
      this.ping();
    }
  }

  private ready(): boolean {
    return Boolean(this.socket && this.socket.readyState === OPEN && this.welcomed);
  }

  private write(data: string): number {
    this.socket!.send(data);
    this.written += 1;
    return this.written;
  }

  /** The relay answers pings in order, so a pong confirms every frame written before it. */
  private ping(): void {
    if (!this.ready() || this.pingMark !== null) return;
    this.write(JSON.stringify({ t: "ping" } satisfies RelayClientFrame));
    this.pingMark = this.written;
  }

  private settle(id: string): void {
    this.unacked = this.unacked.filter((entry) => entry.id !== id);
  }

  private open(): void {
    const session = this.session;
    if (!session || !this.WebSocketImpl || (this.phase !== "pairing" && this.phase !== "active")) return;
    this.clearReconnect();
    this.dropSocket();
    const url = `${session.wsUrl}?sid=${encodeURIComponent(session.sessionId)}&role=dapp`;
    let socket: WebSocket;
    try {
      socket = new this.WebSocketImpl(url, [ZUNIA_CONNECT_PROTOCOL, `${ZUNIA_CONNECT_TOKEN_PROTOCOL_PREFIX}${session.dappToken}`]);
    } catch {
      this.scheduleReconnect(false);
      return;
    }
    this.socket = socket;
    this.welcomed = false;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.lastSeen = Date.now();
      this.startHeartbeat();
    };
    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.lastSeen = Date.now();
      this.onFrame(event.data);
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onClose(event.code);
    };
    socket.onerror = () => {
      // A close event always follows.
    };
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    this.pingMark = null;
    this.stopHeartbeat();
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000);
    } catch {
      // Already closing.
    }
  }

  private onFrame(raw: unknown): void {
    if (typeof raw !== "string") return;
    let frame: RelayServerFrame;
    try {
      frame = JSON.parse(raw) as RelayServerFrame;
    } catch {
      return;
    }
    switch (frame.t) {
      case "welcome":
        return this.onWelcome(frame);
      case "hello":
        return this.onHello(frame.pk);
      case "msg":
        return this.onSealed(frame);
      case "paired":
        if (this.session && typeof frame.expiresAt === "number") {
          this.session.expiresAt = frame.expiresAt;
          this.persist();
        }
        return;
      case "pong":
        if (this.pingMark !== null) {
          this.confirmed = this.pingMark;
          this.pingMark = null;
        }
        return;
      case "closed":
        return this.terminate(
          frame.reason,
          frame.reason === "expired"
            ? new ZuniaConnectError("SESSION_EXPIRED", "The session expired")
            : new ZuniaConnectError("DISCONNECTED", "The wallet ended the session"),
        );
      case "error":
        this.bus.emit("error", new ZuniaConnectError("NETWORK", `The relay refused a frame: ${String(frame.message).slice(0, 200)}`));
        return;
      default:
        return;
    }
  }

  private onWelcome(frame: Extract<RelayServerFrame, { t: "welcome" }>): void {
    if (!this.session) return;
    this.welcomed = true;
    this.retries = 0;
    this.session.expiresAt = frame.expiresAt;
    this.session.verifiedOrigin = frame.verifiedOrigin;
    // Frames the relay never confirmed may have died with the old socket. The
    // wallet drops any it already has, since their sequence numbers are old.
    for (const entry of this.unacked) {
      if (entry.sent === null || entry.sent > this.confirmed) entry.sent = this.write(entry.data);
    }
    this.ping();
    if (this.phase === "active") {
      this.persist();
      this.setStatus("connected");
      if (this.restoreWaiter) {
        clearTimeout(this.restoreWaiter.timer);
        this.restoreWaiter.resolve(true);
        this.restoreWaiter = null;
      }
    }
  }

  private onHello(pk: string): void {
    const attempt = this.attempt;
    const session = this.session;
    if (this.phase !== "pairing" || !attempt || !session || !this.keyPair) return;
    // The same wallet saying hello again after a reconnect: keep the keys and the request.
    if (this.cipher && pk === this.walletPublicKey) return;
    try {
      this.keys = deriveConnectKeys({
        role: "dapp",
        sessionId: session.sessionId,
        secretKey: this.keyPair.secretKey,
        peerPublicKey: base64UrlToBytes(pk),
      });
    } catch (error) {
      void this.disconnect("pairing_failed", toZuniaConnectError(error, "PAIRING_FAILED"));
      return;
    }
    this.cipher = new ConnectCipher({ role: "dapp", sessionId: session.sessionId, keys: this.keys });
    this.walletPublicKey = pk;
    this.code = this.keys.verificationCode;
    this.bus.emit("verification", this.code);
    this.settle(attempt.requestId);
    this.sendSealed({
      type: "connect_request",
      id: attempt.requestId,
      payload: {
        metadata: attempt.metadata,
        chains: attempt.chains,
        methods: [...ZUNIA_NATIVE_CONNECT.defaultMethods],
        events: [...ZUNIA_NATIVE_CONNECT.defaultEvents],
      },
    });
  }

  private onSealed(frame: { n: string; c: string }): void {
    if (!this.cipher) return;
    let envelope: ConnectEnvelope | null;
    try {
      envelope = this.cipher.openFresh(frame);
    } catch (error) {
      // Dropped, not fatal: only the relay could send it, and it can drop frames anyway.
      this.bus.emit("error", toZuniaConnectError(error, "PAIRING_FAILED"));
      return;
    }
    // A frame the wallet resent after a reconnect, already handled.
    if (!envelope) return;
    this.persist();
    try {
      this.onMessage(envelope);
    } catch (error) {
      this.bus.emit("error", toZuniaConnectError(error));
    }
  }

  private onMessage(message: ConnectEnvelope): void {
    const payload = (message.payload ?? {}) as Record<string, unknown>;
    switch (message.type) {
      case "connect_approve": {
        const attempt = this.attempt;
        if (this.phase !== "pairing" || !attempt || message.id !== attempt.requestId) return;
        const chains = stringList(payload.chains).filter((id) => attempt.chains.includes(id));
        if (chains.length === 0) {
          void this.disconnect("rejected", new ZuniaConnectError("UNKNOWN_CHAIN", "The wallet approved none of the requested chains"));
          return;
        }
        let accounts: ZuniaAccountInfo[];
        try {
          accounts = wireAccounts(payload.accounts).map(accountFromWire).filter((account) => chains.includes(account.chainId));
        } catch (error) {
          void this.disconnect("pairing_failed", toZuniaConnectError(error, "PAIRING_FAILED"));
          return;
        }
        this.attempt = null;
        clearTimeout(attempt.timer);
        this.settle(attempt.requestId);
        this.accounts = accounts;
        this.chains = chains;
        this.phase = "active";
        this.keyPair = null;
        this.currentPairing = undefined;
        this.persist();
        this.bus.emit("accountsChanged", this.getAccounts());
        this.bus.emit("chainChanged", this.getChains());
        this.setStatus("connected");
        attempt.resolve();
        return;
      }
      case "connect_reject": {
        if (this.phase !== "pairing" || message.id !== this.attempt?.requestId) return;
        void this.disconnect("rejected", walletError(payload, "USER_REJECTED", "The wallet declined the connection"));
        return;
      }
      case "result":
      case "error": {
        const pending = message.id ? this.pending.get(message.id) : undefined;
        if (!pending || !message.id) return;
        this.pending.delete(message.id);
        this.settle(message.id);
        clearTimeout(pending.timer);
        if (message.type === "result") pending.resolve(message.payload);
        else pending.reject(walletError(payload, "INTERNAL", "The wallet returned an error"));
        return;
      }
      case "accounts_changed": {
        if (this.phase !== "active") return;
        this.accounts = wireAccounts(payload.accounts).map(accountFromWire).filter((account) => this.chains.includes(account.chainId));
        this.persist();
        this.bus.emit("accountsChanged", this.getAccounts());
        return;
      }
      case "chains_changed": {
        if (this.phase !== "active") return;
        const chains = stringList(payload.chains);
        if (chains.length === 0) {
          void this.disconnect("revoked");
          return;
        }
        this.chains = chains;
        this.accounts = this.accounts.filter((account) => chains.includes(account.chainId));
        this.persist();
        this.bus.emit("chainChanged", this.getChains());
        this.bus.emit("accountsChanged", this.getAccounts());
        return;
      }
      default:
        return;
    }
  }

  private onClose(code: number): void {
    this.welcomed = false;
    this.stopHeartbeat();
    if (this.phase !== "pairing" && this.phase !== "active") return;
    if (code === ZUNIA_CONNECT_CLOSE_CODES.unauthorized) {
      return this.terminate("expired", new ZuniaConnectError("SESSION_EXPIRED", "The relay no longer knows this session"));
    }
    if (code === ZUNIA_CONNECT_CLOSE_CODES.ended) {
      return this.terminate("closed", new ZuniaConnectError("DISCONNECTED", "The session ended"));
    }
    if (code === ZUNIA_CONNECT_CLOSE_CODES.replaced) {
      // Another tab resumed this session; it owns the saved copy now.
      return this.terminate("replaced", new ZuniaConnectError("DISCONNECTED", "The session moved to another tab"), true);
    }
    if (this.session && this.session.expiresAt <= Date.now()) {
      return this.terminate("expired", new ZuniaConnectError("SESSION_EXPIRED", "The session expired"));
    }
    if (this.phase === "active") this.setStatus("reconnecting");
    this.scheduleReconnect(code === ZUNIA_CONNECT_CLOSE_CODES.rateLimited);
  }

  private scheduleReconnect(slow: boolean): void {
    this.clearReconnect();
    const ceiling = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** this.retries);
    this.retries += 1;
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.reconnectTimer = setTimeout(() => this.open(), slow ? Math.max(delay, 10_000) : delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== OPEN) return;
      if (Date.now() - this.lastSeen > this.deadAfterMs) {
        this.dropSocket();
        this.onClose(1006);
        return;
      }
      this.ping();
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private readonly onOnline = () => {
    if (this.reconnectTimer) this.open();
  };

  private watchNetwork(on: boolean): void {
    const target = globalThis as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
    if (on) target.addEventListener?.("online", this.onOnline);
    else target.removeEventListener?.("online", this.onOnline);
  }

  private async refreshAccounts(): Promise<void> {
    try {
      const raw = await this.request("get_accounts", { chainIds: this.getChains() }, REFRESH_TIMEOUT_MS);
      if (this.phase !== "active") return;
      this.accounts = wireAccounts(raw).map(accountFromWire).filter((account) => this.chains.includes(account.chainId));
      this.persist();
      this.bus.emit("accountsChanged", this.getAccounts());
    } catch {
      // The phone may be asleep; accounts_changed will catch up.
    }
  }

  private persist(): void {
    if (this.phase !== "active" || !this.session || !this.keys || !this.cipher) return;
    const state = this.cipher.state;
    const record: StoredSession = {
      v: 2,
      ...this.session,
      dappToWallet: bytesToBase64Url(this.keys.dappToWallet),
      walletToDapp: bytesToBase64Url(this.keys.walletToDapp),
      verificationCode: this.keys.verificationCode,
      sendSeq: state.sendSeq,
      receiveSeq: state.receiveSeq,
      accounts: this.accounts.map((account) => ({
        chainId: account.chainId,
        address: account.address,
        algo: account.algo,
        pubKey: bytesToBase64(account.pubkey),
        ...(account.name ? { name: account.name } : {}),
      })),
      chains: this.getChains(),
    };
    writeJson(this.storage, STORAGE_KEYS.nativeSession, record);
  }

  private terminate(reason: string, error: ZuniaConnectError, keepStorage = false): void {
    if (this.phase !== "pairing" && this.phase !== "active") return;
    const wasActive = this.phase === "active";
    this.phase = "ended";
    this.clearReconnect();
    this.dropSocket();
    this.watchNetwork(false);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.unacked = [];
    if (!keepStorage) removeKey(this.storage, STORAGE_KEYS.nativeSession);
    this.cipher = null;
    this.keys = null;
    this.keyPair = null;
    this.walletPublicKey = null;
    this.accounts = [];
    this.chains = [];
    this.currentPairing = undefined;
    this.code = undefined;

    const attempt = this.attempt;
    this.attempt = null;
    if (attempt) {
      clearTimeout(attempt.timer);
      attempt.reject(error);
    }
    if (this.restoreWaiter) {
      clearTimeout(this.restoreWaiter.timer);
      this.restoreWaiter.resolve(false);
      this.restoreWaiter = null;
    }
    this.setStatus("disconnected");
    if (wasActive) this.bus.emit("disconnect", reason);
  }

  private setStatus(status: ZuniaSessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.bus.emit("status", status);
  }
}
