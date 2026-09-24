// Installs the packed tarballs from npm's point of view, in a plain Node
// script and in a Vite + React app, the two ways the SDK gets used.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packAll, run } from "./pack.mjs";

const keep = process.argv.includes("--keep");
const destination = mkdtempSync(join(tmpdir(), "zunia-smoke-"));
const tarballs = packAll(destination);
const local = Object.fromEntries(Object.entries(tarballs).map(([name, file]) => [name, `file:${file}`]));

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
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", ...local },
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
} finally {
  if (keep) console.log(`kept ${destination}`);
  else rmSync(destination, { recursive: true, force: true });
}
