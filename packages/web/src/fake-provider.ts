/** A `window.zunia` stand-in that behaves like the extension, with a real key. */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  adr36SignDoc,
  bytesToBase64,
  pubkeyToAddress,
  serializeAminoSignDoc,
  utf8ToBytes,
  type StdSignDoc,
  type StdSignature,
  type ZuniaKey,
  type ZuniaProvider,
} from "@zunialab/sdk-core";

type Listener = (data?: unknown) => void;

/** How `signAmino` signs: a dummy digest (most tests), the chain's bytes, or Zunia 0.1.4's unescaped bytes. */
export type FakeAminoSigning = "dummy" | "escaped" | "unescaped";

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  return sorted;
}

export class FakeProvider implements ZuniaProvider {
  version = "test";
  extensionVersion: string | undefined = undefined;
  features: readonly string[] | undefined = undefined;
  readonly mode = "extension" as const;
  aminoSigning: FakeAminoSigning = "dummy";
  enables = 0;
  granted: string[] = [];
  locked = false;
  keyReads = 0;
  enableError: { message: string; code?: string } | null = null;
  disabled: string[][] = [];
  suggested: unknown[] = [];
  private secret = sha256(utf8ToBytes("fake provider key 1"));
  private readonly listeners = new Map<string, Set<Listener>>();

  get pubKey(): Uint8Array {
    return secp256k1.getPublicKey(this.secret, true);
  }

  get address(): string {
    return pubkeyToAddress(this.pubKey, "cosmos");
  }

  /** Switches to another account, like picking one in the popup. */
  switchAccount(label: string): void {
    this.secret = sha256(utf8ToBytes(`fake provider key ${label}`));
  }

  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  emit(event: string, data?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(data);
  }

  async enable(chainIds: string | string[]): Promise<void> {
    this.enables += 1;
    if (this.enableError) throw Object.assign(new Error(this.enableError.message), { code: this.enableError.code });
    // Like the extension: enable waits for the unlock window, then checks the grant.
    this.locked = false;
    for (const id of typeof chainIds === "string" ? [chainIds] : chainIds) if (!this.granted.includes(id)) this.granted.push(id);
  }

  async disable(chainIds?: string | string[]): Promise<void> {
    const ids = chainIds === undefined ? [...this.granted] : typeof chainIds === "string" ? [chainIds] : chainIds;
    this.disabled.push(ids);
    this.granted = this.granted.filter((id) => !ids.includes(id));
  }

  async getConnectedChains(): Promise<string[]> {
    return [...this.granted];
  }

  async isLocked(): Promise<boolean> {
    return this.locked;
  }

  async getKey(chainId: string): Promise<ZuniaKey> {
    this.keyReads += 1;
    if (!this.granted.includes(chainId)) throw Object.assign(new Error("Not authorized"), { code: "NOT_CONNECTED" });
    return { name: "Main", algo: "secp256k1", pubKey: this.pubKey, address: new Uint8Array(20), bech32Address: this.address };
  }

  getOfflineSigner(): unknown {
    return null;
  }

  async signAmino(_chainId: string, _signer: string, signDoc: StdSignDoc): Promise<unknown> {
    if (this.aminoSigning === "dummy") return { signed: signDoc, signature: this.signatureFor(new Uint8Array(32)) };
    const bytes =
      this.aminoSigning === "escaped" ? serializeAminoSignDoc(signDoc) : utf8ToBytes(JSON.stringify(sortKeysDeep(signDoc)));
    return { signed: signDoc, signature: this.signatureFor(sha256(bytes)) };
  }

  async signDirect(_chainId: string, _signer: string, signDoc: unknown): Promise<unknown> {
    return { signed: signDoc, signature: this.signatureFor(new Uint8Array(32)) };
  }

  async experimentalSuggestChain(chainInfo: unknown): Promise<void> {
    this.suggested.push(chainInfo);
  }

  async signArbitrary(_chainId: string, signer: string, data: string | Uint8Array): Promise<StdSignature> {
    const bytes = typeof data === "string" ? utf8ToBytes(data) : data;
    return this.signatureFor(sha256(serializeAminoSignDoc(adr36SignDoc(signer, bytes))));
  }

  on(event: string, listener: Listener): void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
  }

  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  protected signatureFor(digest: Uint8Array): StdSignature {
    return {
      pub_key: { type: "tendermint/PubKeySecp256k1", value: bytesToBase64(this.pubKey) },
      signature: bytesToBase64(secp256k1.sign(digest, this.secret, { prehash: false })),
    };
  }
}
