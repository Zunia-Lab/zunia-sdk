# Flutter example (placeholder)

Add `zunia_sdk` as a path dependency:

```yaml
dependencies:
  zunia_sdk:
    path: ../../flutter/zunia_sdk
```

```dart
import 'package:zunia_sdk/zunia_sdk.dart';

void main() {
  print(ZuniaConnect.deepLinkWc);
}

// Official connect CTA
ConnectWithZuniaButton(
  onPressed: () {
    // Open your WalletConnect / deep-link flow.
  },
);
```
