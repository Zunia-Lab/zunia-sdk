<p align="center">
  <img src="https://raw.githubusercontent.com/Zunia-Lab/zunia-brand/main/png/icons/app/zunia-icon-256.png" alt="Zunia" width="96" />
</p>

# zunia-sdk

> Official developer SDKs for integrating **Zunia** into dApps, websites, and mobile apps.

[![License](https://img.shields.io/github/license/Zunia-Lab/zunia-sdk)](LICENSE)
[![Website](https://img.shields.io/badge/website-zuniawallet.com-FF1B0C)](https://zuniawallet.com)
[![Docs](https://img.shields.io/badge/docs-docs.zuniawallet.com-FF1B0C)](https://docs.zuniawallet.com)

## Packages

| Package | Platform | npm / pub | Purpose |
|---------|----------|-----------|---------|
| [`@zunialab/sdk-core`](./packages/core) | Shared | TypeScript | Types, connect constants, WC namespaces |
| [`@zunialab/sdk-web`](./packages/web) | Browser | TypeScript | Detect `window.zunia`, enable, offline signer helpers |
| [`@zunialab/sdk-react`](./packages/react) | React | TypeScript | Hooks + official Connect with Zunia button |
| [`zunia_sdk`](./flutter/zunia_sdk) | Flutter | Dart | Mobile deep links, WC helpers, Connect with Zunia button |

Use **web** when the user has the browser extension. Use **Flutter** (or WalletConnect via core constants) when connecting to the mobile wallet.

## Status

Scaffold / config surface. Full provider and WalletConnect session logic lands with wallet releases. APIs below are the intended contract.

## Quick start (web)

```bash
pnpm add @zunialab/sdk-web
# or: npm install @zunialab/sdk-web
```

```ts
import { getZunia, enableZunia } from "@zunialab/sdk-web";

const zunia = await getZunia();
if (!zunia) throw new Error("Install Zunia extension");
await enableZunia("cosmoshub-4");
const signer = zunia.getOfflineSigner("cosmoshub-4");
```

Official connect button (React):

```tsx
import { ConnectWithZuniaButton } from "@zunialab/sdk-react";

<ConnectWithZuniaButton
  installed={Boolean(zunia)}
  onClick={() => enableZunia("cosmoshub-4")}
/>
```

Vanilla web: `createConnectWithZuniaButton()` from `@zunialab/sdk-web`. Flutter: `ConnectWithZuniaButton`.

## Quick start (Flutter)

```yaml
dependencies:
  zunia_sdk:
    git:
      url: https://github.com/Zunia-Lab/zunia-sdk.git
      path: flutter/zunia_sdk
```

```dart
import 'package:zunia_sdk/zunia_sdk.dart';

final link = ZuniaConnect.walletConnectUniversalLink;
// Session handlers not wired yet — config + URI helpers only.
```

## Monorepo layout

```
packages/
  core/     @zunialab/sdk-core
  web/      @zunialab/sdk-web
  react/    @zunialab/sdk-react
flutter/
  zunia_sdk/
examples/
  web/      Minimal browser example (placeholder)
  flutter/  Minimal Flutter example (placeholder)
```

## Develop this repo

```bash
pnpm install
pnpm build
pnpm typecheck
```

Flutter package:

```bash
cd flutter/zunia_sdk && dart pub get && dart analyze
```

## Related

| Repository | Role |
|------------|------|
| [zunia-extension](https://github.com/Zunia-Lab/zunia-extension) | Injects `window.zunia` |
| [zunia-mobile](https://github.com/Zunia-Lab/zunia-mobile) | WC + deep links |
| [zunia-docs](https://github.com/Zunia-Lab/zunia-docs) | Integration docs |
| [zunia-chain-registry](https://github.com/Zunia-Lab/zunia-chain-registry) | Chain metadata |
| [zunia-ui](https://github.com/Zunia-Lab/zunia-ui) | UI kit (not required for connect) |

## Security

See [SECURITY.md](./SECURITY.md). Never request seed phrases in your dApp.

## License

Apache-2.0. See [LICENSE](LICENSE).
