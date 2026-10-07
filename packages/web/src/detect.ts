import type { ZuniaProvider } from "@zunialab/sdk-core";
import {
  ZUNIA_CONNECT_BUTTON,
  ZUNIA_KEPLR_ALIAS_GLOBAL,
  ZUNIA_PROVIDER_GLOBAL,
  ZuniaConnectError,
  toZuniaConnectError,
} from "@zunialab/sdk-core";

type WalletWindow = Window & {
  zunia?: ZuniaProvider;
  keplr?: ZuniaProvider;
};

/** Fired by the extension once `window.zunia` exists. */
export const ZUNIA_INITIALIZED_EVENT = "zunia#initialized";

function getWalletWindow(): WalletWindow | undefined {
  if (typeof window === "undefined") return undefined;
  return window as WalletWindow;
}

/**
 * Synchronous read of `window.zunia`. Zunia always sets `window.zunia`, and
 * `window.keplr` only as an extra alias, so a `window.keplr` without
 * `window.zunia` is another wallet (Keplr, or a wallet imitating it): with
 * `preferAlias` it is used only when it says it is Zunia (`isZunia`).
 */
export function getZuniaSync(options?: { preferAlias?: boolean }): ZuniaProvider | undefined {
  const w = getWalletWindow();
  if (!w) return undefined;
  const own = w[ZUNIA_PROVIDER_GLOBAL];
  if (own) return own;
  const alias = options?.preferAlias ? w[ZUNIA_KEPLR_ALIAS_GLOBAL] : undefined;
  return alias?.isZunia === true ? alias : undefined;
}

export interface GetZuniaOptions {
  /** Longest wait for the extension to inject the provider. Default 3 s. */
  timeoutMs?: number;
  /** Fall back to `window.keplr` when `window.zunia` is missing. */
  preferAlias?: boolean;
}

/**
 * Resolves `window.zunia` once the extension has injected it, or undefined
 * when it does not appear in time. The extension injects at document start,
 * so after the page has loaded only a short grace period is spent waiting.
 */
export async function getZunia(options: GetZuniaOptions = {}): Promise<ZuniaProvider | undefined> {
  const { preferAlias } = options;
  const existing = getZuniaSync({ preferAlias });
  if (existing) return existing;
  const w = getWalletWindow();
  if (!w) return undefined;
  const loaded = typeof document !== "undefined" && document.readyState === "complete";
  const timeoutMs = Math.min(options.timeoutMs ?? 3_000, loaded ? 300 : Number.POSITIVE_INFINITY);

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      clearInterval(poll);
      w.removeEventListener(ZUNIA_INITIALIZED_EVENT, finish);
      resolve(getZuniaSync({ preferAlias }));
    };
    const timer = setTimeout(finish, timeoutMs);
    const poll = setInterval(() => {
      if (getZuniaSync({ preferAlias })) finish();
    }, 50);
    w.addEventListener(ZUNIA_INITIALIZED_EVENT, finish, { once: true });
  });
}

/** Resolves true once the extension is available, false after `timeoutMs`. */
export async function waitForZuniaInitialized(timeoutMs = 3_000): Promise<boolean> {
  return Boolean(await getZunia({ timeoutMs }));
}

export function isZuniaInstalled(): boolean {
  return Boolean(getZuniaSync());
}

/** Asks the extension for access to `chainIds` and returns the provider. */
export async function enableZunia(chainIds: string | string[], options?: GetZuniaOptions): Promise<ZuniaProvider> {
  const zunia = await getZunia(options);
  if (!zunia) {
    throw new ZuniaConnectError(
      "NOT_INSTALLED",
      `The Zunia extension is not installed. Get it at ${ZUNIA_CONNECT_BUTTON.installUrl}`,
    );
  }
  try {
    await zunia.enable(chainIds);
  } catch (error) {
    throw toZuniaConnectError(error);
  }
  return zunia;
}
