import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ZuniaConnectError,
  checkSignInBinding,
  createNonce,
  parseSignInMessage,
  verifySignIn,
  type ZuniaPairing,
} from "@zunialab/sdk-core";
import { FakeProvider } from "./fake-provider.js";
import { ZuniaSessionImpl, restoreSession } from "./session.js";
import { STORAGE_KEYS } from "./storage.js";
import { FakeRelay, FakeWallet, MemoryStorage, waitFor, wireAccount } from "./test-support.js";

const HUB = "cosmoshub-4";
const isCode = (code: string) => (error: unknown) => error instanceof ZuniaConnectError && error.code === code;

describe("ZuniaSessionImpl with the extension", () => {
  it("picks the extension, publishes snapshots and gives CosmJS a signer", async () => {
    const provider = new FakeProvider();
    const session = new ZuniaSessionImpl({ extension: { provider } });
    const snapshots: unknown[] = [];
    session.subscribe(() => snapshots.push(session.getSnapshot()));
    await session.connect({ chains: HUB, storage: new MemoryStorage() });
    assert.equal(session.transport, "extension");
    assert.equal(session.getSnapshot().status, "connected");
    assert.ok(snapshots.length >= 3 && new Set(snapshots).size === snapshots.length, "a new object per change");

    const signer = session.getOfflineSigner(HUB);
    const [account] = await signer.getAccounts();
    assert.deepEqual(account, { address: provider.address, algo: "secp256k1", pubkey: provider.pubKey });
    const signed = await signer.signDirect(provider.address, {
      bodyBytes: new Uint8Array([1]),
      authInfoBytes: new Uint8Array([2]),
      chainId: HUB,
      accountNumber: 7n,
    });
    assert.equal(signed.signed.accountNumber, 7n);
    assert.equal(session.getKey(HUB).bech32Address, provider.address);
    assert.throws(() => session.getKey("osmosis-1"), isCode("NOT_CONNECTED"));
  });

  it("signs in with a message the server and the extension both accept", async () => {
    const provider = new FakeProvider();
    const session = new ZuniaSessionImpl({ extension: { provider } });
    await assert.rejects(session.signIn({ nonce: createNonce() }), isCode("NOT_CONNECTED"));
    await session.connect({ chains: [HUB], storage: null });
    const nonce = createNonce();
    const result = await session.signIn({
      nonce,
      statement: "Sign in to Example.",
      domain: "app.example.com",
      uri: "https://app.example.com",
    });
    assert.equal(result.address, provider.address);
    const verified = verifySignIn({ message: result.message, signature: result.signature, domain: "app.example.com", nonce, chainId: HUB });
    assert.equal(verified.address, provider.address);
    assert.ok(verified.expirationTime, "expires by default");
    const parsed = parseSignInMessage(result.message);
    checkSignInBinding(parsed, { origin: "https://app.example.com", chainId: HUB, signer: provider.address });
    assert.throws(() => checkSignInBinding(parsed, { origin: "https://evil.example", chainId: HUB, signer: provider.address }));
  });

  it("records failures in the snapshot", async () => {
    const provider = new FakeProvider();
    provider.enableError = { message: "Rejected", code: "USER_REJECTED" };
    const session = new ZuniaSessionImpl({ extension: { provider } });
    await assert.rejects(session.connect({ chains: [HUB], storage: null }), isCode("USER_REJECTED"));
    assert.equal(session.getSnapshot().status, "disconnected");
    assert.equal(session.getSnapshot().error?.code, "USER_REJECTED");
    assert.equal(session.transport, null);

    const nothing = new ZuniaSessionImpl();
    await assert.rejects(nothing.connect({ chains: [HUB], openInstallIfMissing: false }), isCode("NOT_INSTALLED"));
  });

  it("restores the transport used last time", async () => {
    const provider = new FakeProvider();
    const storage = new MemoryStorage();
    await new ZuniaSessionImpl({ extension: { provider } }).connect({ chains: [HUB], storage });
    assert.match(storage.getItem(STORAGE_KEYS.transport) ?? "", /extension/);
    const restored = await restoreSession({ storage }, { extension: { provider } });
    assert.equal(restored?.transport, "extension");
    assert.equal(restored?.accounts[0]?.address, provider.address);

    const twice = new ZuniaSessionImpl({ extension: { provider } });
    const [a, b] = [twice.restore({ storage }), twice.restore({ storage })];
    assert.equal(a, b, "concurrent restores share one attempt");
    assert.equal(await a, true);

    await restored!.disconnect();
    assert.equal(await restoreSession({ storage }, { extension: { provider } }), null);
  });
});

describe("ZuniaSessionImpl with QR pairing", () => {
  const relay = new FakeRelay();
  before(() => relay.start());
  after(() => relay.stop());

  it("shows the pairing and the code, then clears them once connected", async () => {
    const session = new ZuniaSessionImpl({ nativeWs: { reconnectMinMs: 20 } });
    const wallet = new FakeWallet([wireAccount(HUB, "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu")]);
    let pairing: ZuniaPairing | undefined;
    session.on("pairing", (value) => {
      pairing = value;
    });
    const connecting = session.connect({ chains: [HUB], apiBase: relay.apiBase, storage: new MemoryStorage(), openInstallIfMissing: false });
    await waitFor(() => Boolean(pairing), 3_000, "pairing");
    assert.equal(session.getSnapshot().status, "awaiting_wallet");
    assert.equal(session.getSnapshot().pairing?.uri, pairing!.uri);
    await wallet.pair(pairing!.uri);
    await connecting;
    assert.equal(session.transport, "native-ws");
    assert.equal(session.getSnapshot().verificationCode, wallet.verificationCode);
    assert.equal(session.getSnapshot().pairing, undefined);
    assert.equal(session.accounts.length, 1);
    await session.disconnect();
    assert.equal(session.getSnapshot().status, "disconnected");
  });
});
