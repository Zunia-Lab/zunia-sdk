import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createZuniaMcpServer, type ZuniaMcpContext } from "./server.js";
import { VERSION } from "./version.js";

/**
 * Streamable HTTP for the hosted endpoint (https://docs.zunialab.com/mcp).
 * Stateless: every POST gets a fresh server over shared caches, so nothing is
 * kept between requests and any number of clients can use it without a key.
 */

export interface HttpServerOptions {
  port: number;
  host: string;
  /** Default /mcp. Health answers at `${path}/health`. */
  path?: string;
  /** Host header values accepted (DNS rebinding guard). Localhost names are always accepted. */
  allowedHosts?: string[];
  /** "cloudflare" reads the client address from CF-Connecting-IP, for the rate limit. */
  trustProxy?: "cloudflare" | "none";
  /** Requests per minute per client address. Default 120. */
  perMinute?: number;
  /** Where a browser that opens the endpoint is sent. */
  docsUrl?: string;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];
const MAX_BODY = 256 * 1024;

/** A token bucket per client address, refilled continuously. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds to wait, or 0 when the request may go ahead. */
  take(key: string): number {
    const now = this.now();
    const capacity = this.perMinute;
    const bucket = this.buckets.get(key) ?? { tokens: capacity, at: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.at) / 60_000) * capacity);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return Math.ceil(((1 - bucket.tokens) / capacity) * 60);
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 50_000) this.prune(now);
    return 0;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) if (now - bucket.at > 120_000) this.buckets.delete(key);
  }
}

function hostOf(header: string | undefined): string {
  if (!header) return "";
  return header.startsWith("[") ? header.slice(0, header.indexOf("]") + 1) : (header.split(":")[0] ?? "");
}

function clientAddress(req: IncomingMessage, trustProxy: HttpServerOptions["trustProxy"]): string {
  const forwarded = trustProxy === "cloudflare" ? req.headers["cf-connecting-ip"] : undefined;
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.socket.remoteAddress ?? "unknown";
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

export function startHttpServer(context: ZuniaMcpContext, options: HttpServerOptions): { server: Server; close: () => Promise<void> } {
  const path = options.path ?? "/mcp";
  const allowed = new Set([...LOCAL_HOSTS, ...(options.allowedHosts ?? [])].map((host) => host.toLowerCase()));
  const limiter = new RateLimiter(options.perMinute ?? 120);
  const docsUrl = options.docsUrl ?? "https://docs.zunialab.com/docs/get-started/ai";

  const handler = createMcpHandler(() => createZuniaMcpServer(context), {
    maxRequestBodySize: MAX_BODY,
    onerror: (error) => console.error(`mcp: ${error.message}`),
  });
  const serve = toNodeHandler(handler);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!allowed.has(hostOf(req.headers.host).toLowerCase())) return send(res, 403, "Host not allowed");

      if (url.pathname === `${path}/health`) {
        const docs = await context.docs.tryLoad();
        return send(res, docs ? 200 : 503, {
          ok: Boolean(docs),
          version: VERSION,
          docs: docs
            ? { pages: docs.index.pages.length, builtAt: docs.index.generatedAt, commit: docs.index.commit, stale: docs.stale }
            : null,
        });
      }
      if (url.pathname !== path) return send(res, 404, "Not found");

      cors(res);
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
          "Access-Control-Max-Age": "86400",
        });
        return res.end();
      }
      // Someone opened the endpoint in a browser: show them the setup page instead of a 405.
      const accept = String(req.headers.accept ?? "");
      if (req.method === "GET" && accept.includes("text/html") && !accept.includes("text/event-stream")) {
        res.writeHead(302, { Location: docsUrl });
        return res.end();
      }

      const wait = limiter.take(clientAddress(req, options.trustProxy));
      if (wait > 0) return send(res, 429, "Too many requests", { "Retry-After": String(wait) });

      await serve(req, res);
    })().catch((error: unknown) => {
      console.error(`mcp: ${error instanceof Error ? error.stack : String(error)}`);
      if (!res.headersSent) send(res, 500, "Internal error");
      else res.end();
    });
  });

  server.listen(options.port, options.host);
  return {
    server,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
