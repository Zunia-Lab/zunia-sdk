/**
 * The Zunia extension's signing gaps (0.1.0 to 0.1.4) and the locked-wallet
 * return visit, as a dApp meets them through the session: first with the
 * session alone, then with real CosmJS 0.39 against stand-ins for 0.1.4 and
 * 0.1.5 that sign for real.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeSignDoc as makeAminoSignDoc, serializeSignDoc } from "@cosmjs/amino";
import { Registry, isOfflineDirectSigner, makeSignBytes, makeSignDoc, type EncodeObject, type OfflineSigner } from "@cosmjs/proto-signing";
import { AminoTypes, SigningStargateClient, createDefaultAminoConverters, defaultRegistryTypes } from "@cosmjs/stargate";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import {
  ZUNIA_SIGNING_FEATURES,
  ZuniaConnectError,
  explainZuniaError,
  utf8ToBytes,
  type SignDoc,
  type StdSignDoc,
  type ZuniaProvider,
} from "@zunialab/sdk-core";
import type { Coin } from "cosmjs-types/cosmos/base/v1beta1/coin";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import type { Any } from "cosmjs-types/google/protobuf/any";
import { TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { getZuniaSync } from "./detect.js";
import { FakeProvider } from "./fake-provider.js";
import { ZuniaSessionImpl } from "./session.js";
import { STORAGE_KEYS } from "./storage.js";
import { MemoryStorage } from "./test-support.js";

const HUB = "cosmoshub-4";
const CONTRACT = "cosmos14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s4hmalr";
const isCode = (code: string, reason?: string) => (error: unknown) =>
  error instanceof ZuniaConnectError && error.code === code && (reason === undefined || error.reason === reason);

async function restoredLocked() {
  const provider = new FakeProvider();
  provider.granted = [HUB];
  provider.locked = true;
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEYS.transport, JSON.stringify({ kind: "extension" }));
  const session = new ZuniaSessionImpl({ extension: { provider } });
  assert.equal(await session.restore({ storage }), true);
  assert.equal(session.status, "locked");
  assert.equal(provider.keyReads, 0, "no key read on load, so no unlock window");
  return { provider, session, storage };
}

function doc(address: string, memo: string): StdSignDoc {
  return {
    chain_id: HUB,
    account_number: "7",
    sequence: "3",
    fee: { amount: [{ denom: "uatom", amount: "5000" }], gas: "200000" },
    msgs: [{ type: "cosmos-sdk/MsgSend", value: { from_address: address, to_address: address, amount: [{ denom: "uatom", amount: "1" }] } }],
    memo,
  };
}

describe("a return visit with Zunia locked", () => {
  it("unlock() opens only the unlock, keeps the grant, and reads the accounts", async () => {
    const { provider, session } = await restoredLocked();
    assert.equal(session.accounts.length, 0);
    await session.unlock();
    assert.equal(session.status, "connected");
    assert.equal(session.accounts[0]?.address, provider.address);
    assert.deepEqual(provider.disabled, [], "the grant was kept");
  });

  it("CosmJS's first getAccounts unlocks instead of failing with no account", async () => {
    const { provider, session } = await restoredLocked();
    const accounts = await session.getOfflineSigner(HUB).getAccounts();
    assert.equal(accounts[0]?.address, provider.address);
    assert.equal(session.status, "connected");
  });

  it("connect() over a locked session does not revoke the site's grant first", async () => {
    const { provider, session, storage } = await restoredLocked();
    await session.connect({ chains: [HUB], storage });
    assert.deepEqual(provider.disabled, [], "no disable(): the approval does not show again");
    assert.equal(session.status, "connected");
  });

  it("switching from the extension to another transport still revokes", async () => {
    const { provider, session, storage } = await restoredLocked();
    // QR pairing without a relay fails after the switch; the extension session is gone either way.
    await assert.rejects(session.connect({ chains: [HUB], storage, prefer: "native-ws" }), isCode("INVALID_PARAMS"));
    assert.deepEqual(provider.disabled, [[HUB]]);
  });

  it("disconnect() still revokes", async () => {
    const { provider, session } = await restoredLocked();
    await session.disconnect();
    assert.deepEqual(provider.disabled, [[HUB]]);
  });

  it("closing the unlock window leaves the session locked, with LOCKED", async () => {
    const { provider, session } = await restoredLocked();
    provider.enableError = { message: "The Zunia window was closed before unlocking", code: "LOCKED" };
    await assert.rejects(session.unlock(), isCode("LOCKED"));
    assert.equal(session.status, "locked");
    assert.deepEqual(provider.disabled, []);
  });
});

describe("Amino signatures the chain would refuse", () => {
  it("are refused before broadcast when the wallet skipped the &<> escaping", async () => {
    const provider = new FakeProvider();
    provider.aminoSigning = "unescaped";
    const session = new ZuniaSessionImpl({ extension: { provider } });
    await session.connect({ chains: [HUB], storage: null });
    await assert.rejects(session.signAmino(HUB, provider.address, doc(provider.address, "rent & food")), isCode("UNSUPPORTED", "amino-escaping"));
    // Nothing to escape: same bytes, the signature is good.
    const plain = await session.signAmino(HUB, provider.address, doc(provider.address, "rent and food"));
    assert.equal(plain.signed.memo, "rent and food");
  });

  it("pass when the wallet escapes like the chain (Keplr, Zunia Mobile, Zunia 0.1.5)", async () => {
    const provider = new FakeProvider();
    provider.aminoSigning = "escaped";
    const session = new ZuniaSessionImpl({ extension: { provider } });
    await session.connect({ chains: [HUB], storage: null });
    const signed = await session.signAmino(HUB, provider.address, doc(provider.address, "rent & food"));
    assert.equal(signed.signed.memo, "rent & food");
  });
});

describe("getOfflineSignerFor", () => {
  const execute = { typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract", value: { sender: "x", contract: CONTRACT, msg: utf8ToBytes('{"recover":{}}'), funds: [] } };
  const send = { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: {} };

  it("hands CosmJS an Amino-only signer for a contract call on Zunia 0.1.4 and older, the full signer otherwise", async () => {
    const provider = new FakeProvider();
    provider.version = "0.1.0";
    const session = new ZuniaSessionImpl({ extension: { provider } });
    await session.connect({ chains: [HUB], storage: null });
    assert.equal(session.capabilities?.directContractCalls, false);
    assert.equal("signDirect" in session.getOfflineSignerFor(HUB, { messages: [execute] }), false);
    assert.equal("signDirect" in session.getOfflineSignerFor(HUB, { messages: [execute], memo: "a & b" }), true);
    assert.equal("signDirect" in session.getOfflineSignerFor(HUB, { messages: [send] }), true);

    provider.extensionVersion = "0.1.5";
    assert.equal(session.capabilities?.directContractCalls, true);
    assert.equal("signDirect" in session.getOfflineSignerFor(HUB, { messages: [execute] }), true);
  });
});

describe("getZuniaSync({ preferAlias })", () => {
  it("does not take another wallet's window.keplr for Zunia", () => {
    const g = globalThis as { window?: unknown };
    const saved = g.window;
    try {
      const keplr = { version: "0.12.0", mode: "extension" } as unknown as ZuniaProvider;
      g.window = { keplr };
      assert.equal(getZuniaSync({ preferAlias: true }), undefined);
      const alias = { ...keplr, isZunia: true } as ZuniaProvider;
      g.window = { keplr: alias };
      assert.equal(getZuniaSync({ preferAlias: true }), alias);
      const zunia = { version: "0.1.0", mode: "extension" } as unknown as ZuniaProvider;
      g.window = { zunia, keplr };
      assert.equal(getZuniaSync({ preferAlias: true }), zunia);
    } finally {
      if (saved === undefined) delete g.window;
      else g.window = saved;
    }
  });
});

const addressLength = (address: string): number => bech32.decodeToBytes(address).bytes.length;

/** What zunia-core 0.1.0 decodes in Direct: every local address 20 bytes long. 32-byte contracts and recipients are "unknown". */
function refusedBy014(message: Any): boolean {
  if (message.typeUrl === "/cosmwasm.wasm.v1.MsgExecuteContract") return addressLength(MsgExecuteContract.decode(message.value).contract) !== 20;
  if (message.typeUrl === "/cosmos.bank.v1beta1.MsgSend") return addressLength(MsgSend.decode(message.value).toAddress) !== 20;
  return false;
}

