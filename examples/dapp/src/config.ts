import type { ZuniaDappMetadata } from "@zunialab/sdk-core";

/** Osmosis testnet by default: tokens from a faucet, nothing of value at stake. */
export const CHAIN = {
  chainId: import.meta.env.VITE_CHAIN_ID ?? "osmo-test-5",
  rpc: import.meta.env.VITE_CHAIN_RPC ?? "https://rpc.testnet.osmosis.zone",
  denom: import.meta.env.VITE_CHAIN_DENOM ?? "uosmo",
  gasPrice: import.meta.env.VITE_CHAIN_GAS_PRICE ?? "0.025uosmo",
};

/** The relay that carries QR pairing. `pnpm dev` in zunia-backend listens on 8788. */
export const RELAY_API = import.meta.env.VITE_ZUNIA_API ?? "https://api.zunialab.com";

export const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "";

export const METADATA: ZuniaDappMetadata = {
  name: "Zunia example dApp",
  description: "Connect, sign in and send with Zunia",
  url: typeof location === "undefined" ? "http://localhost:5173" : location.origin,
};

/** Passed in, not imported, so apps that skip WalletConnect never bundle it. */
export const loadWalletConnect = () => import("@walletconnect/sign-client");

/** What both `connect` and the silent `restore` on page load need. */
export const SESSION_OPTIONS = {
  chains: [CHAIN.chainId],
  apiBase: RELAY_API,
  walletConnectProjectId: WALLETCONNECT_PROJECT_ID || undefined,
  loadWalletConnect,
};
