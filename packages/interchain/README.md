# @zunialab/interchain

The IBC engine shared by every Zunia client: channel discovery, denom
unwinding, packet-forward and ibc-hooks memos, cross-chain swaps, cross-chain
NFTs, and packet tracking.

## Why this package exists

IBC channel discovery was written three times, once per client:

| Client | File |
|--------|------|
| Extension | `zunia-extension/lib/ibc-channels.ts` |
| Dashboard | `zunia-dashboard/src/lib/server/ibc-channels.ts` |
| Mobile | `zunia-mobile/lib/services/chain_client.dart` (IBC section) |

The three copies were near-identical and already drifting — different timeouts,
one carrying `counterpartyPortId` and the others not, one gated behind the
live-reads privacy setting and one not. Every new IBC feature would have been
written three more times.

This package is the single implementation. The TypeScript clients import it
directly; the Dart client mirrors it, module for module, against the same type
names so the two stay comparable by eye.

Two bugs were found while unifying them and are fixed here. Both were present
in all three copies:

- `STATE_TRYOPEN` was reported as **open**, because the state test was
  `s.includes("OPEN")` and `"STATE_TRYOPEN"` contains `"OPEN"`. A channel still
  mid-handshake rendered as "Open".
- `STATE_UNINITIALIZED_UNSPECIFIED` was reported as **init**, for the same
  reason with `"INIT"`.

A third is in code this package replaces but does not own:
`zunia-extension/lib/format.ts:98`'s `isBech32()` rejects every Safrochain
address, because its character class has no `_` and `addr_safro` has one. Its
`prefixOf()` splits on the first `1` rather than the last. `isValidBech32Address`
and `bech32PrefixOf` here are correct; the extension's copies still are not.

## This package never signs

It holds no private key, derives no address, and produces no signature. It
builds request payloads — a `BuiltMsg` is a proto type URL plus a JSON value —
and parses responses. Signing and key material stay in `zunia-core`
(Rust → WASM in the browser, FFI on mobile).

If you find yourself needing a key in here, the design is wrong.

## Constraints

- **Zero runtime dependencies.** Only web-standard APIs that exist in both an
  MV3 service worker and Node 22: `fetch`, `AbortController`, `TextEncoder`,
  `TextDecoder`, `crypto.subtle`, `URL`, `JSON`. No `node:` imports, no cosmjs,
  no `Buffer` — hence the hand-written base64.
- **All network access goes through `lcd.ts`.** No feature module calls
  `fetch`; `grep -rn "fetch(" src --include='*.ts' | grep -v test` returns two
  lines, both in `lcd.ts`. Timeouts, retries, endpoint fallback, caching, the
  host's live-reads gate, and the single POST path all live there.
- **No concrete chain catalog.** The engine takes a `ChainRegistry` that the
  host implements, so the extension keeps its generated catalog plus
  user-added chains, the dashboard keeps its JSON bundle, and mobile keeps its
  own list.
- **External JSON is `unknown`.** Every response is narrowed by a hand-written
  guard. No `any` in an exported signature, no `!` on parsed JSON.

## Module map

Dependencies point downwards only. `types.ts` imports nothing; nothing imports a
module below it in this table except as listed. There are no cycles, and adding
one would break the Dart mirror.

