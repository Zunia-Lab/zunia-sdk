/**
 * The shared type contract for `@zunialab/interchain`.
 *
 * Every feature module in this package codes against the types in this file and
 * nothing else. Concrete chain catalogs, storage, permissions and signing stay
 * in the host application; the engine only sees the interfaces declared here.
 *
 * Two rules hold everywhere in this package:
 *
 * 1. This package never holds a private key and never signs. It builds request
 *    payloads ({@link BuiltMsg}) and parses responses. Signing and broadcasting
 *    credentials live in zunia-core (Rust/WASM/FFI).
 * 2. Anything that came off the network arrives as `unknown` and is narrowed by
 *    a hand-written guard before it is used. The types below describe the
 *    *normalised* result of that narrowing, not the raw upstream JSON.
 */

/* -------------------------------------------------------------------------- *
 * Protocol constants
 * -------------------------------------------------------------------------- */

/**
 * The ICS20 fungible-transfer port.
 *
 * Lives here rather than in a feature module because four of them need it and
 * two names for `"transfer"` is one name too many: a chain that used a
 * different port would have to be wrong in exactly one place, not four.
 * cw20-ics20 contracts use `wasm.<contract>` instead, which is why the modules
 * that accept a port take it as an option rather than assuming this.
 */
export const TRANSFER_PORT = "transfer";

/* -------------------------------------------------------------------------- *
 * JSON
 * -------------------------------------------------------------------------- */

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;

/** Any value that survives `JSON.stringify` / `JSON.parse` unchanged. */
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/** A JSON array. Declared as an interface so the type stays cyclic-safe. */
export interface JsonArray extends ReadonlyArray<JsonValue> {}

/**
 * A JSON object.
 *
 * Values may be `undefined` so that a builder can write optional keys
 * (`{ next: maybeNext }`) without a cast; `JSON.stringify` drops them, which is
 * exactly the wire behaviour we want for optional memo fields.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

/* -------------------------------------------------------------------------- *
 * Chain metadata
 * -------------------------------------------------------------------------- */

/** Registry networks. Mirrors `CatalogEntry.network` in the extension. */
export type ChainNetwork = "mainnet" | "testnet";

/**
 * A capability flag advertised by the chain registry.
 *
 * The registry is an open vocabulary, so unknown strings are allowed. The named
 * members exist for autocompletion and because the engine branches on them:
 * `cosmwasm` gates NFT and crosschain-swap support.
 */
export type ChainFeature =
  | "cosmwasm"
  | "ibc-transfer"
  | "ibc-go-transfer"
  | "stargate"
  | "eth-address-gen"
  | "eth-key-sign"
  // Keeps the union open to registry strings we have not seen, without
  // collapsing the named members away as plain `string`.
  | (string & {});

/** Gas price tiers, in whole fee-denom units per gas unit. */
export interface GasPriceStep {
  readonly low: number;
  readonly average: number;
  readonly high: number;
}

/**
 * The minimum chain metadata the engine needs.
 *
 * Deliberately a structural subset of `CatalogEntry` in
 * `zunia-extension/lib/chain-catalog.ts` and `ChainEntry` in
 * `zunia-dashboard/src/lib/chains.ts`, so those clients can pass their catalog
 * rows straight in without mapping. Extra fields on the caller's object are
 * ignored.
 */
export interface ChainInfoLike {
  /** Canonical chain id, e.g. `safrochain-1`. */
  readonly chainId: string;
  /** Human name for UI copy, e.g. `Safrochain`. */
  readonly chainName: string;
  /**
   * Address prefix. Note this is not always `[a-z]+`: Safrochain uses
   * `addr_safro`, with an underscore, which the bech32 helpers must tolerate.
   */
  readonly bech32Prefix: string;
  /** SLIP-44 coin type. Informational here; derivation happens in zunia-core. */
  readonly coinType: number;
  /** Mainnet/testnet, when the host tracks it. */
  readonly network?: ChainNetwork;

  /** Display denom of the staking/primary token, e.g. `SAFRO`. */
  readonly coinDenom: string;
  /** Base denom of the primary token, e.g. `usafro`. */
  readonly coinMinimalDenom: string;
  /** Decimals between `coinDenom` and `coinMinimalDenom`. */
  readonly coinDecimals: number;

  /** Display denom used for fees. Usually equal to `coinDenom`. */
  readonly feeDenom: string;
  /** Base denom used for fees. */
  readonly feeMinimalDenom: string;
  /** Decimals for the fee denom. */
  readonly feeDecimals: number;

