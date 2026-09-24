import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ZuniaConnectError,
  bytesToBase64,
  type ConnectEnvelope,
  type ZuniaPairing,
  type ZuniaSessionStatus,
} from "@zunialab/sdk-core";
import { STORAGE_KEYS } from "./storage.js";
import { FakeRelay, FakeWallet, MemoryStorage, waitFor, wireAccount } from "./test-support.js";
import { NativeWsTransport } from "./transports/native-ws.js";

const CHAIN = "cosmoshub-4";
const ADDRESS = "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu";
const OTHER = "cosmos1zg69v7ys40x77y352eufp27daufrg4ncnjqz7q";
const SIGNATURE = {
  pub_key: { type: "tendermint/PubKeySecp256k1", value: bytesToBase64(new Uint8Array(33).fill(2)) },
  signature: bytesToBase64(new Uint8Array(64).fill(9)),
};

const relay = new FakeRelay();
before(() => relay.start());
after(() => relay.stop());

function transport(): NativeWsTransport {
  return new NativeWsTransport({ reconnectMinMs: 20, reconnectMaxMs: 80, heartbeatMs: 1_000, deadAfterMs: 5_000, restoreWaitMs: 1_000 });
}

async function pair(options: { storage?: MemoryStorage; approve?: boolean; requestTimeoutMs?: number; repeatHello?: boolean } = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const dapp = transport();
  const wallet = new FakeWallet([wireAccount(CHAIN, ADDRESS)]);
  const statuses: ZuniaSessionStatus[] = [];
  const events: string[] = [];
  let pairing: ZuniaPairing | undefined;
  let code = "";
  dapp.on("status", (status) => statuses.push(status));
  dapp.on("pairing", (value) => {
    pairing = value;
  });
  dapp.on("verification", (value) => {
    code = value;
  });
  dapp.on("disconnect", (reason) => events.push(`disconnect:${reason}`));
  dapp.on("error", (error) => events.push(`error:${error.code}`));
  const connecting = dapp.connect({
    chains: [CHAIN],
    apiBase: relay.apiBase,
    storage,
    requestTimeoutMs: options.requestTimeoutMs,
    metadata: { name: "Test dApp", url: "https://app.example.com" },
  });
  connecting.catch(() => {});
  await waitFor(() => Boolean(pairing), 3_000, "pairing");
  await wallet.pair(pairing!.uri, options.approve ?? true, options.repeatHello ?? false);
  return { dapp, wallet, storage, statuses, events, connecting, pairing: pairing!, code: () => code };
}

function answer(wallet: FakeWallet, reply: (message: ConnectEnvelope) => Record<string, unknown> | null): void {
  wallet.respond = reply;
}

