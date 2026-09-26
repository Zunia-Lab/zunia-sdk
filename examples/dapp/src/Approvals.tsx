import { useState } from "react";
import type { SuggestedChain } from "@zunialab/sdk-core";
import type { UseZuniaSessionResult } from "@zunialab/sdk-react";
import { CHAIN } from "./config";
import { describeError, type EventLogApi } from "./useEventLog";

/** A chain id the bundled registry does not know, so the extension has to ask. */
const BENCH_CHAIN: SuggestedChain = {
  chainId: "zunia-bench-1",
  chainName: "Zunia bench",
  rpc: "https://rpc.testnet.osmosis.zone",
  rest: "https://lcd.testnet.osmosis.zone",
  bip44: { coinType: 118 },
  bech32Config: { bech32PrefixAccAddr: "osmo" },
  currencies: [{ coinDenom: "OSMO", coinMinimalDenom: "uosmo", coinDecimals: 6 }],
  feeCurrencies: [
    {
      coinDenom: "OSMO",
      coinMinimalDenom: "uosmo",
      coinDecimals: 6,
      gasPriceStep: { low: 0.0025, average: 0.025, high: 0.04 },
    },
  ],
};

function useAction(log: EventLogApi, label: string) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();

  async function run(work: () => Promise<string>) {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const message = await work();
      setResult(message);
      log.add(label, message);
    } catch (failure) {
      const message = describeError(failure);
      setError(message);
      log.add(`${label} failed`, message);
    } finally {
      setBusy(false);
    }
  }

  return { busy, result, error, run };
}

function accountOnChain(zunia: UseZuniaSessionResult) {
  return zunia.accounts.find((candidate) => candidate.chainId === CHAIN.chainId);
}

function Outcome({ result, error, testId }: { result?: string; error?: string; testId: string }) {
  if (error) return <p className="error" data-testid={`${testId}-error`}>{error}</p>;
  if (result) return <p className="success" data-testid={`${testId}-result`}>{result}</p>;
  return null;
}

/** Free-form message. Opens the message popup, not the sign-in one. */
export function MessagePanel({ zunia, log }: { zunia: UseZuniaSessionResult; log: EventLogApi }) {
  const action = useAction(log, "message signed");
  const account = accountOnChain(zunia);
  const [text, setText] = useState("Hello from the Zunia example dApp.");

  return (
    <section className="card">
      <h2>Sign a message</h2>
      <p className="muted">A free-form signature. It does not sign you in and it is not a transaction.</p>
      <label className="field">
        Message
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} data-testid="message-text" />
      </label>
      <button
        type="button"
        disabled={!account || action.busy || !text.trim()}
        data-testid="sign-message"
        onClick={() =>
          void action.run(async () => {
            const signature = await zunia.session.signArbitrary(CHAIN.chainId, account!.address, text.trim());
            return `Signed. Signature ${signature.signature.slice(0, 16)}...`;
          })
        }
      >
        {action.busy ? "Waiting for the wallet..." : "Sign message"}
      </button>
      <Outcome result={action.result} error={action.error} testId="message" />
    </section>
  );
}

/** Amino signature only. The page does not broadcast it. */
export function AminoPanel({ zunia, log }: { zunia: UseZuniaSessionResult; log: EventLogApi }) {
  const action = useAction(log, "amino signed");
  const account = accountOnChain(zunia);

  return (
    <section className="card">
      <h2>Sign Amino</h2>
      <p className="muted">Signs a send of 1 uosmo back to this account. Nothing is broadcast.</p>
      <button
        type="button"
        disabled={!account || action.busy}
        data-testid="sign-amino"
        onClick={() =>
          void action.run(async () => {
            const address = account!.address;
            const signed = await zunia.session.signAmino(CHAIN.chainId, address, {
              chain_id: CHAIN.chainId,
              account_number: "0",
              sequence: "0",
              fee: { amount: [{ denom: CHAIN.denom, amount: "0" }], gas: "200000" },
              msgs: [
                {
                  type: "cosmos-sdk/MsgSend",
                  value: {
                    from_address: address,
                    to_address: address,
                    amount: [{ denom: CHAIN.denom, amount: "1" }],
                  },
                },
              ],
              memo: "Zunia example dApp, signature only",
            });
            return `Amino signed, memo "${signed.signed.memo}". Not broadcast.`;
          })
        }
      >
        {action.busy ? "Waiting for the wallet..." : "Sign Amino"}
      </button>
      <Outcome result={action.result} error={action.error} testId="amino" />
    </section>
  );
}

/** Opens the add-chain popup when the extension does not already know this id. */
export function SuggestChainPanel({ zunia, log }: { zunia: UseZuniaSessionResult; log: EventLogApi }) {
  const action = useAction(log, "chain suggested");

  return (
    <section className="card">
      <h2>Suggest a chain</h2>
      <p className="muted">
        Asks the extension to add <code>{BENCH_CHAIN.chainId}</code>. If it already knows that id, it does not ask again.
      </p>
      <button
        type="button"
        disabled={!zunia.connected || zunia.transport !== "extension" || action.busy}
        data-testid="suggest-chain"
        onClick={() =>
          void action.run(async () => {
            await zunia.session.suggestChain(BENCH_CHAIN);
            return `${BENCH_CHAIN.chainName} accepted. Endpoints: ${BENCH_CHAIN.rpc}`;
          })
        }
      >
        {action.busy ? "Waiting for the wallet..." : "Suggest chain"}
      </button>
      {zunia.connected && zunia.transport !== "extension" && (
        <p className="muted">Adding a chain is only available through the browser extension.</p>
      )}
      <Outcome result={action.result} error={action.error} testId="suggest" />
    </section>
  );
}
