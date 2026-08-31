/** Canonical connect / WalletConnect constants shared by web + mobile SDKs. */

export const ZUNIA_WALLET = {
  name: "Zunia",
  shortName: "Zunia",
  url: "https://zuniawallet.com",
  docsUrl: "https://docs.zuniawallet.com",
  icons: [
    "https://raw.githubusercontent.com/Zunia-Lab/zunia-brand/v1.0.0/assets/icon/icon-512.png",
  ],
} as const;

export const ZUNIA_PROVIDER_GLOBAL = "zunia" as const;
export const ZUNIA_KEPLR_ALIAS_GLOBAL = "keplr" as const;

export const ZUNIA_DEEP_LINKS = {
  customScheme: "zunia",
  mobileScheme: "zuniamobile",
  walletConnectScheme: "wc",
  walletConnectPath: "zunia://wc",
  universalWc: "https://zuniawallet.com/wc",
  universalConnect: "https://zuniawallet.com/connect",
  linkWc: "https://link.zuniawallet.com/wc",
} as const;

export const ZUNIA_WALLETCONNECT = {
  version: 2 as const,
  relayUrl: "wss://relay.walletconnect.com",
  /** Env var name used by apps; value comes from WalletConnect Cloud */
  projectIdEnv: "WALLETCONNECT_PROJECT_ID",
  cosmosMethods: [
    "cosmos_getAccounts",
    "cosmos_signAmino",
    "cosmos_signDirect",
    "cosmos_signArbitrary",
  ] as const,
  cosmosEvents: ["accountsChanged", "chainChanged"] as const,
} as const;

export const ZUNIA_EXTENSION_IDS = {
  /** Firefox AMO / gecko id */
  gecko: "extension@zuniawallet.com",
} as const;

export const ZUNIA_APP_IDS = {
  androidApplicationId: "com.zuniawallet.zunia_mobile",
  iosBundleId: "com.zuniawallet.zuniaMobile",
} as const;
