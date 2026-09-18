export type {
  ZuniaAccount,
  ZuniaKey,
  ZuniaOfflineSigner,
  ZuniaProvider,
  ZuniaProviderEvent,
} from "./types.js";

export {
  ZUNIA_WALLET,
  ZUNIA_PROVIDER_GLOBAL,
  ZUNIA_KEPLR_ALIAS_GLOBAL,
  ZUNIA_DEEP_LINKS,
  ZUNIA_WALLETCONNECT,
  ZUNIA_NATIVE_CONNECT,
  ZUNIA_EXTENSION_IDS,
  ZUNIA_APP_IDS,
  ZUNIA_CONNECT_BUTTON,
} from "./constants.js";

export { ZuniaConnectError } from "./errors.js";
export type { ZuniaConnectErrorCode } from "./errors.js";

export {
  ZUNIA_CONNECT_PROTOCOL_VERSION,
  createEnvelope,
} from "./protocol.js";
export type {
  ZuniaConnectRole,
  ZuniaConnectMessageType,
  ZuniaConnectEnvelope,
  ZuniaConnectAccount,
  ZuniaDappMetadata,
  HelloPayload,
  HelloOkPayload,
  ConnectRequestPayload,
  ConnectApprovePayload,
  ConnectRejectPayload,
  SignAminoPayload,
  SignDirectPayload,
  SignArbitraryPayload,
  SignResultPayload,
  SignRejectPayload,
  DisconnectPayload,
  ErrorPayload,
  CreateConnectSessionRequest,
  CreateConnectSessionResponse,
} from "./protocol.js";

export {
  normalizeChainIds,
  accountsFromKey,
  toZuniaAccounts,
} from "./session.js";
export type {
  ZuniaTransportKind,
  ZuniaSessionStatus,
  ConnectOptions,
  ZuniaSessionAccount,
  ZuniaSessionEvents,
  ZuniaTransport,
  ZuniaSession,
} from "./session.js";
