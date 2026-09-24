import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZuniaConnectError, bytesToBase64, type ZuniaPairing } from "@zunialab/sdk-core";
import { STORAGE_KEYS } from "./storage.js";
import { MemoryStorage, waitFor } from "./test-support.js";
import {
  WalletConnectTransport,
  type WalletConnectClient,
  type WalletConnectSession,
} from "./transports/walletconnect.js";

const HUB = "cosmoshub-4";
const ADDRESS = "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu";
const STRANGER = "cosmos1zg69v7ys40x77y352eufp27daufrg4ncnjqz7q";
const SIGNATURE = {
  pub_key: { type: "tendermint/PubKeySecp256k1", value: bytesToBase64(new Uint8Array(33).fill(2)) },
  signature: bytesToBase64(new Uint8Array(64).fill(9)),
};
const isCode = (code: string) => (error: unknown) => error instanceof ZuniaConnectError && error.code === code;

function fakeWalletConnect(approval: WalletConnectSession | Error = session()) {
  const listeners = new Map<string, Set<(args: never) => void>>();
  const sessions: WalletConnectSession[] = [];
  const requests: Array<{ method: string; params: unknown; chainId: string }> = [];
  const connects: unknown[] = [];
  let pubkeyFill = 2;
  const client: WalletConnectClient = {
    async connect(params) {
      connects.push(params);
      return {
        uri: "wc:abc123@2?relay-protocol=irn&symKey=00",
        approval: async () => {
          if (approval instanceof Error) throw approval;
          sessions.push(approval);
          return approval;
        },
      };
    },
    async request({ chainId, request }) {
      requests.push({ method: request.method, params: request.params, chainId });
      if (request.method === "cosmos_getAccounts") {
        return [
          { address: ADDRESS, algo: "secp256k1", pubkey: bytesToBase64(new Uint8Array(33).fill(pubkeyFill)) },
          { address: STRANGER, algo: "secp256k1", pubkey: bytesToBase64(new Uint8Array(33).fill(5)) },
        ];
      }
      if (request.method === "cosmos_signDirect") return { signed: (request.params as { signDoc: unknown }).signDoc, signature: SIGNATURE };
      throw Object.assign(new Error("Method not supported"), { code: 10001 });
    },
    async disconnect({ topic }) {
      const index = sessions.findIndex((item) => item.topic === topic);
      if (index >= 0) sessions.splice(index, 1);
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    session: { getAll: () => [...sessions] },
  };
  return {
    client,
    sessions,
    requests,
    connects,
    load: async () => ({ SignClient: { init: async () => client } }),
    emit(event: string, args: unknown) {
      for (const listener of [...(listeners.get(event) ?? [])]) (listener as (value: unknown) => void)(args);
    },
    setPubkeyFill(value: number) {
      pubkeyFill = value;
    },
  };
}

function session(topic = "topic-1", expiry = Math.floor(Date.now() / 1000) + 3_600): WalletConnectSession {
  return { topic, expiry, namespaces: { cosmos: { accounts: [`cosmos:${HUB}:${ADDRESS}`], methods: [], events: [] } } };
}

describe("WalletConnectTransport", () => {
  it("pairs, reads public keys and keeps only approved accounts", async () => {
    const wc = fakeWalletConnect();
    const transport = new WalletConnectTransport();
    let pairing: ZuniaPairing | undefined;
    transport.on("pairing", (value) => {
      pairing = value;
    });
    await transport.connect({ chains: [HUB], walletConnectProjectId: "p", loadWalletConnect: wc.load, storage: new MemoryStorage() });
    assert.equal(pairing?.uri.startsWith("wc:"), true);
    const namespaces = wc.connects[0] as { optionalNamespaces: { cosmos: { chains: string[]; methods: string[] } } };
    assert.deepEqual(namespaces.optionalNamespaces.cosmos.chains, [`cosmos:${HUB}`]);
    assert.ok(namespaces.optionalNamespaces.cosmos.methods.includes("cosmos_getAccounts"));
    const accounts = transport.getAccounts();
    assert.deepEqual(accounts.map((account) => account.address), [ADDRESS]);
    assert.equal(accounts[0]?.pubkey.length, 33);
  });

  it("sends Direct docs as base64 and returns bytes and bigints", async () => {
    const wc = fakeWalletConnect();
    const transport = new WalletConnectTransport({ loadSignClient: wc.load });
    await transport.connect({ chains: [HUB], walletConnectProjectId: "p", storage: null });
    const result = await transport.signDirect(HUB, ADDRESS, {
      bodyBytes: new Uint8Array([1, 2, 3]),
      authInfoBytes: new Uint8Array([4]),
      chainId: HUB,
      accountNumber: 9,
    });
    const sent = wc.requests.find((request) => request.method === "cosmos_signDirect")!;
    assert.deepEqual((sent.params as { signDoc: unknown }).signDoc, { chainId: HUB, accountNumber: "9", authInfoBytes: "BA==", bodyBytes: "AQID" });
    assert.equal(sent.chainId, `cosmos:${HUB}`);
    assert.deepEqual(result.signed.bodyBytes, new Uint8Array([1, 2, 3]));
    assert.equal(result.signed.accountNumber, 9n);
    await assert.rejects(transport.signArbitrary(HUB, ADDRESS, "hi"), isCode("INTERNAL"));
    await assert.rejects(transport.signArbitrary("osmosis-1", ADDRESS, "hi"), isCode("NOT_CONNECTED"));
  });

  it("maps a rejected proposal and explains missing setup", async () => {
    const rejected = fakeWalletConnect(Object.assign(new Error("User rejected."), { code: 5000 }));
    await assert.rejects(
      new WalletConnectTransport({ loadSignClient: rejected.load }).connect({ chains: [HUB], walletConnectProjectId: "p", storage: null }),
      isCode("USER_REJECTED"),
    );
    await assert.rejects(new WalletConnectTransport().connect({ chains: [HUB], walletConnectProjectId: "p" }), /loadWalletConnect/);
    await assert.rejects(new WalletConnectTransport({ loadSignClient: rejected.load }).connect({ chains: [HUB] }), isCode("INVALID_PARAMS"));
  });

  it("follows wallet events and restores from storage", async () => {
    const wc = fakeWalletConnect();
    const storage = new MemoryStorage();
    const transport = new WalletConnectTransport({ loadSignClient: wc.load });
    const log: string[] = [];
    transport.on("disconnect", (reason) => log.push(reason));
    await transport.connect({ chains: [HUB], walletConnectProjectId: "p", storage });

    wc.setPubkeyFill(3);
    wc.emit("session_event", { topic: "topic-1", params: { event: { name: "accountsChanged" } } });
    await waitFor(() => transport.getAccounts()[0]?.pubkey[0] === 3, 2_000, "refreshed key");
    wc.emit("session_event", { topic: "other-topic", params: { event: { name: "accountsChanged" } } });

    const restored = new WalletConnectTransport({ loadSignClient: wc.load });
    const before = wc.requests.length;
    assert.equal(await restored.restore({ walletConnectProjectId: "p", storage }), true);
    assert.equal(wc.requests.length, before, "no round trip to the phone");
    assert.equal(restored.getAccounts()[0]?.pubkey[0], 3);

    wc.emit("session_delete", { topic: "topic-1" });
    assert.deepEqual(log, ["deleted"]);
    assert.equal(storage.getItem(STORAGE_KEYS.walletConnectSession), null);

    const expired = fakeWalletConnect();
    expired.sessions.push(session("old", Math.floor(Date.now() / 1000) - 1));
    storage.setItem(STORAGE_KEYS.walletConnectSession, JSON.stringify({ topic: "old", accounts: [], chains: [HUB] }));
    assert.equal(await new WalletConnectTransport({ loadSignClient: expired.load }).restore({ walletConnectProjectId: "p", storage }), false);
  });
});
