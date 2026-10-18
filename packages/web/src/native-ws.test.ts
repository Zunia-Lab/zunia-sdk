import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ZuniaConnectError,
  bytesToBase64,
  parsePairingUri,
  parseWakeUri,
  type ConnectEnvelope,
  type ZuniaPairing,
  type ZuniaSessionStatus,
} from "@zunialab/sdk-core";
import { STORAGE_KEYS } from "./storage.js";
import { FakeRelay, FakeWallet, MemoryStorage, waitFor, wireAccount } from "./test-support.js";
import { NativeWsTransport, type NativeWsTransportOptions } from "./transports/native-ws.js";

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

function transport(options: NativeWsTransportOptions = {}): NativeWsTransport {
  return new NativeWsTransport({ reconnectMinMs: 20, reconnectMaxMs: 80, heartbeatMs: 1_000, deadAfterMs: 5_000, restoreWaitMs: 1_000, ...options });
}

async function pair(
  options: {
    storage?: MemoryStorage;
    approve?: boolean;
    requestTimeoutMs?: number;
    repeatHello?: boolean;
    transport?: NativeWsTransportOptions;
    /** Runs once the pairing is known, before the wallet scans: e.g. tap "Open the Zunia app". */
    beforeScan?: (dapp: NativeWsTransport, pairing: ZuniaPairing) => void;
  } = {},
) {
  const storage = options.storage ?? new MemoryStorage();
  const dapp = transport(options.transport);
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
  options.beforeScan?.(dapp, pairing!);
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

  it("refuses a request too large for the relay before it leaves, and keeps the session", async () => {
    const { dapp, wallet, connecting } = await pair();
    await connecting;
    answer(wallet, (message) => (message.type === "sign_arbitrary" ? { type: "result", id: message.id, payload: SIGNATURE } : null));
    const before = relay.frames.filter((entry) => entry.role === "dapp" && entry.frame.t === "msg").length;
    await assert.rejects(
      dapp.signArbitrary(CHAIN, ADDRESS, "x".repeat(400_000)),
      (error: unknown) => error instanceof ZuniaConnectError && error.code === "INVALID_PARAMS" && error.reason === "too-large" && /KiB/.test(error.message),
    );
    assert.equal(relay.frames.filter((entry) => entry.role === "dapp" && entry.frame.t === "msg").length, before, "nothing was sent");
    // Just under 512 KiB once sealed: the relay takes it.
    assert.deepEqual(await dapp.signArbitrary(CHAIN, ADDRESS, "x".repeat(380_000)), SIGNATURE);
    assert.deepEqual(await dapp.signArbitrary(CHAIN, ADDRESS, "small"), SIGNATURE);
    await dapp.disconnect();
  });

  it("fails the request the relay could not queue for an offline phone, at once, and delivers the others", async () => {
    const { dapp, wallet, connecting } = await pair({ requestTimeoutMs: 10_000 });
    await connecting;
    const room = relay.onlyRoom();
    wallet.goOffline();
    await waitFor(() => room.sockets.wallet === null, 3_000, "wallet offline");
    relay.queueMaxFrames = 2;
    try {
      const settled: string[] = [];
      const track = (label: string, promise: Promise<unknown>) =>
        promise.then(
          () => settled.push(`${label}:ok`),
          (error: ZuniaConnectError) => settled.push(`${label}:${error.code}:${error.reason ?? ""}`),
        );
      const started = Date.now();
      const first = track("first", dapp.signArbitrary(CHAIN, ADDRESS, "one"));
      const second = track("second", dapp.signArbitrary(CHAIN, ADDRESS, "two"));
      const third = track("third", dapp.signArbitrary(CHAIN, ADDRESS, "three"));
      await third;
      assert.deepEqual(settled, ["third:NETWORK:queue-full"]);
      assert.ok(Date.now() - started < 3_000, "no wait for the timeout");

      answer(wallet, (message) => (message.type === "sign_arbitrary" ? { type: "result", id: message.id, payload: SIGNATURE } : null));
      await wallet.comeBack();
      await Promise.all([first, second]);
      assert.deepEqual(settled.sort(), ["first:ok", "second:ok", "third:NETWORK:queue-full"]);
      const data = wallet.received.filter((m) => m.type === "sign_arbitrary").map((m) => (m.payload as { data: string }).data);
      assert.deepEqual(data, ["one", "two"], "the refused request is never sent again");
    } finally {
      relay.queueMaxFrames = 32;
    }
    await dapp.disconnect();
  });

  it("refuses a return target wallets would ignore before creating a session", async () => {
    let calls = 0;
    const dapp = new NativeWsTransport({
      returnUrl: "http://app.example.com",
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 500 });
      },
    });
    await assert.rejects(
      dapp.connect({ chains: [CHAIN], apiBase: relay.apiBase }),
      (error: unknown) => error instanceof ZuniaConnectError && error.code === "INVALID_PARAMS",
    );
    assert.equal(calls, 0);
  });
});

