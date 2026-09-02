# @zunialab/sdk-web

Browser helpers for `window.zunia` and the official Connect with Zunia button.

```ts
import { getZunia, enableZunia, createConnectWithZuniaButton } from "@zunialab/sdk-web";

const zunia = await getZunia();
if (!zunia) throw new Error("Install Zunia extension");
await enableZunia("cosmoshub-4");

document.body.appendChild(
  createConnectWithZuniaButton({
    size: "md",
    onClick: () => enableZunia("cosmoshub-4"),
  }),
);
```
