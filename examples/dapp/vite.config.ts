import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { signInApi } from "./server/sign-in.ts";

export default defineConfig({
  plugins: [react(), signInApi({ domain: process.env.SIGN_IN_DOMAIN ?? "localhost:5173" })],
  // Prefer 5173. If that port is taken, the sign-in check follows the port Vite actually bound.
  server: { port: 5173, strictPort: false },
  preview: { port: 5173, strictPort: false },
  // CosmJS alone is about 1.2 MB, loaded on demand by the send form.
  build: { chunkSizeWarningLimit: 1500 },
});