describe("NativeWsTransport", () => {
  it("pairs, shows the phone's code, and never lets the relay read a message", async () => {
    const { dapp, wallet, storage, statuses, connecting, pairing, code } = await pair();
    await connecting;
    assert.match(pairing.uri, /^zunia:\/\/connect\?v=2&/);
    assert.match(code(), /^\d{6}$/);
    assert.equal(code(), wallet.verificationCode);
    assert.deepEqual(statuses, ["connecting", "awaiting_wallet", "connected"]);
    const [account] = dapp.getAccounts();
    assert.equal(account?.address, ADDRESS);
    assert.ok(account?.pubkey instanceof Uint8Array && account.pubkey.length === 33);
    assert.deepEqual(dapp.getChains(), [CHAIN]);

    const request = wallet.received[0]!;
    assert.equal(request.type, "connect_request");
    assert.equal((request.payload as { metadata: { name: string } }).metadata.name, "Test dApp");

    const seen = JSON.stringify(relay.frames);
    assert.ok(!seen.includes("connect_request") && !seen.includes("Test dApp") && !seen.includes(ADDRESS));
    const saved = storage.getItem(STORAGE_KEYS.nativeSession) ?? "";
    assert.ok(saved.includes('"dappToken"') && !saved.includes("walletJoinToken") && !saved.includes("secretKey"));
    await dapp.disconnect();
  });

  it("signs through the phone and returns bytes and bigints", async () => {
    const { dapp, wallet, connecting } = await pair();
    await connecting;
    answer(wallet, (message) => {
      const payload = message.payload as { signDoc?: unknown; encoding?: string };
      if (message.type === "sign_direct") return { type: "result", id: message.id, payload: { signed: payload.signDoc, signature: SIGNATURE } };
      if (message.type === "sign_arbitrary") return { type: "result", id: message.id, payload: SIGNATURE };
      return null;
    });
    const direct = await dapp.signDirect(CHAIN, ADDRESS, {
      bodyBytes: new Uint8Array([1, 2, 3]),
      authInfoBytes: new Uint8Array([4]),
      chainId: CHAIN,
      accountNumber: 5n,
    });
    assert.deepEqual(direct.signed.bodyBytes, new Uint8Array([1, 2, 3]));
    assert.equal(direct.signed.accountNumber, 5n);
    assert.deepEqual(direct.signature, SIGNATURE);
    const wire = wallet.received.find((m) => m.type === "sign_direct")!.payload as { signDoc: Record<string, string> };
    assert.deepEqual(wire.signDoc, { bodyBytes: "AQID", authInfoBytes: "BA==", chainId: CHAIN, accountNumber: "5" });

    assert.deepEqual(await dapp.signArbitrary(CHAIN, ADDRESS, new Uint8Array([0xff])), SIGNATURE);
    const arbitrary = wallet.received.find((m) => m.type === "sign_arbitrary")!.payload as { data: string; encoding: string };
    assert.deepEqual([arbitrary.data, arbitrary.encoding], ["/w==", "base64"]);
    await dapp.disconnect();
  });

  it("passes the wallet's error codes through and times out silent requests", async () => {
    const { dapp, wallet, connecting } = await pair({ requestTimeoutMs: 150 });
    await connecting;
    answer(wallet, (message) =>
      message.type === "sign_amino" ? { type: "error", id: message.id, payload: { code: "USER_REJECTED", message: "Declined" } } : null,
    );
    const doc = { chain_id: CHAIN, account_number: "1", sequence: "0", fee: { amount: [], gas: "1" }, msgs: [], memo: "" };
    await assert.rejects(dapp.signAmino(CHAIN, ADDRESS, doc), (error: unknown) => error instanceof ZuniaConnectError && error.code === "USER_REJECTED");
    await assert.rejects(dapp.signArbitrary(CHAIN, ADDRESS, "hi"), (error: unknown) => error instanceof ZuniaConnectError && error.code === "TIMEOUT");
    await dapp.disconnect();
  });

  it("reconnects after a drop and resends what the relay never confirmed", async () => {
    const { dapp, wallet, statuses, connecting } = await pair();
    await connecting;
    answer(wallet, (message) => (message.type === "sign_arbitrary" ? { type: "result", id: message.id, payload: SIGNATURE } : null));
    relay.dropDapp(relay.onlyRoom().id);
    const signed = dapp.signArbitrary(CHAIN, ADDRESS, "during the outage");
    assert.deepEqual(await signed, SIGNATURE);
    assert.ok(statuses.includes("reconnecting"));
    await waitFor(() => statuses.at(-1) === "connected", 3_000, "connected again");
    const copies = wallet.received.filter((m) => m.type === "sign_arbitrary").length;
    assert.equal(copies, 1, "the wallet acts on each request once");
    await dapp.disconnect();
  });

  it("restores after a reload and keeps counting sequence numbers", async () => {
    const storage = new MemoryStorage();
    const first = await pair({ storage });
    await first.connecting;
    answer(first.wallet, (message) => (message.type === "sign_arbitrary" ? { type: "result", id: message.id, payload: SIGNATURE } : null));
    await first.dapp.signArbitrary(CHAIN, ADDRESS, "before reload");

    const reloaded = transport();
    const statuses: ZuniaSessionStatus[] = [];
    reloaded.on("status", (status) => statuses.push(status));
    assert.equal(await reloaded.restore({ storage }), true);
    assert.equal(statuses.at(-1), "connected");
    assert.equal(reloaded.getAccounts()[0]?.address, ADDRESS);
    await waitFor(() => first.events.includes("disconnect:replaced"), 3_000, "first tab replaced");
    assert.ok(storage.getItem(STORAGE_KEYS.nativeSession), "the replaced tab leaves the saved session alone");
    assert.deepEqual(await reloaded.signArbitrary(CHAIN, ADDRESS, "after reload"), SIGNATURE);
    assert.equal(first.wallet.dropped, 0);
    await reloaded.disconnect();
    assert.equal(await transport().restore({ storage }), false);
  });

  it("follows the phone: account changes, then the phone ending the session", async () => {
    const { dapp, wallet, storage, events, connecting } = await pair({ requestTimeoutMs: 5_000 });
    await connecting;
    let seen = "";
    dapp.on("accountsChanged", (accounts) => {
      seen = accounts[0]?.address ?? "";
    });
    wallet.seal({ type: "accounts_changed", payload: { accounts: [wireAccount(CHAIN, OTHER, 3)] } });
    await waitFor(() => seen === OTHER, 3_000, "accounts_changed");
    assert.ok(storage.getItem(STORAGE_KEYS.nativeSession)?.includes(OTHER));

    const waiting = dapp.signArbitrary(CHAIN, OTHER, "never answered");
    await waitFor(() => wallet.received.some((m) => m.type === "sign_arbitrary"), 3_000, "request");
    wallet.close();
    await assert.rejects(waiting, (error: unknown) => error instanceof ZuniaConnectError && error.code === "DISCONNECTED");
    assert.ok(events.includes("disconnect:closed"));
    assert.equal(storage.getItem(STORAGE_KEYS.nativeSession), null);
  });

  it("ignores what the wallet sends twice after a reconnect", async () => {
    const { dapp, wallet, events, connecting } = await pair({ repeatHello: true });
    await connecting;
    assert.equal(wallet.received.filter((m) => m.type === "connect_request").length, 1);
    answer(wallet, (message) => (message.type === "sign_arbitrary" ? { type: "result", id: message.id, payload: SIGNATURE } : null));
    assert.deepEqual(await dapp.signArbitrary(CHAIN, ADDRESS, "once"), SIGNATURE);
    const copy = wallet.sent.filter((frame) => frame.t === "msg").at(-1)!;
    wallet.send(copy);
    wallet.send(copy);
    assert.deepEqual(await dapp.signArbitrary(CHAIN, ADDRESS, "again"), SIGNATURE);
    assert.deepEqual(events.filter((event) => event.startsWith("error")), []);
    await dapp.disconnect();
  });

  it("drops frames it cannot open without ending the session", async () => {
    const { dapp, wallet, events, connecting } = await pair();
    await connecting;
    wallet.send({ t: "msg", n: "AAAAAAAAAAAAAAAA", c: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    await waitFor(() => events.includes("error:PAIRING_FAILED"), 3_000, "error event");
    answer(wallet, (message) => (message.type === "sign_arbitrary" ? { type: "result", id: message.id, payload: SIGNATURE } : null));
    assert.deepEqual(await dapp.signArbitrary(CHAIN, ADDRESS, "still here"), SIGNATURE);
    await dapp.disconnect();
  });

  it("reports a declined pairing and deletes the session on disconnect", async () => {
    const declined = await pair({ approve: false });
    await assert.rejects(declined.connecting, (error: unknown) => error instanceof ZuniaConnectError && error.code === "USER_REJECTED");
    assert.equal(declined.statuses.at(-1), "disconnected");
    assert.equal(declined.storage.getItem(STORAGE_KEYS.nativeSession), null);

    const accepted = await pair();
    await accepted.connecting;
    const id = relay.onlyRoom().id;
    await accepted.dapp.disconnect();
    await waitFor(() => !relay.rooms.has(id), 3_000, "relay forgets the session");
  });

  it("checks the relay's answer before pairing", async () => {
    const bad = new NativeWsTransport({ fetch: async () => new Response(JSON.stringify({ v: "zunia.connect.v1" }), { status: 201 }) });
    await assert.rejects(bad.connect({ chains: [CHAIN], apiBase: "https://relay.example" }), (error: unknown) => error instanceof ZuniaConnectError && error.code === "NETWORK");
    const busy = new NativeWsTransport({ fetch: async () => new Response("", { status: 429, headers: { "retry-after": "12" } }) });
    await assert.rejects(busy.connect({ chains: [CHAIN], apiBase: "https://relay.example" }), /12 seconds/);
    await assert.rejects(transport().connect({ chains: [CHAIN] }), (error: unknown) => error instanceof ZuniaConnectError && error.code === "INVALID_PARAMS");
  });
});
