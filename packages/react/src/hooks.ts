"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SignInOptions, SignInResult, ZuniaProvider } from "@zunialab/sdk-core";
import {
  ZuniaSessionImpl,
  getZunia,
  type GetZuniaOptions,
  type ZuniaSessionOptions,
  type ZuniaSessionSnapshot,
  type ZuniaWebConnectOptions,
  type ZuniaWebRestoreOptions,
} from "@zunialab/sdk-web";

export interface UseZuniaResult {
  zunia: ZuniaProvider | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Detects the extension's `window.zunia`. Most apps want `useZuniaSession` instead. */
export function useZunia(options?: GetZuniaOptions): UseZuniaResult {
  const [zunia, setZunia] = useState<ZuniaProvider | undefined>();
  const [loading, setLoading] = useState(true);
  const timeoutMs = options?.timeoutMs;
  const preferAlias = options?.preferAlias;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setZunia(await getZunia({ timeoutMs, preferAlias }));
    } finally {
      setLoading(false);
    }
  }, [timeoutMs, preferAlias]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { zunia, loading, refresh };
}

export interface UseZuniaSessionOptions extends ZuniaSessionOptions {
  /** A session created elsewhere, e.g. with `createZuniaSession()` at module scope. */
  session?: ZuniaSessionImpl;
  /** Reattach to the previous session on mount, without prompting. Default true. */
  restore?: boolean | ZuniaWebRestoreOptions;
}

export interface UseZuniaSessionResult extends ZuniaSessionSnapshot {
  session: ZuniaSessionImpl;
  /**
   * Connected, possibly locked. After a restore that found the wallet locked the
   * accounts are not known yet: `locked` is true and `accounts` is empty until
   * `unlock()` (or the user unlocking in the wallet).
   */
  connected: boolean;
  /** The extension is connected but locked. Offer `unlock` on a click. */
  locked: boolean;
  /** Waiting for the extension prompt or for a phone to scan. */
  connecting: boolean;
  /** The mount-time restore is still running. */
  restoring: boolean;
  connect: (options: ZuniaWebConnectOptions) => Promise<void>;
  disconnect: () => Promise<void>;
  restore: (options?: ZuniaWebRestoreOptions) => Promise<boolean>;
  /** Asks the wallet to unlock and keeps the site's grant. Opens a window: call it from a click. */
  unlock: () => Promise<void>;
  signIn: (options: SignInOptions) => Promise<SignInResult>;
}

/**
 * A Zunia session as React state. Call it once near the root of the app, or
 * pass one shared `session`, so every component sees the same connection.
 */
export function useZuniaSession(options: UseZuniaSessionOptions = {}): UseZuniaSessionResult {
  const [session] = useState(() => options.session ?? new ZuniaSessionImpl(options));
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const autoRestore = options.restore ?? true;
  const [restoring, setRestoring] = useState(autoRestore !== false);

  useEffect(() => {
    if (autoRestore === false) return;
    let live = true;
    session
      .restore(typeof autoRestore === "object" ? autoRestore : {})
      .catch(() => false)
      .finally(() => {
        if (live) setRestoring(false);
      });
    return () => {
      live = false;
    };
    // Restoring runs once per session; later changes to `restore` are ignored on purpose.
  }, [session]);

  const connect = useCallback((connectOptions: ZuniaWebConnectOptions) => session.connect(connectOptions), [session]);
  const disconnect = useCallback(() => session.disconnect(), [session]);
  const restore = useCallback((restoreOptions?: ZuniaWebRestoreOptions) => session.restore(restoreOptions), [session]);
  const unlock = useCallback(() => session.unlock(), [session]);
  const signIn = useCallback((signInOptions: SignInOptions) => session.signIn(signInOptions), [session]);

  return useMemo(
    () => ({
      ...snapshot,
      session,
      connected: snapshot.status === "connected" || snapshot.status === "locked",
      locked: snapshot.status === "locked",
      connecting: snapshot.status === "connecting" || snapshot.status === "awaiting_wallet",
      restoring,
      connect,
      disconnect,
      restore,
      unlock,
      signIn,
    }),
    [snapshot, session, restoring, connect, disconnect, restore, unlock, signIn],
  );
}