  /** Gas price tiers, when the registry publishes them. */
  readonly gasPriceStep?: GasPriceStep;

  /**
   * Registry capability flags. The catalog generator currently drops these; it
   * must carry them through, because NFT and swap modules refuse to run against
   * a chain that does not declare `cosmwasm`.
   */
  readonly features?: readonly ChainFeature[];

  /** Primary Tendermint RPC base URL. */
  readonly rpc?: string;
  /** Primary Cosmos SDK REST (LCD) base URL. */
  readonly rest?: string;

  /**
   * Additional REST base URLs, highest priority first, used for endpoint
   * fallback. Additive: the shipped catalogs only carry a single `rest`, and
   * {@link LcdClient} falls back to that when this is absent.
   */
  readonly restEndpoints?: readonly string[];
  /** Additional RPC base URLs, highest priority first. Same rules as above. */
  readonly rpcEndpoints?: readonly string[];

  /** Price-feed id, when the host tracks prices. Unused by the engine. */
  readonly coinGeckoId?: string;
}

/**
 * Chain lookup, implemented by the host.
 *
 * The engine must never import a concrete catalog: the extension reads its
 * generated catalog plus user-added chains, the dashboard reads a JSON bundle,
 * and mobile reads its own list. Each client injects an implementation.
 *
 * All three sources are in memory, so the interface is synchronous. A host with
 * an async source must preload before constructing the engine.
 */
export interface ChainRegistry {
  /** Exact chain-id lookup. `undefined` when the chain is unknown. */
  get(chainId: string): ChainInfoLike | undefined;
  /** Every known chain. Order is the host's; the engine does not rely on it. */
  list(): readonly ChainInfoLike[];
  /**
   * Chains using a bech32 prefix, for "which chain is this address on?".
   * Prefixes are not unique across the registry, so this returns a list. Match
   * on the exact prefix string, case-sensitively; do not strip separators
   * (`addr_safro` is one prefix, not `addr` + `safro`).
   */
  byPrefix(bech32Prefix: string): readonly ChainInfoLike[];
}

/* -------------------------------------------------------------------------- *
 * LCD access
 * -------------------------------------------------------------------------- */

/** Per-request knobs for {@link LcdClient.getJson}. */
export interface LcdRequestOptions {
  /** Abort a single attempt after this many ms. Defaults to the client's. */
  readonly timeoutMs?: number;
  /** Caller cancellation. Aborting throws `InterchainError` code `aborted`. */
  readonly signal?: AbortSignal;
  /**
   * Extra attempts per endpoint after the first, for retryable failures
   * (network error, timeout, HTTP 429 or 5xx). Defaults to the client's.
   */
  readonly retries?: number;
  /**
   * Serve a cached body younger than this, and cache the result for this long.
   * `0` disables the cache for this request. Defaults to the client's.
   */
  readonly cacheTtlMs?: number;
  /**
   * Query string parameters. `undefined` values are omitted. Provided because
   * every paginated LCD call needs them and hand-built query strings drift.
   */
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
}

/**
 * Read-only JSON access to one chain's REST (LCD) API.
 *
 * Feature modules depend on this interface, never on `fetch`. Everything that
 * makes a network call flaky — timeouts, retries, endpoint fallback, caching,
 * and the host's "live reads" privacy gate — lives behind it, so a module can
 * be tested by handing it a stub.
 *
 * @see createLcdClient in `./lcd.ts` for the one concrete implementation.
 */
export interface LcdClient {
  /** The chain this client reads. Used for error reporting and cache keys. */
  readonly chainId: string;
  /**
   * GET `path` and parse the body as JSON.
   *
   * @param path - Path beginning with `/`, e.g. `/ibc/core/channel/v1/channels`.
   * @returns The parsed body as `unknown`. Callers must narrow it by hand; the
   *   return type is deliberately not generic so no caller can assert a shape
   *   it has not checked.
   * @throws {@link InterchainError} with code `lcd-unreachable`,
   *   `malformed-response`, `reads-disabled` or `aborted`.
   */
  getJson(path: string, options?: LcdRequestOptions): Promise<unknown>;
}

/**
 * Builds an {@link LcdClient} for a chain.
 *
 * Multi-hop routing reads several chains in one operation, so modules take a
 * factory rather than a single client.
 */