/**
 * Zunia as CosmJS meets it, signing for real over what it is handed:
 * - 0.1.4 reports nothing, refuses in Direct what its decoder cannot read
 *   (`UNSUPPORTED` blind signing), and signs Amino without the chain's escaping;
 * - 0.1.5 reports its version and features, and signs both modes the chain's way.
 */
class ZuniaBuild extends FakeProvider {
  /** The mode of each signature asked for, in order. */
  readonly modes: Array<"direct" | "amino"> = [];

  constructor(readonly build: "0.1.4" | "0.1.5") {
    super();
    this.version = "0.1.0";
    this.aminoSigning = build === "0.1.5" ? "escaped" : "unescaped";
    if (build === "0.1.5") {
      this.extensionVersion = "0.1.5";
      this.features = Object.freeze(Object.values(ZUNIA_SIGNING_FEATURES));
    }
  }

  override async signAmino(chainId: string, signer: string, signDoc: StdSignDoc): Promise<unknown> {
    this.modes.push("amino");
    return super.signAmino(chainId, signer, signDoc);
  }

  override async signDirect(_chainId: string, _signer: string, signDoc: unknown): Promise<unknown> {
    this.modes.push("direct");
    const doc = signDoc as SignDoc;
    if (this.build === "0.1.4" && TxBody.decode(doc.bodyBytes).messages.some(refusedBy014)) {
      throw Object.assign(new Error("Blind signing disabled for unknown messages"), { code: "UNSUPPORTED" });
    }
    return { signed: doc, signature: this.signatureFor(sha256(makeSignBytes(doc))) };
  }
}

