# @zunialab/interchain

## 0.1.1

### Patch Changes

- 50d52ce: `classifyTxFailure`'s `unauthorized` message names the other cause of a refused signature: the wallet signed different bytes than the chain checks.
- 50d52ce: Plan a swap whose funds are already on the venue chain as one contract call (no ibc-hooks needed), and settle a tracked route whose first hop is that swap once its outbound packet is acknowledged.

## 0.1.0

First public release: IBC channel discovery and verification, denom unwinding, packet-forward and ibc-hooks memos, cross-chain swaps and NFTs, packet tracking.