export type LcdClientFactory = (chain: ChainInfoLike) => LcdClient;

/* -------------------------------------------------------------------------- *
 * IBC channels
 * -------------------------------------------------------------------------- */

/**
 * Channel handshake state, normalised from the LCD's `STATE_OPEN` spelling.
 *
 * Field name and members are kept identical to the three implementations this
 * package replaces so the clients are a drop-in swap.
 */
export type IbcChannelState = "open" | "closed" | "init" | "tryopen" | "unknown";

/** One transfer channel found on the source chain. */
export interface IbcChannelOption {
  readonly channelId: string;
  readonly portId: string;
  readonly counterpartyChannelId: string;
  /** Present in the extension's type; `"transfer"` when the LCD omits it. */
  readonly counterpartyPortId: string;
  readonly connectionId: string;
  /** `null` when the connection's client state could not be resolved. */
  readonly counterpartyChainId: string | null;
  readonly state: IbcChannelState;
}

/**
 * Result of checking one channel id, including UI copy.
 *
 * `message` is user-facing and is rendered as-is by all three clients; keep the
 * existing wording when porting ("Channel is closed, not open", "Open · osmosis-1").
 */
export interface IbcChannelCheck {
  readonly ok: boolean;
  readonly state: IbcChannelState;
  readonly channelId: string;
  readonly portId: string;
  readonly counterpartyChannelId?: string;
  readonly counterpartyChainId?: string | null;
  readonly message: string;
}

/* -------------------------------------------------------------------------- *
 * Denoms
 * -------------------------------------------------------------------------- */

/**
 * A denom trace as returned by `/ibc/apps/transfer/v1/denom_traces/{hash}`,
 * normalised to camelCase.
 *
 * Upstream JSON is `{ "path": "transfer/channel-0/transfer/channel-42",
 * "base_denom": "uatom" }`.
 */
export interface DenomTrace {
  /** Slash-joined `port/channel` pairs, outermost hop first. */
  readonly path: string;
  /** The denom on its origin chain, e.g. `uatom`. */
  readonly baseDenom: string;
}

/** One `port/channel` pair parsed out of a {@link DenomTrace.path}. */
export interface DenomHop {
  readonly port: string;
  readonly channelId: string;
}

/**
 * A denom after resolution.
 *
 * Unwinding walks {@link hops} left to right to reach the origin chain. Sending
 * a wrapped token anywhere other than back along the reverse path mints a
 * double-wrapped `ibc/…` denom that no UI can name, so the router prefers the
 * reverse path.
 */
export interface ResolvedDenom {
  /** The denom as presented on the holding chain: `uatom` or `ibc/27394F…`. */
  readonly denom: string;
  /** The denom on its origin chain. Equals {@link denom} when native. */
  readonly baseDenom: string;
  /** Raw trace path, `""` for a native denom. */
  readonly path: string;
  /** Parsed {@link path}, outermost hop first. Empty for a native denom. */
  readonly hops: readonly DenomHop[];
  /** Origin chain id, or `null` when it could not be resolved. */
  readonly originChainId: string | null;
  /** True when the token is native to the chain that holds it. */
  readonly isNative: boolean;
  /**
   * Uppercase SHA-256 of `path/baseDenom`, i.e. the part after `ibc/`.
   * `null` for a native denom.
   */
  readonly ibcHash: string | null;
}

/* -------------------------------------------------------------------------- *
 * Routing
 * -------------------------------------------------------------------------- */

/**
 * What happens at a hop.
 *
 * - `transfer` — a plain ICS20 send the user signs on the source chain.
 * - `forward` — a packet-forward-middleware hop, executed by the intermediate
 *   chain from the memo. The user does not sign it.
 * - `swap` — an ibc-hooks contract call (Osmosis crosschain-swaps), executed
 *   inside packet processing. The relayer pays that gas, not the user.
 */
export type RouteHopKind = "transfer" | "forward" | "swap";

/** One leg of a {@link RoutePlan}. */
export interface RouteHop {
  /** Chain the hop leaves from. */
  readonly chainId: string;
  /** Channel on {@link chainId}. Empty for a swap that does not move a packet. */
  readonly channelId: string;
  /** Port on {@link chainId}, normally `transfer`. */
  readonly port: string;
  /** Chain the hop arrives on, or `null` when unresolved. */
  readonly counterpartyChainId: string | null;
  readonly kind: RouteHopKind;
}

