export {
  ZUNIA_INITIALIZED_EVENT,
  enableZunia,
  getZunia,
  getZuniaSync,
  isZuniaInstalled,
  waitForZuniaInitialized,
} from "./detect.js";
export type { GetZuniaOptions } from "./detect.js";

export {
  ZuniaSessionImpl,
  connectWithZunia,
  createExtensionSession,
  createWalletConnectSession,
  createZuniaSession,
  createZuniaWsSession,
  restoreSession,
} from "./session.js";
export type { ZuniaSessionOptions, ZuniaSessionSnapshot } from "./session.js";

export { ExtensionTransport } from "./transports/extension.js";
export type { ExtensionTransportOptions } from "./transports/extension.js";
export { NativeWsTransport } from "./transports/native-ws.js";
export type { NativeWsTransportOptions } from "./transports/native-ws.js";
export { WalletConnectTransport } from "./transports/walletconnect.js";
export type {
  WalletConnectClient,
  WalletConnectClientFactory,
  WalletConnectSession,
  ZuniaWebConnectOptions,
  ZuniaWebRestoreOptions,
} from "./transports/walletconnect.js";

export { STORAGE_KEYS } from "./storage.js";
export { qrMatrix, renderQrSvg } from "./qr.js";
export type { QrSvgOptions } from "./qr.js";

export { ZUNIA_MARK_SVG } from "./mark.js";
export { createConnectWithZuniaButton, ensureConnectButtonStyles } from "./connect-button.js";
export type { ConnectWithZuniaSize, CreateConnectWithZuniaButtonOptions } from "./connect-button.js";

export {
  ZUNIA_CONNECT_BUTTON,
  ZUNIA_DEEP_LINKS,
  ZUNIA_NATIVE_CONNECT,
  ZUNIA_PROVIDER_GLOBAL,
  ZUNIA_WALLET,
  ZUNIA_WALLETCONNECT,
  ZuniaConnectError,
  createNonce,
} from "@zunialab/sdk-core";
export type {
  AccountData,
  AminoSignResponse,
  ConnectOptions,
  DirectSignResponse,
  RestoreOptions,
  SignInOptions,
  SignInResult,
  StdSignDoc,
  StdSignature,
  ZuniaAccountInfo,
  ZuniaConnectErrorCode,
  ZuniaKey,
  ZuniaOfflineSigner,
  ZuniaPairing,
  ZuniaProvider,
  ZuniaSession,
  ZuniaSessionEvents,
  ZuniaSessionStatus,
  ZuniaStorage,
  ZuniaTransportKind,
} from "@zunialab/sdk-core";
