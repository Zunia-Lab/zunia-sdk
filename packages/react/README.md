# @zunialab/sdk-react

React hook and official **Connect with Zunia** button.

```tsx
import { useZunia, ConnectWithZuniaButton } from "@zunialab/sdk-react";

const { zunia, loading } = useZunia();

<ConnectWithZuniaButton
  installed={Boolean(zunia)}
  loading={loading}
  onClick={async () => {
    await zunia?.enable("cosmoshub-4");
  }}
/>
```

Use `fullWidth={false}` in a toolbar. Omit `onClick` when `installed` is false to send the user to zunialab.com.
