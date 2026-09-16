import type { ZuniaProvider } from "@zunialab/sdk-core";
import {
  ZUNIA_KEPLR_ALIAS_GLOBAL,
  ZUNIA_PROVIDER_GLOBAL,
} from "@zunialab/sdk-core";

type WalletWindow = Window & {
  zunia?: ZuniaProvider;
  keplr?: ZuniaProvider;
};

function getWalletWindow(): WalletWindow | undefined {
  if (typeof window === "undefined") return undefined;
  return window as WalletWindow;
}

/** Synchronous read of window.zunia (and optional keplr alias). */
export function getZuniaSync(options?: {
  preferAlias?: boolean;
}): ZuniaProvider | undefined {
  const w = getWalletWindow();
  if (!w) return undefined;
  if (options?.preferAlias) {
    return w[ZUNIA_KEPLR_ALIAS_GLOBAL] ?? w[ZUNIA_PROVIDER_GLOBAL];
  }
  return w[ZUNIA_PROVIDER_GLOBAL] ?? w[ZUNIA_KEPLR_ALIAS_GLOBAL];
}

export interface GetZuniaOptions {
  /** Max wait for the extension to inject the provider */
  timeoutMs?: number;
  /** Poll interval while waiting */
  pollMs?: number;
  /** Prefer window.keplr alias (legacy Cosmos dApps) */
  preferAlias?: boolean;
}

/**
 * Resolves window.zunia when the extension has injected it.
 * Returns undefined if not installed / timed out.
 */
export async function getZunia(
  options: GetZuniaOptions = {},
): Promise<ZuniaProvider | undefined> {
  const { timeoutMs = 3_000, pollMs = 100, preferAlias } = options;
  const existing = getZuniaSync({ preferAlias });
  if (existing) return existing;

  if (typeof window === "undefined") return undefined;

  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const provider = getZuniaSync({ preferAlias });
      if (provider) {
        clearInterval(timer);
        resolve(provider);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(undefined);
      }
    }, pollMs);
  });
}

export async function enableZunia(
  chainIds: string | string[],
  options?: GetZuniaOptions,
): Promise<ZuniaProvider> {
  const zunia = await getZunia(options);
  if (!zunia) {
    throw new Error(
      "Zunia wallet not found. Install the browser extension from https://zunialab.com",
    );
  }
  await zunia.enable(chainIds);
  return zunia;
}

export function isZuniaInstalled(): boolean {
  return Boolean(getZuniaSync());
}