describe("NativeWsTransport on a phone", () => {
  function phone(options: NativeWsTransportOptions = {}) {
    const opened: string[] = [];
    return { opened, options: { phoneBrowser: true, openUrl: (url: string) => void opened.push(url), ...options } };
  }

  it("puts the return target in the app link only, and wakes Zunia after each signature request", async () => {
    const storage = new MemoryStorage();
    const device = phone({ returnUrl: "myapp://zunia/done" });
    const { dapp, wallet, connecting, pairing } = await pair({
      storage,
      transport: device.options,
      beforeScan: (transport) => assert.equal(transport.openWallet(), true),
    });
    await connecting;
    assert.ok(!pairing.uri.includes("ret="), "the QR code has no return target");
    assert.equal(parsePairingUri(pairing.appUri!)?.returnUrl, "myapp://zunia/done");
    assert.deepEqual(device.opened, [pairing.appUri]);
    assert.equal(dapp.pairedOnThisDevice, true);

    answer(wallet, (message) => (message.type === "sign_arbitrary" ? { type: "result", id: message.id, payload: SIGNATURE } : null));
    const sid = relay.onlyRoom().id;
    assert.deepEqual(await dapp.signArbitrary(CHAIN, ADDRESS, "approve on this phone"), SIGNATURE);
    assert.deepEqual(device.opened.slice(1), [`zunia://connect/wake?sid=${sid}`]);
    assert.deepEqual(parseWakeUri(device.opened[1]!), { sessionId: sid });

    // After a reload the session still counts as paired from this phone, and the
    // account refresh that follows a restore does not open Zunia.
    const reloaded = phone();
    const again = transport(reloaded.options);
    assert.equal(await again.restore({ storage }), true);
    await waitFor(() => wallet.received.some((m) => m.type === "get_accounts"), 3_000, "account refresh");
    assert.deepEqual(reloaded.opened, []);
    await again.signArbitrary(CHAIN, ADDRESS, "after reload");
    assert.deepEqual(reloaded.opened, [`zunia://connect/wake?sid=${sid}`]);
    assert.equal(again.openWallet(), true, "a button can wake Zunia too");
    await again.disconnect();
    await dapp.disconnect();
  });

  it("uses the page address as the default return target", async () => {
    const globals = globalThis as { location?: unknown };
    const saved = globals.location;
    globals.location = { href: "https://app.example.com/swap?pair=1" };
    try {
      const device = phone();
      const { dapp, connecting, pairing } = await pair({ transport: device.options });
      await connecting;
      assert.equal(parsePairingUri(pairing.appUri!)?.returnUrl, "https://app.example.com/swap?pair=1");
      await dapp.disconnect();

      const never = await pair({ transport: phone({ openWallet: "never" }).options });
      await never.connecting;
      assert.equal(never.pairing.appUri, never.pairing.uri, "never: no return target unless one is given");
      await never.dapp.disconnect();

      const desktop = await pair({ transport: { phoneBrowser: false } });
      await desktop.connecting;
      assert.equal(desktop.pairing.appUri, desktop.pairing.uri);
      await desktop.dapp.disconnect();
    } finally {
      globals.location = saved;
    }
  });

  it("does not open Zunia by itself when the phone scanned, or with openWallet: never", async () => {
    for (const options of [phone(), phone({ openWallet: "never" })]) {
      const scanned = await pair({
        transport: options.options,
        beforeScan: options.options.openWallet === "never" ? (transport) => void transport.openWallet() : undefined,
      });
      await scanned.connecting;
      answer(scanned.wallet, (message) => (message.type === "sign_arbitrary" ? { type: "result", id: message.id, payload: SIGNATURE } : null));
      await scanned.dapp.signArbitrary(CHAIN, ADDRESS, "no wake");
      assert.ok(!options.opened.some((url) => url.includes("/wake")), options.options.openWallet ?? "auto");
      await scanned.dapp.disconnect();
    }
  });

  it("notices a tap on any link to the app link", async () => {
    const globals = globalThis as { document?: unknown };
    const saved = globals.document;
    let listener: ((event: Event) => void) | undefined;
    globals.document = {
      addEventListener: (_type: string, fn: (event: Event) => void) => {
        listener = fn;
      },
      removeEventListener: () => {
        listener = undefined;
      },
    };
    try {
      const device = phone();
      const { dapp, connecting } = await pair({
        transport: device.options,
        beforeScan: (_transport, pairing) => {
          const tap = (href: string) =>
            listener?.({ target: { closest: () => ({ getAttribute: () => href }) } } as unknown as Event);
          tap("https://example.com/elsewhere");
          assert.equal(_transport.pairedOnThisDevice, false);
          tap(pairing.appUri!);
          assert.equal(_transport.pairedOnThisDevice, true);
        },
      });
      await connecting;
      assert.equal(listener, undefined, "stops listening once paired");
      await dapp.disconnect();
    } finally {
      globals.document = saved;
    }
  });
});

