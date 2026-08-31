"use client";

import { useCallback, useEffect, useState } from "react";
import type { ZuniaProvider } from "@zunialab/sdk-core";
import { getZunia, type GetZuniaOptions } from "@zunialab/sdk-web";

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

export { getZunia, enableZunia, isZuniaInstalled } from "@zunialab/sdk-web";
export type { ZuniaProvider } from "@zunialab/sdk-core";
