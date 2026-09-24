import { useCallback, useEffect, useState } from "react";
import type { ZuniaSessionEvents } from "@zunialab/sdk-core";
import type { UseZuniaSessionResult } from "@zunialab/sdk-react";

export interface LogEntry {
  id: number;
  time: string;
  kind: string;
  detail: string;
}

export interface EventLogApi {
  entries: LogEntry[];
  add: (kind: string, detail: string) => void;
  clear: () => void;
}

let nextId = 0;

export function describeError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && "message" in error) return `${String(error.code)}: ${String(error.message)}`;
  return error instanceof Error ? error.message : String(error);
}

/** Every event the session emits, newest first. */
export function useEventLog(session: UseZuniaSessionResult["session"]): EventLogApi {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const add = useCallback((kind: string, detail: string) => {
    const entry = { id: ++nextId, time: new Date().toLocaleTimeString(), kind, detail };
    setEntries((list) => [entry, ...list].slice(0, 100));
  }, []);
  const clear = useCallback(() => setEntries([]), []);

  useEffect(() => {
    const onStatus: ZuniaSessionEvents["status"] = (status) => add("status", status);
    const onAccounts: ZuniaSessionEvents["accountsChanged"] = (accounts) =>
      add("accountsChanged", accounts.map((account) => `${account.chainId} ${account.address}`).join(", ") || "no accounts");
    const onChains: ZuniaSessionEvents["chainChanged"] = (chains) => add("chainChanged", chains.join(", ") || "no chains");
    const onPairing: ZuniaSessionEvents["pairing"] = (pairing) => add("pairing", `${pairing.transport} link ready to scan`);
    const onVerification: ZuniaSessionEvents["verification"] = (code) => add("verification", `the phone must show ${code}`);
    const onDisconnect: ZuniaSessionEvents["disconnect"] = (reason) => add("disconnect", reason);
    const onError: ZuniaSessionEvents["error"] = (error) => add("error", describeError(error));

    session.on("status", onStatus);
    session.on("accountsChanged", onAccounts);
    session.on("chainChanged", onChains);
    session.on("pairing", onPairing);
    session.on("verification", onVerification);
    session.on("disconnect", onDisconnect);
    session.on("error", onError);
    return () => {
      session.off("status", onStatus);
      session.off("accountsChanged", onAccounts);
      session.off("chainChanged", onChains);
      session.off("pairing", onPairing);
      session.off("verification", onVerification);
      session.off("disconnect", onDisconnect);
      session.off("error", onError);
    };
  }, [session, add]);

  return { entries, add, clear };
}