/**
 * A complete plan for moving value from one chain to another.
 *
 * A plan is inert data: it describes one ICS20 transfer plus the memo that
 * makes the remaining hops happen. Nothing here is signed.
 */
export interface RoutePlan {
  readonly sourceChainId: string;
  readonly destChainId: string;
  /** Denom as held on the source chain (`ibc/…` or native). */
  readonly inputDenom: string;
  /** Denom the recipient ends up with on the destination chain. */
  readonly outputDenom: string;
  /** Hops in execution order; `hops[0]` is the transfer the user signs. */
  readonly hops: readonly RouteHop[];
  /**
   * The ICS20 memo for the first transfer. `""` when no memo is needed — an
   * empty memo and an absent memo are the same thing on the wire.
   */
  readonly memo: string;
  /** Non-fatal notes to surface before the user signs (long path, low liquidity). */
  readonly warnings: readonly string[];
  /** Rough end-to-end time, for the "arrives in about…" line. */
  readonly estimatedDurationSeconds: number;
  /** True when {@link memo} carries a `forward` object. */
  readonly requiresPfm: boolean;
  /** True when {@link memo} carries a `wasm` object. */
  readonly requiresIbcHooks: boolean;
}

/** What the caller wants; the router turns this into a {@link RoutePlan}. */
export interface RouteRequest {
  readonly sourceChainId: string;
  readonly destChainId: string;
  /** Denom held on the source chain. */
  readonly inputDenom: string;
  /** Amount in base units, as a decimal string. Never a `number`. */
  readonly amount: string;
  /** Bech32 sender on the source chain. */
  readonly sender: string;
  /** Bech32 recipient on the destination chain. */
  readonly recipient: string;
  /** Desired output denom. Defaults to the unwrapped {@link inputDenom}. */
  readonly outputDenom?: string;
  /** Tolerated slippage as a percentage, e.g. `1` for 1%. Swaps only. */
  readonly slippagePercent?: number;
  /** Cap on hop count. Routers should default to a small number (3). */
  readonly maxHops?: number;
  /** Allow a crosschain-swap hop. Default true only if the host opts in. */
  readonly allowSwap?: boolean;
  /** Allow packet-forward-middleware hops. */
  readonly allowPfm?: boolean;
  /** Per-hop packet timeout in minutes; becomes the PFM `timeout` string. */
  readonly timeoutMinutes?: number;
  /**
   * Address that can reclaim funds if a swap succeeds but delivery fails
   * (`on_failed_delivery.local_recovery_addr`). Without it the contract is told
   * `"do_nothing"` and stuck funds are unrecoverable, so wallets should set it.
   */
  readonly recoveryAddress?: string;
}

/* -------------------------------------------------------------------------- *
 * Swaps
 * -------------------------------------------------------------------------- */

/** One pool leg of a swap route. */
export interface SwapPoolHop {
  readonly poolId: string;
  /** Denom leaving this pool, i.e. the input to the next hop. */
  readonly tokenOutDenom: string;
}

/**
 * A priced swap.
 *
 * All amounts are base units as decimal strings, so nothing is lost to floating
 * point. The percentage fields are numbers because they are display values.
 */
export interface SwapQuote {
  readonly inputDenom: string;
  readonly inputAmount: string;
  readonly outputDenom: string;
  /** Expected output before slippage. */
  readonly outputAmount: string;
  /** Price impact as a percentage, e.g. `0.42` for 0.42%. */
  readonly priceImpact: number;
  /** Total pool fee as a percentage of the input. */
  readonly poolFee: number;
  /** Guaranteed minimum output at {@link slippagePercent}, in base units. */
  readonly minReceived: string;
  /** Slippage tolerance the quote was computed with, as a percentage. */
  readonly slippagePercent: number;
  /** Pools traversed, in order. Empty when the venue does not expose them. */
  readonly route: readonly SwapPoolHop[];
}

/* -------------------------------------------------------------------------- *
 * Packet tracking
 * -------------------------------------------------------------------------- */

/**
 * Lifecycle of one IBC packet.
 *
 * - `pending` — the send tx committed; no relayer action seen yet.
 * - `relayed` — a `recv_packet` was submitted on the counterparty.
 * - `received` — the counterparty wrote a receipt; funds have landed.
 * - `acknowledged` — the ack came back to the source chain. Terminal, success.
 * - `timeout` — the timeout height/timestamp passed and funds were refunded.
 * - `failed` — an error acknowledgement; the destination rejected the packet.
 * - `unknown` — no endpoint could tell us. Not an error state; keep polling.
 */
