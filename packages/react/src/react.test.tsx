import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZuniaKey, ZuniaProvider } from "@zunialab/sdk-core";
import { ZuniaSessionImpl } from "@zunialab/sdk-web";
import { ConnectPairingModal, pairingDeepLink } from "./ConnectPairingModal.js";
import { useZuniaSession } from "./hooks.js";

const URI = "zunia://connect?v=2&sid=Zf3kQ9xTn2LmP8vR4sWb1A&t=78vWrA8rgZkX-X3b2kFXbZ4xGVuugyrwkOCgVtoTI8M&pk=6DGzxA3X-LUeWXgypFq8GG5l4txV91YLSJSpCTDLHjg&r=wss%3A%2F%2Fapi.zunialab.com";
const ADDRESS = "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu";

function provider(): ZuniaProvider {
  const pubKey = new Uint8Array(33).fill(2);
  return {
    version: "test",
    mode: "extension",
    enable: async () => {},
    getKey: async (): Promise<ZuniaKey> => ({ name: "Main", algo: "secp256k1", pubKey, address: new Uint8Array(20), bech32Address: ADDRESS }),
    getOfflineSigner: () => null,
    on: () => {},
    off: () => {},
  };
}

function Probe({ session }: { session: ZuniaSessionImpl }) {
  const zunia = useZuniaSession({ session, restore: false });
  return (
    <p>
      {zunia.status}|{zunia.connected ? "yes" : "no"}|{zunia.transport}|{zunia.accounts[0]?.address}
    </p>
  );
}

describe("useZuniaSession", () => {
  it("renders the session's state", async () => {
    const session = new ZuniaSessionImpl({ extension: { provider: provider() } });
    assert.equal(renderToStaticMarkup(<Probe session={session} />), "<p>idle|no||</p>");
    await session.connect({ chains: ["cosmoshub-4"], storage: null });
    assert.equal(renderToStaticMarkup(<Probe session={session} />), `<p>connected|yes|extension|${ADDRESS}</p>`);
  });
});

describe("ConnectPairingModal", () => {
  const noop = () => {};

  it("shows a real QR code and a link for phones", () => {
    const html = renderToStaticMarkup(
      <ConnectPairingModal open onOpenChange={noop} status="awaiting_wallet" pairing={{ transport: "native-ws", uri: URI }} />,
    );
    assert.ok(html.includes('aria-label="Pairing QR code"') && html.includes("<path d=\"M"));
    assert.ok(html.includes(`href="${URI.replace(/&/g, "&amp;")}"`));
    assert.ok(html.includes("Scan with the Zunia app"));
  });

  it("switches to the code to compare once the phone has scanned", () => {
    const html = renderToStaticMarkup(
      <ConnectPairingModal open onOpenChange={noop} status="awaiting_wallet" pairing={{ transport: "native-ws", uri: URI }} verificationCode="042917" />,
    );
    assert.ok(html.includes("042 917"));
    assert.ok(!html.includes("<svg"), "the QR code is gone, so nobody else scans it");
    assert.ok(html.includes("Check that your phone shows this code"));
  });

  it("links WalletConnect pairings through the app scheme and renders nothing when closed", () => {
    assert.equal(pairingDeepLink({ transport: "walletconnect", uri: "wc:abc@2?x=1" }), "zunia://wc?uri=wc%3Aabc%402%3Fx%3D1");
    assert.equal(renderToStaticMarkup(<ConnectPairingModal open={false} onOpenChange={noop} status="idle" />), "");
    const failed = renderToStaticMarkup(<ConnectPairingModal open onOpenChange={noop} status="disconnected" error={{ message: "The session expired" }} />);
    assert.ok(failed.includes("The session expired"));
  });
});
