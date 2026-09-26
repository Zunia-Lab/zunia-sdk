import { useEffect, useState } from "react";
import type { ZuniaTransportKind } from "@zunialab/sdk-core";
import { ConnectPairingModal, useZuniaSession } from "@zunialab/sdk-react";
import { AminoPanel, MessagePanel, SuggestChainPanel } from "./Approvals";
import { CHAIN, METADATA, RELAY_API, SESSION_OPTIONS, WALLETCONNECT_PROJECT_ID } from "./config";
import { EventLog } from "./EventLog";
import { SendPanel } from "./SendPanel";
import { SignInPanel } from "./SignInPanel";
import { describeError, useEventLog } from "./useEventLog";

const TRANSPORTS: { kind: ZuniaTransportKind; label: string; hint: string }[] = [
  { kind: "extension", label: "Browser extension", hint: "Zunia installed in this browser" },
  { kind: "native-ws", label: "Phone (QR code)", hint: `Zunia mobile, through the relay at ${RELAY_API}` },
  {
    kind: "walletconnect",
    label: "WalletConnect",
    hint: WALLETCONNECT_PROJECT_ID ? "Any WalletConnect v2 wallet" : "Set VITE_WALLETCONNECT_PROJECT_ID first",
  },
];

export function App() {
  const zunia = useZuniaSession({ restore: SESSION_OPTIONS });
  const log = useEventLog(zunia.session);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [relay, setRelay] = useState<"checking" | "up" | "down">("checking");

  useEffect(() => {
    if (zunia.connected) setPairingOpen(false);
  }, [zunia.connected]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    fetch(RELAY_API, { mode: "no-cors", signal: controller.signal })
      .then(() => setRelay("up"))
      .catch(() => setRelay("down"))
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  async function connect(prefer: ZuniaTransportKind) {
    setPairingOpen(prefer !== "extension");
    try {
      await zunia.connect({ ...SESSION_OPTIONS, prefer, metadata: METADATA, openInstallIfMissing: false });
    } catch {
      // Already shown: the session emits an error event and puts it in its snapshot.
    }
  }

  function onPairingOpenChange(open: boolean) {
    setPairingOpen(open);
    // Closing the dialog while the phone has not answered cancels the pairing.
    if (!open && zunia.connecting) void zunia.disconnect();
  }

  const busy = zunia.connecting || zunia.restoring;

  return (
    <main>
      <header>
        <h1>Zunia example dApp</h1>
        <p>
          Chain <code>{CHAIN.chainId}</code>. Open the event log to watch what the wallet sends back.
        </p>
      </header>

      <section className="card">
        <h2>Connection</h2>
        <p>
          Status{" "}
          <span className={`badge badge-${zunia.status}`} data-testid="status">
            {zunia.restoring ? "restoring" : zunia.status}
          </span>
          {zunia.transport && !zunia.restoring && (
            <>
              {" "}
              over <strong data-testid="transport">{zunia.transport}</strong>
            </>
          )}
        </p>

        {zunia.connected ? (
          <>
            <ul className="accounts">
              {zunia.accounts.map((account) => (
                <li key={`${account.chainId}:${account.address}`}>
                  <code data-testid="address">{account.address}</code>
                  <span className="muted">
                    {account.chainId}
                    {account.name ? `, ${account.name}` : ""}
                  </span>
                </li>
              ))}
            </ul>
            {zunia.status === "locked" && <p className="muted">The wallet is locked. Requests wait until you unlock it.</p>}
            <button type="button" onClick={() => void zunia.disconnect()} data-testid="disconnect">
              Disconnect
            </button>
          </>
        ) : (
          <div className="transports">
            {TRANSPORTS.map(({ kind, label, hint }) => (
              <button
                key={kind}
                type="button"
                disabled={busy || (kind === "walletconnect" && !WALLETCONNECT_PROJECT_ID) || (kind === "native-ws" && relay === "down")}
                onClick={() => void connect(kind)}
                data-testid={`connect-${kind}`}
              >
                <strong>{label}</strong>
                <span>{kind === "native-ws" && relay === "down" ? "The relay is not responding" : hint}</span>
              </button>
            ))}
          </div>
        )}
        {zunia.error && !zunia.connected && (
          <p className="error" data-testid="connect-error">
            {describeError(zunia.error)}
          </p>
        )}
      </section>

      <SignInPanel zunia={zunia} log={log} />
      <MessagePanel zunia={zunia} log={log} />
      <AminoPanel zunia={zunia} log={log} />
      <SendPanel zunia={zunia} log={log} />
      <SuggestChainPanel zunia={zunia} log={log} />
      <EventLog log={log} />

      <ConnectPairingModal
        open={pairingOpen}
        onOpenChange={onPairingOpenChange}
        status={zunia.status}
        pairing={zunia.pairing}
        verificationCode={zunia.verificationCode}
        error={zunia.error}
      />
    </main>
  );
}