export type PacketStatus =
  | "pending"
  | "relayed"
  | "received"
  | "acknowledged"
  | "timeout"
  | "failed"
  | "unknown";

/** Status of one hop within a multi-hop transfer. */
export interface PacketHopTrace {
  /** Position in {@link PacketTrace.hops}, starting at 0. */
  readonly index: number;
  /** Chain the packet was sent from. */
  readonly chainId: string;
  readonly channelId: string;
  readonly port: string;
  /** Chain the packet is bound for, or `null` when unresolved. */
  readonly counterpartyChainId: string | null;
  /** Packet sequence, as a decimal string; `null` before the send is indexed. */
  readonly sequence: string | null;
  /** Tx that sent this hop's packet, when known. */
  readonly sendTxHash: string | null;
  /** Tx that delivered it on the counterparty, when known. */
  readonly receiveTxHash: string | null;
  readonly status: PacketStatus;
  /** Error acknowledgement text, when {@link status} is `failed`. */
  readonly error: string | null;
}

/** End-to-end view of one user action across every hop. */
export interface PacketTrace {
  readonly sourceChainId: string;
  readonly destChainId: string;
  /** The tx the user signed. The only hash the user recognises. */
  readonly sourceTxHash: string;
  readonly hops: readonly PacketHopTrace[];
  /**
   * Aggregate status: the first non-terminal hop's status, or the last hop's
   * once every hop is terminal. This is what the UI shows.
   */
  readonly status: PacketStatus;
  /** `Date.now()` when this trace was assembled. */
  readonly updatedAt: number;
}

/* -------------------------------------------------------------------------- *
 * NFTs
 * -------------------------------------------------------------------------- */

/** One CW721 collection. */
export interface NftCollection {
  readonly chainId: string;
  /** CW721 contract address. Same value as {@link NftToken.collectionAddress}. */
  readonly contractAddress: string;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly description: string | null;
  readonly imageUri: string | null;
  /** From `{"num_tokens":{}}`; `null` when the contract does not answer it. */
  readonly tokenCount: number | null;
  /** From `collection_info` / `contract_info`; older contracts omit it. */
  readonly creator: string | null;
}

/**
 * One trait from the CW721 metadata extension.
 *
 * Upstream JSON is `{ "trait_type": …, "value": …, "display_type": … }`. The
 * extension is free-form, so parsers must tolerate missing keys and coerce
 * non-string values rather than dropping the trait.
 */
export interface NftAttribute {
  readonly traitType: string;
  readonly value: string;
  readonly displayType: string | null;
}

/** One token. Every metadata field is nullable: the extension is optional. */
export interface NftToken {
  readonly tokenId: string;
  readonly name: string | null;
  readonly description: string | null;
  /** May be `ipfs://…`; resolving gateways is the host's job, not the engine's. */
  readonly imageUri: string | null;
  readonly animationUri: string | null;
  readonly attributes: readonly NftAttribute[];
  readonly collectionAddress: string;
  readonly chainId: string;
  /** Current owner from `owner_of`, when the caller asked for it. */
  readonly owner: string | null;
  /** Raw `token_uri` before off-chain metadata is fetched. */
  readonly tokenUri: string | null;
}

/**
 * A request to move an NFT.
 *
 * Same-chain when {@link destChainId} is absent or equal to {@link chainId}
 * (a CW721 `transfer_nft`); otherwise ICS721, which is a `send_nft` to the
 * bridge contract carrying a base64 `msg` with `receiver` and `channel_id`.
 */
export interface NftTransferRequest {
  readonly chainId: string;
  readonly collectionAddress: string;
  readonly tokenId: string;
  readonly sender: string;
  readonly recipient: string;
  /** Destination chain for a cross-chain transfer. */
  readonly destChainId?: string;
  /** ICS721 channel on {@link chainId}. Required for cross-chain. */
  readonly channelId?: string;
  /**
   * cw-ics721 bridge contract on {@link chainId}. Never hardcode one: it is
   * per-chain deployment data and must come from host config.
   */
  readonly bridgeContract?: string;
  /** Packet timeout in minutes. */
  readonly timeoutMinutes?: number;
  /** ICS20-style memo, passed through when the bridge supports it. */
  readonly memo?: string;
}

/* -------------------------------------------------------------------------- *
 * Transactions
 * -------------------------------------------------------------------------- */

