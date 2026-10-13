#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DEFAULT_DOCS_URL } from "./docs.js";
import { startHttpServer } from "./http.js";
import { createZuniaMcpContext, createZuniaMcpServer } from "./server.js";
import { VERSION } from "./version.js";

const HELP = `zunia-mcp ${VERSION}: an MCP server for building with the Zunia wallet.

Usage:
  zunia-mcp            serve over stdio (what MCP clients start)
  zunia-mcp --http     serve Streamable HTTP on PORT (default 3018) at /mcp

Environment:
  ZUNIA_DOCS_URL       docs site to read (default ${DEFAULT_DOCS_URL})
  ZUNIA_DOCS_DIR       read docs-index.json from a local docs build instead
  PORT, HOST           HTTP listen address (default 3018, 127.0.0.1)
  MCP_ALLOWED_HOSTS    extra Host header values to accept, comma separated
  MCP_RATE_LIMIT       HTTP requests per minute per client (default 120)
  TRUST_PROXY          "cloudflare" to rate-limit on CF-Connecting-IP

Docs: https://docs.zunialab.com/docs/get-started/ai`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

const env = process.env;
const context = createZuniaMcpContext({
  docs: { url: env.ZUNIA_DOCS_URL || DEFAULT_DOCS_URL, ...(env.ZUNIA_DOCS_DIR ? { dir: env.ZUNIA_DOCS_DIR } : {}) },
});

if (args.includes("--http")) {
  const port = Number(env.PORT ?? 3018);
  const host = env.HOST ?? "127.0.0.1";
  const http = startHttpServer(context, {
    port,
    host,
    allowedHosts: (env.MCP_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === "cloudflare" ? "cloudflare" : "none",
    perMinute: Number(env.MCP_RATE_LIMIT ?? 120) || 120,
  });
  http.server.on("listening", () => console.log(`zunia-mcp ${VERSION} listening on http://${host}:${port}/mcp`));
  const stop = () => void http.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else {
  // stdout is the protocol channel: anything else goes to stderr.
  const handle = serveStdio(() => createZuniaMcpServer(context));
  const stop = () => void handle.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
