export {
  getZuniaSync,
  getZunia,
  enableZunia,
  isZuniaInstalled,
} from "./detect.js";
export type { GetZuniaOptions } from "./detect.js";

export { ZUNIA_MARK_SVG } from "./mark.js";
export {
  createConnectWithZuniaButton,
  ensureConnectButtonStyles,
} from "./connect-button.js";
export type {
  ConnectWithZuniaSize,
  CreateConnectWithZuniaButtonOptions,
} from "./connect-button.js";

export {
  connectWithZunia,
  createExtensionSession,
  createZuniaWsSession,
  createWalletConnectSession,
  waitForZuniaInitialized,
  ExtensionTransport,
  NativeWsTransport,
  WalletConnectTransport,
  ZuniaSessionImpl,
} from "./session.js";

export {
  ZUNIA_WALLET,
  ZUNIA_DEEP_LINKS,
  ZUNIA_WALLETCONNECT,
  ZUNIA_NATIVE_CONNECT,
  ZUNIA_PROVIDER_GLOBAL,
  ZUNIA_CONNECT_BUTTON,
  ZuniaConnectError,
} from "@zunialab/sdk-core";

export type {
  ZuniaProvider,
  ZuniaOfflineSigner,
  ZuniaKey,
  ZuniaSession,
  ConnectOptions,
  ZuniaSessionStatus,
  ZuniaTransportKind,
} from "@zunialab/sdk-core";
