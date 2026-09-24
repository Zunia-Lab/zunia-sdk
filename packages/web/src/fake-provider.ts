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

export class FakeProvider implements ZuniaProvider {
  readonly version = "test";
  readonly mode = "extension" as const;
  granted: string[] = [];
  locked = false;
  keyReads = 0;
  enableError: { message: string; code?: string } | null = null;
  disabled: string[][] = [];
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
    if (this.enableError) throw Object.assign(new Error(this.enableError.message), { code: this.enableError.code });
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
    return { signed: signDoc, signature: this.signatureFor(new Uint8Array(32)) };
  }

  async signDirect(_chainId: string, _signer: string, signDoc: unknown): Promise<unknown> {
    return { signed: signDoc, signature: this.signatureFor(new Uint8Array(32)) };
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

  private signatureFor(digest: Uint8Array): StdSignature {
    return {
      pub_key: { type: "tendermint/PubKeySecp256k1", value: bytesToBase64(this.pubKey) },
      signature: bytesToBase64(secp256k1.sign(digest, this.secret, { prehash: false })),
    };
  }
}
