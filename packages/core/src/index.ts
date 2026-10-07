export type {
  AccountData,
  Algo,
  AminoMsg,
  AminoSignResponse,
  Coin,
  DirectSignResponse,
  SignDoc,
  SignDocInput,
  StdFee,
  StdSignDoc,
  StdSignature,
  ZuniaKey,
  ZuniaOfflineSigner,
  ZuniaProvider,
  ZuniaProviderError,
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

export {
  ZUNIA_PROVIDER_ERROR_CODES,
  ZuniaConnectError,
  ZuniaSignInError,
  explainZuniaError,
  isZuniaProviderErrorCode,
  toZuniaConnectError,
} from "./errors.js";
export type {
  ZuniaConnectErrorCode,
  ZuniaErrorExplanation,
  ZuniaErrorReason,
  ZuniaProviderErrorCode,
  ZuniaSignInErrorCode,
} from "./errors.js";

export {
  ZUNIA_SIGNING_FEATURES,
  aminoNeedsEscaping,
  zuniaCapabilities,
  zuniaSignMode,
} from "./signing.js";
export type { SignableMessage, ZuniaCapabilities, ZuniaSignModeInput } from "./signing.js";

export {
  SIGN_IN_LIMITS,
  buildSignInMessage,
  checkSignInBinding,
  createNonce,
  looksLikeSignIn,
  parseSignInMessage,
} from "./sign-in.js";
export type { SignInBinding, SignInFields, SignInMessage } from "./sign-in.js";

export {
  adr36SignDoc,
  checkAminoSignature,
  pubkeyToAddress,
  serializeAminoSignDoc,
  verifyAdr36Signature,
  verifySignIn,
} from "./verify.js";
export type { AminoSignatureCheck, VerifiedSignIn, VerifySignInOptions } from "./verify.js";

export {
  CONNECT_V2,
  ConnectCipher,
  connectKeyPairFromSecret,
  connectTranscript,
  decryptFrame,
  deriveConnectKeys,
  encryptFrame,
  frameAad,
  generateConnectKeyPair,
  verificationCodeFrom,
} from "./connect-crypto.js";
export type {
  ConnectCipherState,
  ConnectEnvelope,
  ConnectKeyPair,
  ConnectRole,
  ConnectSessionKeys,
  SealedFrame,
} from "./connect-crypto.js";

export {
  ZUNIA_CONNECT_CLOSE_CODES,
  ZUNIA_CONNECT_PATHS,
  ZUNIA_CONNECT_PROTOCOL,
  ZUNIA_CONNECT_TOKEN_PROTOCOL_PREFIX,
  buildPairingUri,
  parsePairingUri,
} from "./protocol.js";
export type {
  CreateConnectSessionResponse,
  DappMessage,
  RelayClientFrame,
  RelayErrorCode,
  RelayServerFrame,
  SessionEndReason,
  WalletMessage,
  WireAccount,
  WireSignResults,
  ZuniaDappMetadata,
  ZuniaPairingUri,
} from "./protocol.js";

export { normalizeChainIds } from "./session.js";
export type {
  ConnectOptions,
  RestoreOptions,
  SignerForOptions,
  SignInOptions,
  SignInResult,
  SuggestedChain,
  ZuniaAccountInfo,
  ZuniaPairing,
  ZuniaSession,
  ZuniaSessionEvents,
  ZuniaSessionStatus,
  ZuniaStorage,
  ZuniaTransport,
  ZuniaTransportKind,
} from "./session.js";

export {
  accountFromKey,
  accountFromWire,
  accountNumberToString,
  accountToWire,
  keyFromAccount,
  normalizeAlgo,
  normalizeAminoResponse,
  normalizeDirectResponse,
  normalizeStdSignature,
} from "./normalize.js";

export {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  bytesToUtf8,
  toBytes,
  utf8ToBytes,
} from "./encoding.js";
