import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { signInApi } from "./server/sign-in.ts";

export default defineConfig({
  plugins: [react(), signInApi({ domain: process.env.SIGN_IN_DOMAIN ?? "localhost:5173" })],
  // A fixed port, because the sign-in server only accepts messages signed for this host.
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  // CosmJS alone is about 1.2 MB, loaded on demand by the send form.
  build: { chunkSizeWarningLimit: 1500 },
});