/** A `cosmos.base.v1beta1.Coin`. Amount is base units as a decimal string. */
export interface Coin {
  readonly denom: string;
  readonly amount: string;
}

/** An account's public key as the LCD reports it. */
export interface PubKeyInfo {
  /** Proto type URL, e.g. `/cosmos.crypto.secp256k1.PubKey`. */
  readonly typeUrl: string;
  /** Base64-encoded compressed key bytes. */
  readonly key: string;
}

/**
 * What the signer needs from the chain before building a sign doc.
 *
 * `accountNumber` and `sequence` are uint64 on the wire and are kept as
 * decimal strings; they are handed to the Rust kernel verbatim.
 */
export interface AccountInfo {
  readonly address: string;
  readonly accountNumber: string;
  readonly sequence: string;
  /** `null` for an account that has never signed, which is legal. */
  readonly pubKey: PubKeyInfo | null;
}

/** A fee, ready to be put in a tx body. */
export interface FeeEstimate {
  /** What will be paid. Usually one coin in the chain's fee denom. */
  readonly amount: readonly Coin[];
  /** Gas limit as a decimal string (uint64 on the wire). */
  readonly gasLimit: string;
  /** Gas price the estimate used, in fee-denom base units per gas unit. */
  readonly gasPrice: number;
  /** Simulated gas before the safety multiplier, when a simulation ran. */
  readonly simulatedGas?: string;
  /** Multiplier applied to {@link simulatedGas} to get {@link gasLimit}. */
  readonly gasAdjustment?: number;
  /** Fee grant payer/granter, when the host uses one. */
  readonly payer?: string;
  readonly granter?: string;
}

/**
 * One message, ready for the signer.
 *
 * This is the hand-off point to zunia-core: the kernel takes the type URL and
 * the JSON value and does the proto/amino encoding. This package produces these
 * and stops. It does not encode, sign or broadcast.
 */
export interface BuiltMsg {
  /** Proto type URL, e.g. `/ibc.applications.transfer.v1.MsgTransfer`. */
  readonly typeUrl: string;
  /** Message fields in proto-JSON (snake_case), exactly as the kernel wants. */
  readonly value: JsonObject;
}

/** Result of a broadcast, normalised from `/cosmos/tx/v1beta1/txs`. */
export interface BroadcastResult {
  readonly txHash: string;
  /** SDK result code. `0` means the tx was accepted. */
  readonly code: number;
  /** True when {@link code} is 0. Kept explicit so UI never re-derives it. */
  readonly success: boolean;
  readonly rawLog: string;
  readonly height?: string;
  readonly gasUsed?: string;
  readonly gasWanted?: string;
}

/**
 * Where a tx is.
 *
 * `not-found` is distinct from `failed`: an unindexed hash on a lagging LCD is
 * normal for a few seconds after broadcast and must not be shown as an error.
 */
export type TxStatusState = "pending" | "success" | "failed" | "not-found";

/** A tx as last observed on chain. */
export interface TxStatus {
  readonly txHash: string;
  readonly state: TxStatusState;
  /** SDK result code; `null` while pending or not found. */
  readonly code: number | null;
  readonly height: string | null;
  readonly rawLog: string | null;
  /** Block timestamp, RFC 3339, when the tx is included. */
  readonly timestamp: string | null;
  readonly gasUsed: string | null;
  readonly gasWanted: string | null;
}

/* -------------------------------------------------------------------------- *
 * Errors
 * -------------------------------------------------------------------------- */

