import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZuniaConnectError, type ZuniaSessionStatus } from "@zunialab/sdk-core";
import { FakeProvider } from "./fake-provider.js";
import { waitFor } from "./test-support.js";
import { ExtensionTransport } from "./transports/extension.js";

const HUB = "cosmoshub-4";
const OSMO = "osmosis-1";

function setup() {
  const provider = new FakeProvider();
  const transport = new ExtensionTransport({ provider });
  const statuses: ZuniaSessionStatus[] = [];
  const log: string[] = [];
  transport.on("status", (status) => statuses.push(status));
  transport.on("chainChanged", (chains) => log.push(`chains:${chains.join(",")}`));
  transport.on("disconnect", (reason) => log.push(`disconnect:${reason}`));
  return { provider, transport, statuses, log };
}

const isCode = (code: string) => (error: unknown) => error instanceof ZuniaConnectError && error.code === code;

describe("ExtensionTransport", () => {
  it("connects and shares keys as CosmJS accounts", async () => {
    const { provider, transport, statuses } = setup();
    await transport.connect({ chains: [HUB, OSMO] });
    assert.deepEqual(statuses, ["connecting", "connected"]);
    assert.deepEqual(provider.granted, [HUB, OSMO]);
    assert.deepEqual(transport.getChains(), [HUB, OSMO]);
    const [account] = transport.getAccounts();
    assert.equal(account?.address, provider.address);
    assert.deepEqual(account?.pubkey, provider.pubKey);
  });

  it("maps refusals to error codes", async () => {
    const coded = setup();
    coded.provider.enableError = { message: "User rejected the request", code: "USER_REJECTED" };
    await assert.rejects(coded.transport.connect({ chains: [HUB] }), isCode("USER_REJECTED"));
    assert.equal(coded.statuses.at(-1), "disconnected");

    const keplrStyle = setup();
    keplrStyle.provider.enableError = { message: "Request rejected" };
    await assert.rejects(keplrStyle.transport.connect({ chains: [HUB] }), isCode("USER_REJECTED"));

    await assert.rejects(new ExtensionTransport({ detectTimeoutMs: 10 }).connect({ chains: [HUB] }), isCode("NOT_INSTALLED"));
    await assert.rejects(setup().transport.connect({ chains: [] }), isCode("INVALID_PARAMS"));
  });

  it("follows account switches, locking and unlocking", async () => {
    const { provider, transport, statuses } = setup();
    await transport.connect({ chains: [HUB] });
    const before = provider.address;
    provider.switchAccount("2");
    provider.emit("accountsChanged");
    await waitFor(() => transport.getAccounts()[0]?.address === provider.address, 2_000, "new account");
    assert.notEqual(provider.address, before);

    provider.locked = true;
    provider.emit("locked");
    assert.equal(statuses.at(-1), "locked");
    const reads = provider.keyReads;
    provider.emit("accountsChanged");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(provider.keyReads, reads, "no key read, so no unlock window, while locked");

    provider.locked = false;
    provider.emit("accountsChanged");
    await waitFor(() => statuses.at(-1) === "connected", 2_000, "unlocked");
  });

  it("follows chains granted and revoked, then a full revoke", async () => {
    const { provider, transport, statuses, log } = setup();
    await transport.connect({ chains: [HUB] });
    await provider.enable([OSMO]);
    provider.emit("chainChanged", { chainIds: [HUB, OSMO] });
    await waitFor(() => transport.getAccounts().length === 2, 2_000, "second chain");

    provider.granted = [HUB];
    provider.emit("disconnect", { chainIds: [OSMO] });
    provider.emit("chainChanged", { chainIds: [HUB] });
    assert.deepEqual(transport.getChains(), [HUB]);
    assert.equal(log.filter((entry) => entry === `chains:${HUB}`).length, 2, "one event per real change");

    provider.emit("disconnect", null);
    assert.equal(statuses.at(-1), "disconnected");
    assert.ok(log.includes("disconnect:revoked"));
    assert.equal(provider.listenerCount(), 0);
  });

  it("restores without prompting", async () => {
    const provider = new FakeProvider();
    assert.equal(await new ExtensionTransport({ provider }).restore({}), false);

    provider.granted = [HUB];
    const restored = new ExtensionTransport({ provider });
    assert.equal(await restored.restore({ chains: [HUB, OSMO] }), true);
    assert.deepEqual(restored.getChains(), [HUB]);
    assert.equal(restored.getAccounts()[0]?.address, provider.address);

    provider.locked = true;
    const reads = provider.keyReads;
    const statuses: ZuniaSessionStatus[] = [];
    const locked = new ExtensionTransport({ provider });
    locked.on("status", (status) => statuses.push(status));
    assert.equal(await locked.restore({}), true);
    assert.deepEqual(statuses, ["locked"]);
    assert.equal(provider.keyReads, reads);
  });

  it("normalizes results and revokes on disconnect", async () => {
    const { provider, transport, log } = setup();
    await transport.connect({ chains: [HUB] });
    const direct = await transport.signDirect(HUB, provider.address, {
      bodyBytes: new Uint8Array([1]),
      authInfoBytes: new Uint8Array([2]),
      chainId: HUB,
      accountNumber: { toString: () => "42" },
    });
    assert.equal(direct.signed.accountNumber, 42n);
    assert.ok(direct.signed.bodyBytes instanceof Uint8Array);
    const signature = await transport.signArbitrary(HUB, provider.address, "hello");
    assert.equal(signature.pub_key.type, "tendermint/PubKeySecp256k1");

    await transport.disconnect();
    assert.deepEqual(provider.disabled, [[HUB]]);
    assert.ok(log.includes("disconnect:user"));
    await assert.rejects(transport.signArbitrary(HUB, provider.address, "x"), isCode("NOT_CONNECTED"));
  });

  it("asks the extension to add a chain", async () => {
    const { provider, transport } = setup();
    const chain = {
      chainId: "zunia-bench-1",
      chainName: "Zunia bench",
      rpc: "https://rpc.example.org",
      rest: "https://rest.example.org",
      bip44: { coinType: 118 },
      bech32Config: { bech32PrefixAccAddr: "zbench" },
      currencies: [{ coinDenom: "ZBN", coinMinimalDenom: "uzbn", coinDecimals: 6 }],
    };
    await assert.rejects(transport.suggestChain(chain), isCode("NOT_CONNECTED"));
    await transport.connect({ chains: [HUB] });
    await transport.suggestChain(chain);
    assert.deepEqual(provider.suggested, [chain]);
  });
});
