import { useEffect, useState, type FormEvent } from "react";
import type { UseZuniaSessionResult } from "@zunialab/sdk-react";
import { CHAIN } from "./config";
import { describeError, type EventLogApi } from "./useEventLog";

// CosmJS is most of the bundle, so it loads when first needed.
const loadCosmJs = () => import("@cosmjs/stargate");

/**
 * A plain CosmJS bank send. `getOfflineSignerFor` hands CosmJS the signer for
 * these messages: Amino-only where the connected wallet can only sign them that
 * way (a send to a 32-byte address on Zunia 0.1.4 or older), the full signer
 * everywhere else.
 */
export function SendPanel({ zunia, log }: { zunia: UseZuniaSessionResult; log: EventLogApi }) {
  const account = zunia.accounts.find((candidate) => candidate.chainId === CHAIN.chainId);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1000");
  const [memo, setMemo] = useState("");
  const [balance, setBalance] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ hash: string; height: number }>();
  const [error, setError] = useState<string>();

  const address = account?.address;
  useEffect(() => {
    setBalance(undefined);
    if (!address) return;
    let live = true;
    void (async () => {
      try {
        const { StargateClient } = await loadCosmJs();
        const client = await StargateClient.connect(CHAIN.rpc);
        const coin = await client.getBalance(address, CHAIN.denom);
        client.disconnect();
        if (live) setBalance(`${coin.amount} ${coin.denom}`);
      } catch {
        if (live) setBalance("unavailable");
      }
    })();
    return () => {
      live = false;
    };
  }, [address, sent]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!address) return;
    setBusy(true);
    setError(undefined);
    try {
      const { GasPrice, SigningStargateClient, assertIsDeliverTxSuccess } = await loadCosmJs();
      const message = {
        typeUrl: "/cosmos.bank.v1beta1.MsgSend",
        value: { fromAddress: address, toAddress: recipient.trim(), amount: [{ denom: CHAIN.denom, amount: amount.trim() }] },
      };
      const signer = zunia.session.getOfflineSignerFor(CHAIN.chainId, { messages: [message], memo });
      const client = await SigningStargateClient.connectWithSigner(CHAIN.rpc, signer, { gasPrice: GasPrice.fromString(CHAIN.gasPrice) });
      // A new address is not an error. CosmJS refuses to sign until the chain
      // has an account; the first transaction uses account 0, sequence 0.
      const readAccount = client.getAccount.bind(client);
      client.getSequence = async (accountAddress: string) => {
        const account = await readAccount(accountAddress);
        if (!account) return { accountNumber: 0n, sequence: 0 };
        return { accountNumber: account.accountNumber, sequence: account.sequence };
      };
      const result = await client.signAndBroadcast(address, [message], "auto", memo);
      client.disconnect();
      assertIsDeliverTxSuccess(result);
      setSent({ hash: result.transactionHash, height: result.height });
      log.add("sent", `${amount} ${CHAIN.denom} to ${recipient.trim()}, block ${result.height}`);
    } catch (failure) {
      const message = describeError(failure);
      const empty =
        /does not exist|insufficient funds/i.test(message)
          ? `This address has no ${CHAIN.denom} on ${CHAIN.chainId} yet. Get testnet tokens from the Osmosis faucet, then send again.`
          : message;
      setError(empty);
      log.add("send failed", empty);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Send tokens</h2>
      <p className="muted">
        Balance <span data-testid="balance">{address ? (balance ?? "loading...") : "connect first"}</span>
      </p>
      <form onSubmit={(event) => void send(event)}>
        <label>
          Recipient
          <input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="osmo1..." required data-testid="send-recipient" />
        </label>
        <label>
          Amount ({CHAIN.denom})
          <input value={amount} onChange={(event) => setAmount(event.target.value.replace(/\D/g, ""))} inputMode="numeric" pattern="[0-9]+" required data-testid="send-amount" />
        </label>
        <label>
          Memo
          <input value={memo} onChange={(event) => setMemo(event.target.value)} maxLength={256} />
        </label>
        <button type="submit" disabled={!zunia.connected || busy} data-testid="send">
          {busy ? "Waiting for the wallet..." : "Send"}
        </button>
      </form>
      {sent && (
        <p className="success" data-testid="send-result">
          Included in block {sent.height}: <code>{sent.hash}</code>
        </p>
      )}
      {error && (
        <p className="error" data-testid="send-error">
          {error}
        </p>
      )}
    </section>
  );
}
