# @zunialab/mcp

## 0.1.0

First release: an MCP server over stdio and Streamable HTTP.

- Docs tools: `search_docs`, `get_doc`, `list_docs`, `list_integrations`, `get_integration_guide`, read from the published `docs-index.json`.
- `get_sdk_packages` and the guides read versions from npm when asked.
- `get_chain` and `check_address` use the Zunia chain registry.
- `explain_error`, `verify_sign_in`, `ibc_denom` and `build_forward_memo` run `@zunialab/sdk-core` and `@zunialab/interchain`.
- Docs pages as resources, and the `integrate_zunia` prompt.
