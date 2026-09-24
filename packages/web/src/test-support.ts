/**
 * Test doubles for the web transports: storage, a relay that follows the
 * zunia.connect.v2 rules, and a phone wallet built on the sdk-core crypto.
 * The real relay is exercised by zunia-e2e.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  ConnectCipher,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  deriveConnectKeys,
  generateConnectKeyPair,
  parsePairingUri,
  type ConnectEnvelope,
  type WireAccount,
  type ZuniaStorage,
} from "@zunialab/sdk-core";

export class MemoryStorage implements ZuniaStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export function waitFor(check: () => boolean, timeoutMs = 3_000, label = "condition"): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const token = () => bytesToBase64Url(randomBytes(32));

interface Room {
  id: string;
  dappToken: string;
  joinToken: string | null;
  resumeToken: string | null;
  paired: boolean;
  expiresAt: number;
  sockets: { dapp: WebSocket | null; wallet: WebSocket | null };
  queues: { dapp: string[]; wallet: string[] };
}

export class FakeRelay {
  readonly rooms = new Map<string, Room>();
  readonly frames: Array<{ role: "dapp" | "wallet"; frame: Record<string, unknown> }> = [];
  private server!: Server;
  private wss!: WebSocketServer;
  base = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.http(req, res));
    this.wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has("zunia.connect.v2") ? "zunia.connect.v2" : false) });
    this.server.on("upgrade", (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.admit(ws, req));
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.base = `127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  get apiBase(): string {
    return `http://${this.base}`;
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Cuts the dApp's connection without a close frame, like a network drop. */
  dropDapp(id: string): void {
    this.rooms.get(id)?.sockets.dapp?.terminate();
  }

  onlyRoom(): Room {
    const [room] = this.rooms.values();
    if (!room) throw new Error("no session");
    return room;
  }

  private http(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://relay");
    if (req.method === "POST" && url.pathname === "/v1/connect/sessions") {
      const room: Room = {
        id: bytesToBase64Url(randomBytes(16)),
        dappToken: token(),
        joinToken: token(),
        resumeToken: null,
        paired: false,
        expiresAt: Date.now() + 600_000,
        sockets: { dapp: null, wallet: null },
        queues: { dapp: [], wallet: [] },
      };
      this.rooms.set(room.id, room);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          v: "zunia.connect.v2",
          sessionId: room.id,
          dappToken: room.dappToken,
          walletJoinToken: room.joinToken,
          verifiedOrigin: req.headers.origin ?? null,
          expiresAt: room.expiresAt,
          wsUrl: `ws://${this.base}/v1/connect/ws`,
        }),
      );
      return;
    }
    const match = /^\/v1\/connect\/sessions\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
    if (req.method === "DELETE" && match) {
      const room = this.rooms.get(match[1]!);
      if (!room || req.headers.authorization !== `Bearer ${room.dappToken}`) {
        res.writeHead(401).end();
        return;
      }
      this.end(room, "deleted");
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  }

  private admit(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", "http://relay");
    const room = this.rooms.get(url.searchParams.get("sid") ?? "");
    const role = url.searchParams.get("role");
    const offered = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((item) => item.trim());
    const secret = offered.find((item) => item.startsWith("zunia.token."))?.slice("zunia.token.".length);
    let resumeToken: string | undefined;
    const ok =
      room &&
      secret &&
      ((role === "dapp" && secret === room.dappToken) ||
        (role === "wallet" && secret === room.resumeToken) ||
        (role === "wallet" && secret === room.joinToken && ((resumeToken = token()), true)));
    if (!ok || !room || (role !== "dapp" && role !== "wallet")) {
      ws.close(4401, "unauthorized");
      return;
    }
    if (resumeToken) {
      room.joinToken = null;
      room.resumeToken = resumeToken;
    }
    room.sockets[role]?.close(4000, "replaced");
    room.sockets[role] = ws;
    const peer = role === "dapp" ? "wallet" : "dapp";
    this.send(ws, {
      t: "welcome",
      v: "zunia.connect.v2",
      role,
      sessionId: room.id,
      verifiedOrigin: null,
      paired: room.paired,
      peer: Boolean(room.sockets[peer]),
      expiresAt: room.expiresAt,
      ...(resumeToken ? { resumeToken } : {}),
    });
    for (const data of room.queues[role]) ws.send(data);
    room.queues[role] = [];
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      this.frames.push({ role, frame });
      if (room.sockets[role] !== ws) return;
      if (frame.t === "ping") this.send(ws, { t: "pong" });
      else if (frame.t === "hello" && role === "wallet") this.deliver(room, "dapp", { t: "hello", pk: frame.pk });
      else if (frame.t === "msg") this.deliver(room, peer, { t: "msg", n: frame.n, c: frame.c });
      else if (frame.t === "paired" && role === "wallet") {
        room.paired = true;
        room.expiresAt = Date.now() + 86_400_000;
        for (const socket of Object.values(room.sockets)) if (socket) this.send(socket, { t: "paired", expiresAt: room.expiresAt });
      } else if (frame.t === "close") this.end(room, "closed");
    });
    ws.on("close", () => {
      if (room.sockets[role] === ws) room.sockets[role] = null;
    });
  }

  private deliver(room: Room, to: "dapp" | "wallet", frame: Record<string, unknown>): void {
    const target = room.sockets[to];
    const data = JSON.stringify(frame);
    if (target && target.readyState === WebSocket.OPEN) target.send(data);
    else room.queues[to].push(data);
  }

  private send(ws: WebSocket, frame: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private end(room: Room, reason: string): void {
    this.rooms.delete(room.id);
    for (const socket of Object.values(room.sockets)) {
      if (!socket) continue;
      this.send(socket, { t: "closed", reason });
      socket.close(4001, reason);
    }
  }
}

