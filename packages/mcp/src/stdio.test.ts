import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixtureDocsDir } from "./test-support.js";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

for (const mode of ["legacy", "auto"] as const) {
  test(`the CLI serves stdio to a ${mode} client`, async () => {
    const client = new Client({ name: "zunia-mcp-test", version: "1.0.0" }, { versionNegotiation: { mode } });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", cli],
      env: { ...process.env, ZUNIA_DOCS_DIR: fixtureDocsDir() } as Record<string, string>,
      stderr: "pipe",
    });
    await client.connect(transport);
    try {
      assert.equal(client.getServerVersion()?.name, "zunia");
      const { tools } = await client.listTools();
      assert.equal(tools.length, 12);
      const result = await client.callTool({ name: "search_docs", arguments: { query: "verifySignIn nonce" } });
      assert.match(JSON.stringify(result), /integrate\/sign-in/);
    } finally {
      await client.close();
    }
  });
}
