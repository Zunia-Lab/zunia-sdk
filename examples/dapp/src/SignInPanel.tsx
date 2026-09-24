import { useState } from "react";
import type { UseZuniaSessionResult } from "@zunialab/sdk-react";
import { CHAIN } from "./config";
import { describeError, type EventLogApi } from "./useEventLog";

interface Verified {
  address: string;
  chainId: string;
  issuedAt: string;
  expirationTime?: string;
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
  if (!response.ok) throw Object.assign(new Error(data.message ?? response.statusText), { code: data.code ?? response.status });
  return data as T;
}

/**
 * Sign-in only: the server issues a nonce, the wallet signs a message bound to
 * this site, and the server checks it. No transaction, no fee.
 */
export function SignInPanel({ zunia, log }: { zunia: UseZuniaSessionResult; log: EventLogApi }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [verified, setVerified] = useState<Verified>();
  const [error, setError] = useState<string>();

  async function signIn() {
    setBusy(true);
    setError(undefined);
    setVerified(undefined);
    try {
      const { nonce } = await postJson<{ nonce: string }>("/api/nonce");
      const result = await zunia.signIn({ nonce, chainId: CHAIN.chainId, statement: "Sign in to the Zunia example dApp." });
      setMessage(result.message);
      const proof = await postJson<Verified>("/api/verify", { nonce, message: result.message, signature: result.signature });
      setVerified(proof);
      log.add("signed in", `${proof.address}, verified by the server`);
    } catch (failure) {
      setError(describeError(failure));
      log.add("sign-in failed", describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Sign in</h2>
      <p className="muted">The wallet shows the site, the account and the expiry before it signs.</p>
      <button type="button" disabled={!zunia.connected || busy} onClick={() => void signIn()} data-testid="sign-in">
        {busy ? "Waiting for the wallet..." : "Sign in with Zunia"}
      </button>
      {verified && (
        <p className="success" data-testid="sign-in-result">
          Signed in as <code>{verified.address}</code> on {verified.chainId}
          {verified.expirationTime ? `, valid until ${new Date(verified.expirationTime).toLocaleTimeString()}` : ""}.
        </p>
      )}
      {error && (
        <p className="error" data-testid="sign-in-error">
          {error}
        </p>
      )}
      {message && (
        <details>
          <summary>Signed message</summary>
          <pre>{message}</pre>
        </details>
      )}
    </section>
  );
}
