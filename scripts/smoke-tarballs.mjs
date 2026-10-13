// Installs the packed tarballs from npm's point of view, in a plain Node
// script and in a Vite + React app, the two ways the SDK gets used, and
// starts the MCP server's bin over stdio the way an MCP client does.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { packAll, run } from "./pack.mjs";

const keep = process.argv.includes("--keep");
const destination = mkdtempSync(join(tmpdir(), "zunia-smoke-"));
const tarballs = packAll(destination);
const local = Object.fromEntries(Object.entries(tarballs).map(([name, file]) => [name, `file:${file}`]));
const { "@zunialab/mcp": mcpTarball, ...browserLocal } = local;

function project(name, manifest, files) {
  const dir = join(destination, name);
  mkdirSync(dir, { recursive: true });
  // overrides make sdk-web's dependency on sdk-core use the tarball too, since nothing is on npm yet.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, type: "module", overrides: local, ...manifest }, null, 2));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir });
  return dir;
}

try {
  const node = project(
    "node-app",
    { dependencies: { "@zunialab/sdk-core": local["@zunialab/sdk-core"], "@zunialab/sdk-web": local["@zunialab/sdk-web"], "@zunialab/interchain": local["@zunialab/interchain"], "@noble/curves": "^2.4.0", "@noble/hashes": "^2.4.0" } },
    {
      "index.mjs": `
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { adr36SignDoc, buildSignInMessage, bytesToBase64, createNonce, pubkeyToAddress, serializeAminoSignDoc, utf8ToBytes, verifySignIn } from "@zunialab/sdk-core";
import { createZuniaSession, renderQrSvg } from "@zunialab/sdk-web";
import * as interchain from "@zunialab/interchain";

const secret = sha256(utf8ToBytes("smoke"));
const pubKey = secp256k1.getPublicKey(secret, true);
const address = pubkeyToAddress(pubKey, "cosmos");
const nonce = createNonce();
const message = buildSignInMessage({ domain: "app.example.com", address, uri: "https://app.example.com", chainId: "cosmoshub-4", nonce });
const digest = sha256(serializeAminoSignDoc(adr36SignDoc(address, utf8ToBytes(message))));
const signature = { pub_key: { type: "tendermint/PubKeySecp256k1", value: bytesToBase64(pubKey) }, signature: bytesToBase64(secp256k1.sign(digest, secret, { prehash: false })) };
assert.equal(verifySignIn({ message, signature, domain: "app.example.com", nonce }).address, address);
assert.ok(renderQrSvg("zunia://connect?v=2").startsWith("<svg"));
assert.equal(createZuniaSession().status, "idle");
assert.ok(Object.keys(interchain).length > 10);
console.log("node smoke: ok");
`,
    },
  );
  run("node", ["index.mjs"], { cwd: node });

  const vite = project(
    "vite-app",
    {
      scripts: { build: "vite build" },
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", ...browserLocal },
      devDependencies: { vite: "^8.0.0" },
    },
    {
      "index.html": `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>`,
      "src/main.js": `
import "@zunialab/sdk-web/connect-button.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConnectPairingModal, ConnectWithZuniaButton, useZuniaSession } from "@zunialab/sdk-react";

function App() {
  const zunia = useZuniaSession({ restore: false });
  return createElement("div", null,
    createElement(ConnectWithZuniaButton, { onClick: () => zunia.connect({ chains: ["cosmoshub-4"] }) }),
    createElement(ConnectPairingModal, { open: true, onOpenChange() {}, status: "awaiting_wallet", pairing: { transport: "native-ws", uri: "zunia://connect?v=2" } }),
  );
}
createRoot(document.getElementById("root")).render(createElement(App));
`,
    },
  );
  run("npm", ["run", "build", "--silent"], { cwd: vite });
  const assets = join(vite, "dist", "assets");
  const chunks = readdirSync(assets).filter((file) => file.endsWith(".js"));
  const bundle = chunks.map((file) => readFileSync(join(assets, file), "utf8")).join("\n");
  // wc_sessionPropose only exists inside WalletConnect's own code.
  if (chunks.length !== 1 || bundle.includes("wc_sessionPropose")) throw new Error("WalletConnect code reached the bundle although the app never loads it");
  if (!readdirSync(assets).some((file) => file.endsWith(".css"))) throw new Error("the button stylesheet did not reach the bundle");
  console.log("vite smoke: ok");

  const docsIndex = {
    version: 1,
    site: "https://docs.zunialab.com",
    title: "Zunia Docs",
    summary: "Smoke test.",
    generatedAt: new Date().toISOString(),
    commit: null,
    sections: [{ title: "Integrate", optional: false, pages: ["integrate/react"] }],
    pages: [
      {
        id: "integrate/react",
        title: "React",
        description: "",
        url: "https://docs.zunialab.com/docs/integrate/react",
        markdownUrl: "https://docs.zunialab.com/docs/integrate/react.md",
        section: "Integrate",
        optional: false,
        headings: [],
        markdown: "# React\n\n## Restore after a reload\n\nuseZuniaSession restores the session.\n",
      },
    ],
  };
  const mcp = project("mcp-app", { dependencies: { "@zunialab/mcp": mcpTarball } }, { "docs/docs-index.json": JSON.stringify(docsIndex) });
  const child = spawn(join(mcp, "node_modules", ".bin", "zunia-mcp"), [], {
    env: { ...process.env, ZUNIA_DOCS_DIR: join(mcp, "docs") },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
  });
  const ask = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 15_000);
      replies.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    const init = await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
    if (init.result?.serverInfo?.name !== "zunia") throw new Error(`initialize answered ${JSON.stringify(init)}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await ask(2, "tools/list", {});
    if (list.result?.tools?.length !== 12) throw new Error(`tools/list answered ${JSON.stringify(list).slice(0, 300)}`);
    const search = await ask(3, "tools/call", { name: "search_docs", arguments: { query: "restore after a reload" } });
    if (!JSON.stringify(search).includes("integrate/react#restore-after-a-reload")) throw new Error(`search_docs answered ${JSON.stringify(search).slice(0, 300)}`);
    const denom = await ask(4, "tools/call", { name: "ibc_denom", arguments: { path: "transfer/channel-0", base_denom: "uatom" } });
    if (denom.result?.structuredContent?.denom !== "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2") {
      throw new Error(`ibc_denom answered ${JSON.stringify(denom).slice(0, 300)}`);
    }
  } finally {
    child.kill();
  }
  console.log("mcp smoke: ok");
} finally {
  if (keep) console.log(`kept ${destination}`);
  else rmSync(destination, { recursive: true, force: true });
}