describe("CosmJS 0.39 through the session, against Zunia 0.1.4 and 0.1.5", () => {
  // A 32-byte address: what a wasmd contract, an interchain account or a DAO treasury has.
  const ADDRESS_32 = "cosmos1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3s4mk53k";
  const fee = { amount: [{ denom: "uatom", amount: "5000" }], gas: "200000" };
  const signerData = { accountNumber: 7n, sequence: 3, chainId: HUB };
  /** `@cosmjs/cosmwasm-stargate`'s converter: the contract body travels as JSON. */
  const wasmAmino = {
    "/cosmwasm.wasm.v1.MsgExecuteContract": {
      aminoType: "wasm/MsgExecuteContract",
      toAmino: ({ sender, contract, msg, funds }: MsgExecuteContract) => ({ sender, contract, msg: JSON.parse(new TextDecoder().decode(msg)), funds }),
      fromAmino: ({ sender, contract, msg, funds }: { sender: string; contract: string; msg: unknown; funds: Coin[] }) =>
        MsgExecuteContract.fromPartial({ sender, contract, msg: utf8ToBytes(JSON.stringify(msg)), funds }),
    },
  };
  const registry = new Registry([...defaultRegistryTypes, ["/cosmwasm.wasm.v1.MsgExecuteContract", MsgExecuteContract]]);
  const aminoTypes = new AminoTypes({ ...createDefaultAminoConverters(), ...wasmAmino });

  const execute = (sender: string, body: string): EncodeObject => ({
    typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
    value: MsgExecuteContract.fromPartial({ sender, contract: ADDRESS_32, msg: utf8ToBytes(body), funds: [] }),
  });
  const send = (from: string, to: string): EncodeObject => ({
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: { fromAddress: from, toAddress: to, amount: [{ denom: "uatom", amount: "1" }] },
  });

  async function connected(build: "0.1.4" | "0.1.5") {
    const provider = new ZuniaBuild(build);
    const session = new ZuniaSessionImpl({ extension: { provider } });
    await session.connect({ chains: [HUB], storage: null });
    return { provider, session };
  }

  /**
   * Signs as a dApp would, then checks the signature against the bytes the
   * chain rebuilds from the transaction (CosmJS's own, not the session's).
   * Returns the mode the wallet was asked to sign in.
   */
  async function signVerified(provider: ZuniaBuild, signer: OfflineSigner, messages: EncodeObject[], memo: string) {
    const client = await SigningStargateClient.offline(signer, { registry, aminoTypes });
    const txRaw = await client.sign(provider.address, messages, fee, memo, signerData);
    const mode = provider.modes.at(-1);
    const bytes =
      mode === "amino"
        ? serializeSignDoc(makeAminoSignDoc(messages.map((message) => aminoTypes.toAmino(message)), fee, HUB, memo, 7, 3))
        : makeSignBytes(makeSignDoc(txRaw.bodyBytes, txRaw.authInfoBytes, HUB, 7));
    const signature = txRaw.signatures[0];
    assert.ok(signature);
    assert.equal(secp256k1.verify(signature, sha256(bytes), provider.pubKey, { prehash: false }), true, `${mode} signature verifies`);
    return mode;
  }

  it("V1: getOfflineSignerFor signs a contract call Amino on 0.1.4 and Direct on 0.1.5, both valid", async () => {
    const old = await connected("0.1.4");
    const oldSigner = old.session.getOfflineSignerFor(HUB, { messages: [execute(old.provider.address, '{"recover":{}}')], memo: "Recover" });
    assert.equal(isOfflineDirectSigner(oldSigner), false);
    assert.equal(await signVerified(old.provider, oldSigner, [execute(old.provider.address, '{"recover":{}}')], "Recover"), "amino");

    const fixed = await connected("0.1.5");
    const fixedSigner = fixed.session.getOfflineSignerFor(HUB, { messages: [execute(fixed.provider.address, '{"recover":{}}')], memo: "Recover" });
    assert.equal(isOfflineDirectSigner(fixedSigner), true);
    assert.equal(await signVerified(fixed.provider, fixedSigner, [execute(fixed.provider.address, '{"recover":{}}')], "Recover"), "direct");
  });

  it("V2: the plain signer meets 0.1.4's blind-signing refusal, explained; 0.1.5 signs it", async () => {
    const old = await connected("0.1.4");
    const client = await SigningStargateClient.offline(old.session.getOfflineSigner(HUB), { registry });
    const error = await client
      .sign(old.provider.address, [execute(old.provider.address, "{}")], fee, "", signerData)
      .catch((failure: unknown) => failure);
    assert.ok(error instanceof ZuniaConnectError && error.code === "UNSUPPORTED" && error.reason === "blind-signing", String(error));
    assert.match(explainZuniaError(error).message, /Update Zunia/);

    const fixed = await connected("0.1.5");
    assert.equal(await signVerified(fixed.provider, fixed.session.getOfflineSigner(HUB), [execute(fixed.provider.address, "{}")], ""), "direct");
  });

  it("V3: Amino over & is stopped before broadcast on 0.1.4, and valid on 0.1.5", async () => {
    const old = await connected("0.1.4");
    const client = await SigningStargateClient.offline(old.session.getOfflineSignerOnlyAmino(HUB), { aminoTypes });
    const error = await client
      .sign(old.provider.address, [send(old.provider.address, old.provider.address)], fee, "rent & food", signerData)
      .catch((failure: unknown) => failure);
    assert.ok(error instanceof ZuniaConnectError && error.code === "UNSUPPORTED" && error.reason === "amino-escaping", String(error));

    const fixed = await connected("0.1.5");
    const signer = fixed.session.getOfflineSignerOnlyAmino(HUB);
    assert.equal(await signVerified(fixed.provider, signer, [send(fixed.provider.address, fixed.provider.address)], "rent & food <3>"), "amino");
  });

  it("V4: after a locked restore, CosmJS's first sign unlocks, keeps the grant, and signs", async () => {
    const provider = new ZuniaBuild("0.1.4");
    provider.granted = [HUB];
    provider.locked = true;
    const session = new ZuniaSessionImpl({ extension: { provider } });
    assert.equal(await session.restore({ storage: new MemoryStorage() }), true);
    assert.equal(session.status, "locked");
    assert.equal(await signVerified(provider, session.getOfflineSigner(HUB), [send(provider.address, provider.address)], ""), "direct");
    assert.equal(session.status, "connected");
    assert.deepEqual(provider.disabled, []);
  });

  it("V5: connect() over a locked session keeps the grant, and the next contract call signs", async () => {
    const provider = new ZuniaBuild("0.1.4");
    provider.granted = [HUB];
    provider.locked = true;
    const storage = new MemoryStorage();
    const session = new ZuniaSessionImpl({ extension: { provider } });
    await session.restore({ storage });
    await session.connect({ chains: [HUB], storage });
    assert.deepEqual(provider.disabled, []);
    const messages = [execute(provider.address, '{"recover":{}}')];
    assert.equal(await signVerified(provider, session.getOfflineSignerFor(HUB, { messages }), messages, ""), "amino");
  });

  it("V6: a send to a 32-byte address signs Amino on 0.1.4 (Direct with & in the memo) and Direct on 0.1.5", async () => {
    const old = await connected("0.1.4");
    const toContract = [send(old.provider.address, ADDRESS_32)];
    const signer = old.session.getOfflineSignerFor(HUB, { messages: toContract, memo: "Pay the treasury" });
    assert.equal(isOfflineDirectSigner(signer), false);
    assert.equal(await signVerified(old.provider, signer, toContract, "Pay the treasury"), "amino");
    // With & in the memo, Amino would be refused by the chain: Direct, refused in words instead.
    const escaped = old.session.getOfflineSignerFor(HUB, { messages: toContract, memo: "rent & food" });
    const client = await SigningStargateClient.offline(escaped, { registry });
    const error = await client.sign(old.provider.address, toContract, fee, "rent & food", signerData).catch((failure: unknown) => failure);
    assert.ok(error instanceof ZuniaConnectError && error.reason === "blind-signing", String(error));

    const fixed = await connected("0.1.5");
    const fixedMessages = [send(fixed.provider.address, ADDRESS_32)];
    const fixedSigner = fixed.session.getOfflineSignerFor(HUB, { messages: fixedMessages, memo: "rent & food" });
    assert.equal(await signVerified(fixed.provider, fixedSigner, fixedMessages, "rent & food"), "direct");
  });
});
