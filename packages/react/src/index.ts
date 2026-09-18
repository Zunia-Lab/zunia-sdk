"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConnectOptions,
  CreateConnectSessionResponse,
  ZuniaSession,
  ZuniaSessionAccount,
  ZuniaSessionStatus,
  ZuniaTransportKind,
} from "@zunialab/sdk-core";
import {
  connectWithZunia,
  getZunia,
  type GetZuniaOptions,
} from "@zunialab/sdk-web";
import type { ZuniaProvider } from "@zunialab/sdk-core";

export interface UseZuniaResult {
  zunia: ZuniaProvider | undefined;
  loading: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
}

/** Detects the Zunia extension provider. Session / signing UI is app-owned. */
export function useZunia(options?: GetZuniaOptions): UseZuniaResult {
  const [zunia, setZunia] = useState<ZuniaProvider | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const provider = await getZunia(options);
      setZunia(provider);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setZunia(undefined);
    } finally {
      setLoading(false);
    }
  }, [options?.timeoutMs, options?.pollMs, options?.preferAlias]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { zunia, loading, error, refresh };
}

export interface UseZuniaSessionResult {
  session: ZuniaSession | null;
  status: ZuniaSessionStatus;
  accounts: ZuniaSessionAccount[];
  chains: string[];
  transport: ZuniaTransportKind | null;
  pairing: CreateConnectSessionResponse | undefined;
  error: Error | undefined;
  connecting: boolean;
  connect: (options: ConnectOptions) => Promise<ZuniaSession>;
  disconnect: () => Promise<void>;
}

export function useZuniaSession(): UseZuniaSessionResult {
  const sessionRef = useRef<ZuniaSession | null>(null);
  const [session, setSession] = useState<ZuniaSession | null>(null);
  const [status, setStatus] = useState<ZuniaSessionStatus>("idle");
  const [accounts, setAccounts] = useState<ZuniaSessionAccount[]>([]);
  const [chains, setChains] = useState<string[]>([]);
  const [transport, setTransport] = useState<ZuniaTransportKind | null>(null);
  const [pairing, setPairing] = useState<CreateConnectSessionResponse>();
  const [error, setError] = useState<Error | undefined>();
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(async (options: ConnectOptions) => {
    setConnecting(true);
    setError(undefined);
    setStatus("connecting");
    try {
      const next = await connectWithZunia(options);
      sessionRef.current = next;
      setSession(next);
      setTransport(next.transport);
      setAccounts(next.accounts);
      setChains(next.chains);
      setPairing(next.pairing);
      setStatus(next.status);
      next.on("status", setStatus);
      next.on("accountsChanged", setAccounts);
      next.on("chainChanged", setChains);
      next.on("pairing", setPairing);
      next.on("error", setError);
      return next;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      setStatus("error");
      throw err;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await sessionRef.current?.disconnect();
    sessionRef.current = null;
    setSession(null);
    setAccounts([]);
    setChains([]);
    setPairing(undefined);
    setTransport(null);
    setStatus("disconnected");
  }, []);

  return {
    session,
    status,
    accounts,
    chains,
    transport,
    pairing,
    error,
    connecting,
    connect,
    disconnect,
  };
}

export { getZunia, enableZunia, isZuniaInstalled, connectWithZunia } from "@zunialab/sdk-web";
export type { ZuniaProvider, ZuniaSession, ConnectOptions } from "@zunialab/sdk-core";
export { ZUNIA_CONNECT_BUTTON, ZUNIA_NATIVE_CONNECT } from "@zunialab/sdk-core";
export { ConnectWithZuniaButton } from "./ConnectWithZuniaButton.js";
export type { ConnectWithZuniaButtonProps } from "./ConnectWithZuniaButton.js";
export { ZuniaMark } from "./ZuniaMark.js";
export { ConnectPairingModal } from "./ConnectPairingModal.js";