/** A phone wallet: scans the pairing URI and answers requests through `respond`. */
export class FakeWallet {
  socket: WebSocket | null = null;
  cipher: ConnectCipher | null = null;
  verificationCode = "";
  resumeToken = "";
  /** Frames refused as replays or forgeries. Real wallets must drop these quietly too. */
  dropped = 0;
  readonly received: ConnectEnvelope[] = [];
  respond: (message: ConnectEnvelope) => Record<string, unknown> | null = () => null;

  constructor(readonly accounts: WireAccount[]) {}

  async pair(uri: string, approve = true): Promise<void> {
    const parsed = parsePairingUri(uri);
    if (!parsed) throw new Error("bad pairing uri");
    const own = generateConnectKeyPair();
    const keys = deriveConnectKeys({
      role: "wallet",
      sessionId: parsed.sessionId,
      secretKey: own.secretKey,
      peerPublicKey: base64UrlToBytes(parsed.dappPublicKey),
    });
    this.cipher = new ConnectCipher({ role: "wallet", sessionId: parsed.sessionId, keys });
    this.verificationCode = keys.verificationCode;
    await this.open(`${parsed.relay}/v1/connect/ws?sid=${parsed.sessionId}&role=wallet`, parsed.joinToken);
    this.send({ t: "hello", pk: bytesToBase64Url(own.publicKey) });
    await waitFor(() => this.received.some((m) => m.type === "connect_request"), 3_000, "connect_request");
    const request = this.received.find((m) => m.type === "connect_request")!;
    const chains = (request.payload as { chains: string[] }).chains;
    if (approve) {
      this.seal({ type: "connect_approve", id: request.id, payload: { accounts: this.accounts, chains } });
      this.send({ t: "paired" });
    } else {
      this.seal({ type: "connect_reject", id: request.id, payload: { code: "USER_REJECTED", message: "No thanks" } });
    }
  }

  seal(message: Omit<ConnectEnvelope, "seq">): void {
    const frame = this.cipher!.seal(message);
    this.send({ t: "msg", n: frame.n, c: frame.c });
  }

  send(frame: Record<string, unknown>): void {
    this.socket!.send(JSON.stringify(frame));
  }

  close(): void {
    this.send({ t: "close" });
  }

  private open(url: string, secret: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, ["zunia.connect.v2", `zunia.token.${secret}`]);
      this.socket = socket;
      socket.on("error", reject);
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data)) as { t: string; n?: string; c?: string; resumeToken?: string };
        if (frame.t === "welcome") {
          if (frame.resumeToken) this.resumeToken = frame.resumeToken;
          resolve();
        }
        if (frame.t === "msg" && this.cipher) {
          let message: ConnectEnvelope;
          try {
            message = this.cipher.open({ n: frame.n!, c: frame.c! });
          } catch {
            this.dropped += 1;
            return;
          }
          this.received.push(message);
          const reply = this.respond(message);
          if (reply) this.seal(reply as Omit<ConnectEnvelope, "seq">);
        }
      });
    });
  }
}

export function wireAccount(chainId: string, address: string, fill = 2): WireAccount {
  const pubKey = new Uint8Array(33).fill(fill);
  pubKey[0] = 0x02;
  return { chainId, address, algo: "secp256k1", pubKey: bytesToBase64(pubKey) };
}
