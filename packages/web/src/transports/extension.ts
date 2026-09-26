import {
  ZuniaConnectError,
  accountFromKey,
  normalizeAminoResponse,
  normalizeChainIds,
  normalizeDirectResponse,
  normalizeStdSignature,
  toZuniaConnectError,
  type AminoSignResponse,
  type ConnectOptions,
  type DirectSignResponse,
  type RestoreOptions,
  type SignDocInput,
  type StdSignDoc,
  type StdSignature,
  type SuggestedChain,
  type ZuniaAccountInfo,
  type ZuniaProvider,
  type ZuniaSessionEvents,
  type ZuniaSessionStatus,
  type ZuniaTransport,
} from "@zunialab/sdk-core";
import { getZunia } from "../detect.js";
import { EventBus } from "../events.js";

export interface ExtensionTransportOptions {
  /** Provider to use instead of detecting `window.zunia`. */
  provider?: ZuniaProvider;
  /** How long to wait for the extension to inject. Default 3 s. */
  detectTimeoutMs?: number;
}

function chainIdsOf(data: unknown): string[] | null {
  if (!data || typeof data !== "object") return null;
  const ids = (data as { chainIds?: unknown }).chainIds;
  return Array.isArray(ids) ? normalizeChainIds(ids.filter((id): id is string => typeof id === "string")) : null;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The Zunia browser extension through `window.zunia`. Follows the extension's
 * events: account switches, locking, chains granted or revoked.
 */
export class ExtensionTransport implements ZuniaTransport {
  readonly kind = "extension" as const;
  private readonly bus = new EventBus<ZuniaSessionEvents>();
  private provider: ZuniaProvider | null = null;
  private accounts: ZuniaAccountInfo[] = [];
  private chains: string[] = [];
  private status: ZuniaSessionStatus = "idle";
  private detach: (() => void) | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;

  constructor(private readonly options: ExtensionTransportOptions = {}) {}

  on<K extends keyof ZuniaSessionEvents>(event: K, listener: ZuniaSessionEvents[K]): void {
    this.bus.on(event, listener);
  }

  off<K extends keyof ZuniaSessionEvents>(event: K, listener: ZuniaSessionEvents[K]): void {
    this.bus.off(event, listener);
  }

  getAccounts(): ZuniaAccountInfo[] {
    return [...this.accounts];
  }

  getChains(): string[] {
    return [...this.chains];
  }

  async connect(options: ConnectOptions): Promise<void> {
    const chains = normalizeChainIds(options.chains);
    if (chains.length === 0) throw new ZuniaConnectError("INVALID_PARAMS", "Pass at least one chain id");
    this.release();
    this.setStatus("connecting");
    const provider = await this.detect(this.options.detectTimeoutMs ?? 3_000);
    if (!provider) {
      this.setStatus("disconnected");
      throw new ZuniaConnectError("NOT_INSTALLED", "The Zunia extension is not installed");
    }
    try {
      await provider.enable(chains);
      this.provider = provider;
      this.chains = chains;
      this.subscribe(provider);
      await this.loadAccounts();
    } catch (error) {
      this.release();
      this.setStatus("disconnected");
      throw toZuniaConnectError(error);
    }
    this.bus.emit("chainChanged", this.getChains());
    this.setStatus("connected");
  }

  async restore(options: RestoreOptions): Promise<boolean> {
    const provider = await this.detect(Math.min(this.options.detectTimeoutMs ?? 3_000, 1_500));
    if (!provider?.getConnectedChains) return false;
    let granted: string[];
    try {
      granted = normalizeChainIds(await provider.getConnectedChains());
    } catch {
      return false;
    }
    const chains = options.chains ? normalizeChainIds(options.chains).filter((id) => granted.includes(id)) : granted;
    if (chains.length === 0) return false;
    this.release();
    this.provider = provider;
    this.chains = chains;
    this.subscribe(provider);
    if (await this.isLocked(provider)) {
      this.bus.emit("chainChanged", this.getChains());
      this.setStatus("locked");
      return true;
    }
    try {
      await this.loadAccounts();
    } catch {
      this.release();
      return false;
    }
    this.bus.emit("chainChanged", this.getChains());
    this.setStatus("connected");
    return true;
  }

  async disconnect(reason = "user"): Promise<void> {
    const provider = this.provider;
    const chains = this.chains;
    if (!provider) return;
    this.end(reason);
    try {
      await provider.disable?.(chains);
    } catch {
      // Already revoked in the extension.
    }
  }

  async signAmino(chainId: string, signer: string, signDoc: StdSignDoc): Promise<AminoSignResponse> {
    const provider = this.requireProvider();
    if (!provider.signAmino) throw new ZuniaConnectError("UNSUPPORTED", "This extension cannot sign Amino documents");
    try {
      return normalizeAminoResponse(await provider.signAmino(chainId, signer, signDoc), signDoc);
    } catch (error) {
      throw toZuniaConnectError(error);
    }
  }

  async signDirect(chainId: string, signer: string, signDoc: SignDocInput): Promise<DirectSignResponse> {
    const provider = this.requireProvider();
    if (!provider.signDirect) throw new ZuniaConnectError("UNSUPPORTED", "This extension cannot sign Direct documents");
    try {
      return normalizeDirectResponse(await provider.signDirect(chainId, signer, signDoc), signDoc);
    } catch (error) {
      throw toZuniaConnectError(error);
    }
  }

  async signArbitrary(chainId: string, signer: string, data: string | Uint8Array): Promise<StdSignature> {
    const provider = this.requireProvider();
    if (!provider.signArbitrary) throw new ZuniaConnectError("UNSUPPORTED", "This extension cannot sign messages");
    try {
      return normalizeStdSignature(await provider.signArbitrary(chainId, signer, data));
    } catch (error) {
      throw toZuniaConnectError(error);
    }
  }

  async suggestChain(chain: SuggestedChain): Promise<void> {
    const provider = this.requireProvider();
    if (!provider.experimentalSuggestChain) {
      throw new ZuniaConnectError("UNSUPPORTED", "This extension cannot add chains");
    }
    try {
      await provider.experimentalSuggestChain(chain);
    } catch (error) {
      throw toZuniaConnectError(error);
    }
  }

  private async detect(timeoutMs: number): Promise<ZuniaProvider | undefined> {
    return this.options.provider ?? (await getZunia({ timeoutMs }));
  }

  private requireProvider(): ZuniaProvider {
    if (!this.provider) throw new ZuniaConnectError("NOT_CONNECTED", "Connect to the extension first");
    return this.provider;
  }

  private async isLocked(provider: ZuniaProvider): Promise<boolean> {
    try {
      return (await provider.isLocked?.()) === true;
    } catch {
      return false;
    }
  }

  /** Reads each chain's key. Chains the extension no longer grants are dropped. */
  private async loadAccounts(): Promise<void> {
    const provider = this.requireProvider();
    const accounts: ZuniaAccountInfo[] = [];
    const kept: string[] = [];
    for (const chainId of this.chains) {
      try {
        accounts.push(accountFromKey(chainId, await provider.getKey(chainId)));
        kept.push(chainId);
      } catch (error) {
        const code = toZuniaConnectError(error).code;
        if (code !== "NOT_CONNECTED" && code !== "UNKNOWN_CHAIN") throw error;
      }
    }
    if (kept.length === 0) throw new ZuniaConnectError("NOT_CONNECTED", "The extension no longer grants these chains");
    if (!sameList(kept, this.chains)) {
      this.chains = kept;
      this.bus.emit("chainChanged", this.getChains());
    }
    this.accounts = accounts;
    this.bus.emit("accountsChanged", this.getAccounts());
  }

  private subscribe(provider: ZuniaProvider): void {
    this.detach?.();
    this.detach = null;
    if (!provider.on) return;
    const onAccounts = () => this.scheduleRefresh();
    const onChains = (data?: unknown) => {
      const next = chainIdsOf(data);
      if (!next) return;
      if (next.length === 0) return this.end("revoked");
      if (sameList(next, this.chains)) return;
      this.chains = next;
      this.accounts = this.accounts.filter((account) => next.includes(account.chainId));
      this.bus.emit("chainChanged", this.getChains());
      this.scheduleRefresh();
    };
    const onDisconnect = (data?: unknown) => {
      const lost = chainIdsOf(data);
      if (!lost) return this.end("revoked");
      const next = this.chains.filter((id) => !lost.includes(id));
      if (next.length === 0) return this.end("revoked");
      if (sameList(next, this.chains)) return;
      this.chains = next;
      this.accounts = this.accounts.filter((account) => next.includes(account.chainId));
      this.bus.emit("chainChanged", this.getChains());
      this.bus.emit("accountsChanged", this.getAccounts());
    };
    const onLocked = () => {
      if (this.provider) this.setStatus("locked");
    };
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChains);
    provider.on("disconnect", onDisconnect);
    provider.on("locked", onLocked);
    this.detach = () => {
      provider.off?.("accountsChanged", onAccounts);
      provider.off?.("chainChanged", onChains);
      provider.off?.("disconnect", onDisconnect);
      provider.off?.("locked", onLocked);
    };
  }

  /** Coalesces bursts of events into one re-read of the keys. */
  private scheduleRefresh(): void {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        await this.refresh();
      } while (this.refreshAgain && this.provider);
    })().finally(() => {
      this.refreshing = null;
    });
  }

  private async refresh(): Promise<void> {
    const provider = this.provider;
    if (!provider) return;
    // Reading a key while locked would open the unlock window unprompted.
    if (await this.isLocked(provider)) {
      this.setStatus("locked");
      return;
    }
    try {
      await this.loadAccounts();
      if (this.provider === provider) this.setStatus("connected");
    } catch (error) {
      if (this.provider !== provider) return;
      const failure = toZuniaConnectError(error);
      if (failure.code === "NOT_CONNECTED") this.end("revoked");
      else if (failure.code === "LOCKED") this.setStatus("locked");
      else this.bus.emit("error", failure);
    }
  }

  private end(reason: string): void {
    if (!this.provider) return;
    this.release();
    this.setStatus("disconnected");
    this.bus.emit("disconnect", reason);
  }

  private release(): void {
    this.detach?.();
    this.detach = null;
    this.provider = null;
    this.accounts = [];
    this.chains = [];
  }

  private setStatus(status: ZuniaSessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.bus.emit("status", status);
  }
}