/**
 * Why an interchain operation failed.
 *
 * UI copy is keyed off these, so each one means a distinct thing to the user
 * and a distinct next action. Do not add a code without a distinct next action.
 *
 * - `no-route` — no path exists between the two chains for this denom. The user
 *   should pick a different destination or bridge manually. Not retryable.
 * - `invalid-request` — the arguments cannot describe a real operation: a
 *   negative amount, the same denom on both sides of a swap, a slippage outside
 *   0-100, an address the wrong shape for the chain. Distinct from `no-route`,
 *   which means the request made sense and the network could not serve it, and
 *   from `malformed-response`, which blames the node. Never retryable, and the
 *   fix is always in the caller's input.
 * - `channel-closed` — a channel on the path is not `open`. Usually permanent
 *   for that channel; the router should offer another one.
 * - `lcd-unreachable` — every REST endpoint failed or timed out. Nothing is
 *   known about the chain state. Retryable; show "can't reach the network".
 * - `unsupported-chain` — the chain is unknown to the registry, or lacks a
 *   capability the operation needs (no `cosmwasm` for an NFT or swap). The user
 *   cannot fix this by retrying; the chain needs to be added or the feature hidden.
 * - `invalid-memo` — a memo we built or were handed violates the middleware
 *   rules (bad JSON, missing `forward`/`wasm`, or a `wasm` object without
 *   exactly `contract` and `msg`). Always a bug on our side; never show raw JSON.
 * - `slippage-exceeded` — the quote moved past tolerance before signing, or the
 *   contract reported it. The user should re-quote or raise tolerance.
 * - `packet-timeout` — the packet timed out. Funds are refunded on the source
 *   chain; say so, because a timeout reads like a loss otherwise.
 * - `contract-error` — a CosmWasm query or execution failed. Carries the
 *   contract's message, which is developer-facing.
 * - `tx-rejected` — the chain accepted the request and refused the transaction:
 *   insufficient fees, a sequence mismatch, out of gas, already in the mempool.
 *   Nothing is wrong with the network or the contract, and the transaction hash
 *   usually exists. `TxFailureKind` in `tx.ts` carries which one it was and
 *   whether re-signing helps.
 * - `unsupported-environment` — a web platform API this package needs is
 *   missing from the runtime. In practice that is `crypto.subtle` on a page
 *   served over plain http, which is not a secure context. The user cannot fix
 *   it and the chain is not at fault; the host has to be served over https.
 * - `malformed-response` — an endpoint answered, but not with the shape the
 *   spec says. Treat the endpoint as broken and fall back, do not trust partial data.
 * - `reads-disabled` — the host's live-reads setting or host permission is off.
 *   Not a failure: the UI prompts the user to turn live reads on. Kept separate
 *   from `lcd-unreachable` so we never blame the network for a local setting.
 * - `aborted` — the caller cancelled. Show nothing.
 */
export type InterchainErrorCode =
  | "no-route"
  | "invalid-request"
  | "channel-closed"
  | "lcd-unreachable"
  | "unsupported-chain"
  | "unsupported-environment"
  | "invalid-memo"
  | "slippage-exceeded"
  | "packet-timeout"
  | "contract-error"
  | "tx-rejected"
  | "malformed-response"
  | "reads-disabled"
  | "aborted";

/** Optional context attached to an {@link InterchainError}. */
export interface InterchainErrorDetails {
  readonly chainId?: string;
  readonly channelId?: string;
  /** REST base URL that produced the failure. */
  readonly endpoint?: string;
  /** HTTP status, when there was a response. */
  readonly httpStatus?: number;
  /** The underlying error, kept for logs. Never shown to the user. */
  readonly cause?: unknown;
}

const INTERCHAIN_ERROR_NAME = "InterchainError";

/**
 * The only error type this package throws.
 *
 * `message` is developer-facing. User-facing copy is chosen by the host from
 * {@link code}, so hosts can localise without parsing strings.
 */
export class InterchainError extends Error {
  /** Discriminant. Switch on this, never on {@link Error.message}. */
  readonly code: InterchainErrorCode;
  readonly chainId?: string;
  readonly channelId?: string;
  readonly endpoint?: string;
  readonly httpStatus?: number;

  constructor(
    code: InterchainErrorCode,
    message: string,
    details: InterchainErrorDetails = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = INTERCHAIN_ERROR_NAME;
    this.code = code;
    if (details.chainId !== undefined) this.chainId = details.chainId;
    if (details.channelId !== undefined) this.channelId = details.channelId;
    if (details.endpoint !== undefined) this.endpoint = details.endpoint;
    if (details.httpStatus !== undefined) this.httpStatus = details.httpStatus;
    // Consumers may downlevel to ES5, where extending Error loses the
    // prototype chain and `instanceof` stops working.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Type guard for {@link InterchainError}.
 *
 * Prefer this over `instanceof`: a host that ends up with two copies of this
 * package (bundled plus linked) has two distinct classes, and `instanceof`
 * would fail across them. This checks the shape instead.
 */
export function isInterchainError(value: unknown): value is InterchainError {
  if (value instanceof InterchainError) return true;
  if (typeof value !== "object" || value === null) return false;
  const row = value as { name?: unknown; code?: unknown };
  return row.name === INTERCHAIN_ERROR_NAME && typeof row.code === "string";
}
