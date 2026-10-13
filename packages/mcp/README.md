# @zunialab/mcp

An [MCP](https://modelcontextprotocol.io) server for building with the Zunia wallet. It gives coding assistants the Zunia docs, the integration guides, the SDK versions on npm, the Zunia chain registry, and the SDK's own sign-in, error and IBC helpers.

It answers from the published docs (`docs-index.json`, written by every docs build), npm and the chain registry, read when asked. Nothing is bundled, so an answer is never older than what is published. It is read-only: it never signs and holds no keys.

## Use the hosted server

No install. Point your client at `https://docs.zunialab.com/mcp` (Streamable HTTP, no key):

```bash
claude mcp add --transport http zunia https://docs.zunialab.com/mcp
```

Setup for Claude Desktop, Cursor, VS Code and others: [docs.zunialab.com/docs/get-started/ai](https://docs.zunialab.com/docs/get-started/ai).

## Or run it locally (stdio)

```json
{
  "mcpServers": {
    "zunia": { "command": "npx", "args": ["-y", "@zunialab/mcp"] }
  }
}
```

Node 20 or later.

## Tools

| Tool | What it does |
|------|--------------|
| `search_docs` | Searches the docs section by section and returns the best matches with their links |
| `get_doc` | Reads a page, or one section with `page#anchor` |
| `list_docs` | Every page, grouped as on the site |
| `list_integrations` | The integration paths (quickstart, extension, React, sign-in, events, QR, WalletConnect, chain suggestion, Flutter, troubleshooting) |
| `get_integration_guide` | One guide, with its packages at their latest npm version, the install command and the pages it links to |
| `get_sdk_packages` | The `@zunialab` packages: latest version, publish date, peer dependencies |
| `get_chain` | A chain's entry in the [Zunia chain registry](https://github.com/Zunia-Lab/zunia-chain-registry) |
| `check_address` | Whether an address is valid bech32 and carries a chain's exact prefix |
| `explain_error` | What an error code means and what to do, from `explainZuniaError` |
| `verify_sign_in` | Runs `verifySignIn` on a captured sign-in and names the check that fails |
| `ibc_denom` | The `ibc/…` denom for a trace path and base denom |
| `build_forward_memo` | A packet-forward-middleware memo, validated by `@zunialab/interchain` |

Every docs page is also a resource (its `.md` URL), and the `integrate_zunia` prompt plans an integration from these tools.

## Command line

```text
zunia-mcp            serve over stdio
zunia-mcp --http     serve Streamable HTTP on PORT (default 3018) at /mcp, health at /mcp/health
```

| Variable | Default | |
|----------|---------|---|
| `ZUNIA_DOCS_URL` | `https://docs.zunialab.com` | Docs site to read `docs-index.json` from |
| `ZUNIA_DOCS_DIR` | | Read `docs-index.json` from a local docs build instead (re-read when it changes) |
| `PORT`, `HOST` | `3018`, `127.0.0.1` | HTTP listen address |
| `MCP_ALLOWED_HOSTS` | | Extra `Host` header values to accept, comma separated. Localhost is always accepted |
| `MCP_RATE_LIMIT` | `120` | HTTP requests per minute per client address |
| `TRUST_PROXY` | | `cloudflare` to rate-limit on `CF-Connecting-IP` |

HTTP serving is stateless: each request gets a fresh server over shared caches, for clients on the 2026-07-28 protocol and for 2025-era clients alike.

## In code

```ts
import { createZuniaMcpContext, createZuniaMcpServer } from "@zunialab/mcp";

const context = createZuniaMcpContext();
const server = await createZuniaMcpServer(context); // an McpServer from @modelcontextprotocol/server
```

## License

[Apache-2.0](./LICENSE)
