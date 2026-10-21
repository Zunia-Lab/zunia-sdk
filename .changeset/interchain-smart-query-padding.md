---
"@zunialab/interchain": patch
---

CosmWasm smart queries are sent as padded base64url. The REST gateway decodes only standard base64 or padded base64url, so unpadded queries failed with HTTP 400 about two times in three (`contract_info`, `tokens`…). Collections went missing and a pasted contract read as "endpoint unreachable". A contract's own rejection (HTTP 500 "query wasm contract failed") is now a `contract-error`, not retried and not reported as an outage.
