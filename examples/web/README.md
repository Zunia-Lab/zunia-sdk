# Web example (placeholder)

Install packages from the monorepo once published, or via `pnpm link`.

```ts
import { getZunia, enableZunia } from "@zunialab/sdk-web";

const zunia = await getZunia();
console.log(zunia ? "Zunia ready" : "Install extension");
```

Full demo app lands with the extension provider implementation.
