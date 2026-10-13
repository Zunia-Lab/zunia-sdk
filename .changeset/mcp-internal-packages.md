---
"@zunialab/mcp": patch
---

`get_sdk_packages` no longer lists packages the docs only name in build steps (`@zunialab/ui`, `@zunialab/tokens`) as "not on npm yet": a package outside the published set is listed once it is on npm.