| Module | Depends on | Responsibility |
|--------|-----------|----------------|
| `types.ts` | — | The shared contract: chain metadata, `LcdClient`, routes, denoms, NFTs, `InterchainError`, and the one protocol constant `TRANSFER_PORT`. |
| `lcd.ts` | types | The one transport. Per-attempt timeout, bounded retry with backoff, ordered endpoint fallback, TTL cache, live-reads gate — and `postJson`, used only by simulate and broadcast. |
| `base64.ts` | types | base64 / base64url for `Uint8Array` and UTF-8 strings, for wasm smart queries and ICS721 payloads. |
| `registry.ts` | types | Chain lookup and feature checks, bech32 validation and prefix extraction (`addr_safro` included), and the persistable channel-route cache. |
| `channels.ts` | types | Transfer-channel discovery and validation, counterparty checks, PFM / ibc-hooks probes. Replaces the three copies above and keeps their user-facing copy. |
| `denom.ts` | types, channels | Denom traces, `ibc/HASH` computation, and unwinding a wrapped denom back along its path. |
| `memo.ts` | types, base64 | Packet-forward-middleware, ibc-hooks and crosschain-swap memos: build, parse, and enforce the middleware's acceptance rules. |
| `swap.ts` | types, memo | Osmosis quoting (poolmanager and SQS) and XCS slippage. |
| `route.ts` | types, channels, denom, memo, swap | Multi-hop route planning across the registry; produces ranked `RoutePlan`s. |
| `nft.ts` | types, base64 | CW721 queries, ICS721 transfers, and the package's one `MsgExecuteContract` builder. |
| `tracking.ts` | types, base64, lcd, nft | Per-hop packet status for a transfer the user already signed, plus XCS recovery. |
| `tx.ts` | types, base64, lcd, memo | Account info, fee estimation, simulate, broadcast, inclusion polling, and the unsigned-tx payload for zunia-core. |
| `index.ts` | all | The curated barrel. Every name is listed; there is no `export *`. |

Tests are colocated as `<module>.test.ts`, plus `index.test.ts`, which asserts
the barrel resolves and re-checks the five fund-losing invariants through the
public API rather than inside one module.

## Errors

Everything throws `InterchainError`, discriminated by `code`. UI copy is keyed
off the code, never off the message:

| Code | Means | User's next action |
|------|-------|--------------------|
| `no-route` | The request made sense; no path exists. | Pick another destination. |
| `invalid-request` | The arguments cannot describe a real operation. | Caller bug; fix the input. |
| `channel-closed` | A channel on the path is not open. | Try another channel. |
| `lcd-unreachable` | Every REST endpoint failed. | Retry. |
| `unsupported-chain` | Unknown chain, or one lacking a needed capability. | Add the chain, or hide the feature. |
| `unsupported-environment` | A required web API is missing (`crypto.subtle` on plain http). | Serve the host over https. |
| `invalid-memo` | A memo violates the middleware rules. | Our bug; never show raw JSON. |
| `slippage-exceeded` | The quote moved past tolerance. | Re-quote or raise tolerance. |
| `packet-timeout` | The packet timed out. Funds are refunded. | Say so — a timeout reads like a loss. |
| `contract-error` | A CosmWasm query or execution failed. | Developer-facing. |
| `tx-rejected` | The chain refused the transaction. | See `TxFailure.kind` and `retryable`. |
| `malformed-response` | An endpoint answered with the wrong shape. | Treat the endpoint as broken. |
| `reads-disabled` | The host's live-reads setting is off. | Prompt for the setting; not a failure. |
| `aborted` | The caller cancelled. | Show nothing. |

Use `isInterchainError` rather than `instanceof`: a host that ends up with both
a bundled and a linked copy of this package has two distinct classes.

## Usage

```ts
import {
  createLcdClientFactory,
  lcdEndpointsFromChain,
  isInterchainError,
  type ChainRegistry,
} from "@zunialab/interchain";

// The host owns the catalog; the engine only sees this interface.
const registry: ChainRegistry = {
  get: (chainId) => CHAIN_CATALOG.find((c) => c.chainId === chainId),
  list: () => CHAIN_CATALOG,
  byPrefix: (prefix) =>
    CHAIN_CATALOG.filter((c) => c.bech32Prefix === prefix),
};

const lcd = createLcdClientFactory({
  timeoutMs: 9_000,
  cacheTtlMs: 30_000,
  // Extension: honour the live-balances setting and the optional host permission.
  readsAllowed: async () =>
    (await getSettings()).liveBalances && (await hasLiveBalancePermission()),
});

const chain = registry.get("safrochain-1");
if (chain && lcdEndpointsFromChain(chain).length > 0) {
  try {
    const body = await lcd(chain).getJson("/ibc/core/channel/v1/channels", {
      query: { "pagination.limit": 100 },
    });
    // `body` is `unknown` — narrow it before use.
  } catch (error) {
    if (isInterchainError(error) && error.code === "reads-disabled") {
      // Prompt for the setting; this is not a network failure.
    }
  }
}
```

Wiring the planner to the denom module, which is the one join a host has to make
by hand:

