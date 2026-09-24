import type { ZuniaStorage } from "@zunialab/sdk-core";

export const STORAGE_KEYS = {
  transport: "zunia.session.transport",
  nativeSession: "zunia.connect.v2.session",
  walletConnectSession: "zunia.walletconnect.session",
} as const;

/** `undefined` means the default, `localStorage` when the page may use it. */
export function resolveStorage(storage: ZuniaStorage | null | undefined): ZuniaStorage | null {
  if (storage !== undefined) return storage;
  try {
    const candidate = (globalThis as { localStorage?: ZuniaStorage }).localStorage;
    return candidate ?? null;
  } catch {
    return null;
  }
}

export function readJson(storage: ZuniaStorage | null, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

export function writeJson(storage: ZuniaStorage | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or privacy mode: the session still works, it just won't survive a reload.
  }
}

export function removeKey(storage: ZuniaStorage | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Same as writeJson.
  }
}
