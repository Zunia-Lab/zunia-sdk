/** Canonical connect / WalletConnect constants shared by web + mobile SDKs. */

export const ZUNIA_WALLET = {
  name: "Zunia",
  shortName: "Zunia",
  url: "https://zuniawallet.com",
  docsUrl: "https://docs.zuniawallet.com",
  icons: [
    "https://raw.githubusercontent.com/Zunia-Lab/zunia-brand/main/png/icons/app/zunia-icon-512.png",
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

/** Shared tokens for the official Connect with Zunia button (web + mobile). */
export const ZUNIA_CONNECT_BUTTON = {
  label: "Connect with Zunia",
  installLabel: "Install Zunia",
  installUrl: "https://zuniawallet.com",
  fontFamily: "'Space Grotesk', system-ui, -apple-system, sans-serif",
  fg: "#FFFFFF",
  bg: "linear-gradient(120deg, #FF1B0C 0%, #FF6A10 50%, #FFC414 100%)",
  bgHover: "linear-gradient(120deg, #FF4E12 0%, #FF8A17 50%, #FFBE14 100%)",
  bgActive: "linear-gradient(120deg, #D42800 0%, #FF4E12 55%, #FF8A17 100%)",
  mark: "#FFFFFF",
  gradient: "linear-gradient(120deg, #FF1B0C 0%, #FF6A10 50%, #FFC414 100%)",
  glow: "0 12px 28px rgba(255, 45, 31, 0.28)",
  radius: "14px",
  start: "#FF1B0C",
  end: "#FFC414",
} as const;