```ts
import {
  createDenomResolver,
  createChannelDirectory,
  planRoute,
  routeDenomResolver,
} from "@zunialab/interchain";

const denoms = createDenomResolver({ registry, lcd });
const result = await planRoute(request, {
  registry,
  lcd,
  channels: createChannelDirectory(links),
  resolveDenom: routeDenomResolver(denoms),
});
```

## What is NOT done yet

### TODO-VERIFY in the code

`grep -rn "TODO-VERIFY" src` is the authoritative list. As of now, nineteen
markers across nine files. Each is a claim about an upstream shape that
`INTERCHAIN-SPEC.md` does not cover, modelled defensively and flagged in place.

1. **`channels.ts:72` — `PFM_PROBE_PATHS`.** How to detect that a chain runs
   packet-forward-middleware is not in the spec. Confirm
   `/ibc/apps/packetforward/v1/params` against a live Osmosis or Neutron LCD.
2. **`channels.ts:89` — `IBC_HOOKS_PROBE_PATHS`.** Weaker still: `x/ibc-hooks`
   is middleware and several releases register no query service, so detection
   falls back to "is CosmWasm present", which can rule the module out but never
   in. Expect `status: "unknown"` on Osmosis itself.
3. **`denom.ts:53` — ibc-go v9's `/ibc/apps/transfer/v1/denoms/{hash}`** and its
   `{denom:{base,trace:[{port_id,channel_id}]}}` body. Tried only after the
   documented path 404s.
4. **`memo.ts:66` — `PACKET_MEMO_MAX_BYTES = 32768`.** The spec says nothing
   about memo length. Every builder takes `MemoLimits.maxBytes`, so a wrong
   number is a config change, not a code change.
5. **`memo.ts:307` — PFM `retries` is a `uint8`.** From the middleware's Go
   type, from memory. The spec only says "an integer".
6. **`memo.ts:526` — `wasmHookReceiver()` returns the contract, not `""`.**
   Both are legal per the spec; the contract was chosen because
   `MsgTransfer.ValidateBasic` is believed to reject a blank receiver. If that
   is wrong the choice is still safe and only the reason changes.
7. **`memo.ts:681` — XCS `slippage_percentage` is capped at 100.** Read as a
   percentage; the spec's example is `"20"` with no stated range.
8. **`memo.ts:745` — `next_memo` is always emitted, `null` when absent.** Not
   verified whether the contract's `Option` field carries a serde default.
9. **`nft.ts:76` — cw-ics721 `IbcOutgoingMsg.timeout`.** Assumed non-optional
   and shaped as `cosmwasm_std::IbcTimeout` (`{"timestamp":"<nanos>"}`). The
   spec guarantees only `receiver` and `channel_id`.
   `Ics721TransferOptions.timeout` overrides the whole object without a release.
10. **`nft.ts:1002` — a bare CID `token_uri`** (`Qm…` / `bafy…`, no scheme) is
    treated as IPFS. A heuristic, not a rule.
11. **`nft.ts:1440` — `MsgExecuteContract.msg` is standard base64** of the JSON
    bytes. `zunia-core/crates/cosmos/src/msg.rs` has
    `ExecuteContract { …, msg: Vec<u8> }` but no serde derive and no binding, so
    this is proto-JSON semantics chosen for round-tripping. One builder now
    (`buildExecuteContractMsg`), used by both `nft.ts` and `tracking.ts`, so
    there is exactly one line to change if the kernel disagrees.
12. **`registry.ts:899` — the seed channel table.** Only
    `cosmoshub-4 channel-141 ⇄ osmosis-1 channel-0` ships. **There is no
    Safrochain seed**, because no channel number for it could be confirmed from
    a primary source; discovery finds it at runtime. A test fails if a
    Safrochain row is added without a citation.
13. **`route.ts:768` — the duration model.** 20s base, 40s per hop, 15s per
    swap. Invented. Override `RouteDurationModel` with real telemetry.
14. **`route.ts:881` — the ICS20 receiver on an intermediate PFM chain.** The
    spec documents `forward.receiver` inside the memo and nothing about the
    packet's own receiver. `PlanRouteOptions.intermediateReceivers` lets the
    host supply real addresses; without them the planner uses `"pfm"` **and
    warns that the host must replace it before signing**. This is the one field
    where a wrong choice loses funds.
