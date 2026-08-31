# zunia_sdk (Flutter)

Flutter package for dApps and companion apps that connect to **Zunia** mobile via deep links / WalletConnect.

## Install

```yaml
dependencies:
  zunia_sdk:
    git:
      url: https://github.com/Zunia-Lab/zunia-sdk.git
      path: flutter/zunia_sdk
```

## Usage

```dart
import 'package:zunia_sdk/zunia_sdk.dart';

final uri = ZuniaConnect.universalWalletConnectUri();
final isOurs = ZuniaConnect.isZuniaConnectUri(uri);
```

Session management is intentionally out of scope until the wallet ships WC handlers. Use these constants with your WC client and the same Cloud `project_id` as Zunia apps.
