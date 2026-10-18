---
"@zunialab/sdk-web": patch
---

A `connect()` made while a restore is still running is no longer lost. `useZuniaSession` restores on mount, and in a browser without the extension that restore waits up to 1.5 s for it: a Connect pressed in that time fell back to `idle`, with no QR code and no error. The connection now takes over, a restore started during a connection leaves it alone, and a connection that fails after a newer one replaced it no longer resets the newer one.