15. **`route.ts:1660` — XCS `receiver` semantics after the swap.** Assumed to be
    an address on the chain immediately after Osmosis, with `next_memo` carrying
    anything beyond. Consistent with the spec, not stated by it.
16. **`tracking.ts:31` — every IBC event name and SDK tx-response shape.**
    `send_packet`, `recv_packet`, `write_acknowledgement`, `acknowledge_packet`,
    `timeout_packet`, `ibc_transfer`, `fungible_token_packet`, the
    `packet_*` attributes, base64-vs-plain attributes, `tx_response.events` vs
    `logs[].events`, and both `?query=` and `?events=` tx search spellings.
17. **`tracking.ts:374` — ICS20 v2 `tokens[]` packet data.** Read as a fallback.
18. **`swap.ts:68` — `/osmosis/poolmanager/v1beta1/Params`,** capitalised. The
    lowercase spelling is HTTP 501. It looks like a typo and someone will
    helpfully "fix" it.
19. **`tx.ts:1095` — the `UnsignedTxRequest` payload.** Modelled on
    `zunia-core/crates/cosmos/src/tx.rs`, but the Rust `Msg` enum derives no
    `Serialize`/`Deserialize` today and nothing consumes this payload yet.

### Blocking gaps outside this package

- **Nothing can broadcast a real transaction yet.** `broadcast()` here is ready;
  what is missing is a generic builder on the zunia-core bindings, roughly
  `build_unsigned_tx(request_json: &str) -> String`. `crates/wasm` and
  `crates/ffi` expose only `build_bank_send_direct`, and
  `zunia-core/packages/npm` is an empty `.gitkeep`, so the extension falls back
  to `zunia-extension/lib/kernel.ts` and
  `zunia-extension/lib/provider-handler.ts:317` still returns a mock hash.
- **`zunia-extension/scripts/generate-chain-catalog.mjs` drops the `features`
  array.** Until it carries it through, `featureSupport` answers `unknown` for
  every shipped chain, which means **NFT and swap features are off for every
  extension chain** unless the caller passes `allowUnknownFeatures: true`. This
  is the single most likely thing to look like a broken package.
- **The XCS contract address is never a constant.** The spec's two candidate
  addresses are unverified; hosts must supply the address through config and
  check it on chain. `SwapVenue.contractAddress` is the only way in.
- **No Osmosis pool telemetry.** `RoutePlanCandidate.quote` is always `null` and
  `requiresQuote` says a quote is needed; nothing here invents an output amount.

### Behaviour worth a second opinion

Not bugs — decisions with a plausible other answer, each a one-line change.

- `counterparty.status` `"unreachable"` and `"skipped"` do **not** fail a
  channel check. Only `not-found` / `not-open` / `mismatch` do. Blocking a send
  because the *destination's* public LCD is down is its own failure mode.
- `RouteRegistry.prune` removes only `discovered` rows. `seed` and `manual` are
  exempt.
- A chain row with no `network` is in neither `mainnets()` nor `testnets()`.
  Guessing "mainnet" would present testnet funds as real.
- `allowSwap` defaults to **false** on `RouteRequest`, so a cross-asset request
  returns zero candidates plus a warning until the host opts in.
- `route.ts`'s double-wrap penalty (120) is deliberately larger than one hop
  (100), so a wrapped token routes home rather than onward. Both plans are
  offered; the forward one carries a warning.
- `swap.ts` maps HTTP 400/500 to `no-route` because `lcd.ts` discards non-2xx
  bodies and status is all it has. A genuinely broken node also 500s.
- `nft.ts` refuses to run against a chain whose `features` is `undefined`. See
  the catalog-generator gap above.
- Metadata fetching has no default transport and no default IPFS gateway: a
  hardcoded gateway would funnel every user's holdings to one operator.

## Develop

```bash
pnpm build      # tsup, ESM + .d.ts
pnpm typecheck  # tsc --noEmit
pnpm test       # node --import tsx --test
```

Tests are pure: they stub `LcdClient` or `fetchImpl` and never touch the
network. `planRoute`'s test fixtures hand it an `LcdClientFactory` that throws.

## License

Apache-2.0.
