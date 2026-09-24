/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_CHAIN_RPC?: string;
  readonly VITE_CHAIN_DENOM?: string;
  readonly VITE_CHAIN_GAS_PRICE?: string;
  readonly VITE_ZUNIA_API?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
