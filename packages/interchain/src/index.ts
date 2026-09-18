/**
 * Public surface of `@zunialab/interchain`.
 *
 * Every export is named. There is no `export *` anywhere in this file, for two
 * reasons: a blanket re-export would publish helpers that only exist because a
 * module's own test imports them, and the Dart mirror in `zunia-mobile` is kept
 * comparable to this file by eye — a name that appears here is a name Dart is
 * expected to have.
 *
 * Symbols deliberately left out are still importable from their module by
 * anything inside this package; they are simply not part of the contract:
 *
 * - `swap.ts`'s low-level response parsers (`parseRouterQuote`,
 *   `parseSpotPrice`, …). They only make sense inside `quoteOsmosisSwap` and
 *   `findOsmosisPools`, and every one of them encodes an Osmosis endpoint quirk
 *   we expect to keep changing.
 * - `nft.ts`'s `smartQueryPath`, `unwrapSmartQueryData` and `addressHasPrefix`.
 *   The first two are the two halves of `smartQuery`, which is exported; the
 *   third is a prefix comparison that `registry.ts` does properly, with a
 *   checksum.
 *
 * The layering, for anyone adding to it: `types.ts` depends on nothing;
 * `lcd.ts`, `base64.ts`, `registry.ts` and `channels.ts` depend only on it;
 * `memo.ts` and `denom.ts` sit above those; `swap.ts` above `memo.ts`; and
 * `route.ts` above all of them. `nft.ts`, `tracking.ts` and `tx.ts` are leaves.
 * There are no cycles and adding one would break the Dart mirror.
 */

/* -------------------------------------------------------------------------- *
 * types.ts — the shared contract
 * -------------------------------------------------------------------------- */

export type {
  AccountInfo,
  BroadcastResult,
  BuiltMsg,
  ChainFeature,
  ChainInfoLike,
  ChainNetwork,
  ChainRegistry,
  Coin,
  DenomHop,
  DenomTrace,
  FeeEstimate,
  GasPriceStep,
  IbcChannelCheck,
  IbcChannelOption,
  IbcChannelState,
  InterchainErrorCode,
  InterchainErrorDetails,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  LcdClient,
  LcdClientFactory,
  LcdRequestOptions,
  NftAttribute,
  NftCollection,
  NftToken,
  NftTransferRequest,
  PacketHopTrace,
  PacketStatus,
  PacketTrace,
  PubKeyInfo,
  ResolvedDenom,
  RouteHop,
  RouteHopKind,
  RoutePlan,
  RouteRequest,
  SwapPoolHop,
  SwapQuote,
  TxStatus,
  TxStatusState,
} from "./types.js";

export { InterchainError, isInterchainError, TRANSFER_PORT } from "./types.js";

/* -------------------------------------------------------------------------- *
 * lcd.ts — the only transport
 * -------------------------------------------------------------------------- */

export type {
  FetchLike,
  LcdClientConfig,
  LcdClientHandle,
  LcdPostClient,
  LcdPostClientConfig,
} from "./lcd.js";
export {
  createLcdClient,
  createLcdClientFactory,
  createLcdPostClient,
  isLcdPostClient,
  lcdEndpointsFromChain,
} from "./lcd.js";

/* -------------------------------------------------------------------------- *
 * base64.ts — encoding, without Buffer
 * -------------------------------------------------------------------------- */

export {
  base64ToJson,
  bytesToUtf8,
  decodeBase64,
  decodeBase64Url,
  decodeBase64UrlUtf8,
  decodeBase64Utf8,
  encodeBase64,
  encodeBase64Url,
  encodeBase64UrlUtf8,
  encodeBase64Utf8,
  jsonToBase64,
  jsonToBase64Url,
  utf8ToBytes,
} from "./base64.js";

/* -------------------------------------------------------------------------- *
 * registry.ts — chain lookup, bech32, and the channel-route cache
 * -------------------------------------------------------------------------- */

export type {
  AddressCheck,
  AddressProblem,
  ChainRegistryHandle,
  ChannelRoute,
  ChannelRouteSource,
  FeatureSupport,
  RouteFilter,
  RouteRegistry,
  RouteRegistryOptions,
  RouteRegistrySnapshot,
} from "./registry.js";
export {
  bech32PrefixOf,
  chainHasFeature,
  checkAddress,
  createChainRegistry,
  createRouteRegistry,
  DEFAULT_ROUTE_MAX_AGE_MS,
  deserializeRouteRegistry,
  featureSupport,
  inferChainsFromAddress,
  isAddressForChain,
  isRouteFresh,
  isValidBech32Address,
  parseChannelRoute,
  routeNeedsVerification,
  SEED_CHANNEL_ROUTES,
} from "./registry.js";

/* -------------------------------------------------------------------------- *
 * channels.ts — transfer-channel discovery and validation
 * -------------------------------------------------------------------------- */

export type {
  ChainRef,
  ChannelMessages,
  ChannelQueryOptions,
  ChannelValidateOptions,
  CounterpartyCheck,
  CounterpartyCheckStatus,
  IbcChannelService,
  IbcChannelServiceConfig,
  IbcChannelValidation,
  InterchainModule,
  ModuleSupport,
  ModuleSupportOverride,
  ModuleSupportStatus,
} from "./channels.js";
export {
  createIbcChannelService,
  DEFAULT_CHANNEL_MESSAGES,
  IBC_HOOKS_PROBE_PATHS,
  normalizeChannelId,
  parseChannelState,
  PFM_PROBE_PATHS,
} from "./channels.js";

/* -------------------------------------------------------------------------- *
 * denom.ts — traces, ibc/HASH, and unwinding
 * -------------------------------------------------------------------------- */

export type {
  ChannelCounterpartyLookup,
  DenomContext,
  DenomRecommendation,
  DenomResolver,
  DenomStrategy,
  DenomTracePage,
  IdentifyDenomsOptions,
  ListDenomTracesOptions,
  OriginProvenance,
  ParseTracePathOptions,
  RecommendDenomOptions,
  ResolvedDenomOnChain,
  ResolveDenomOptions,
  UnwindStep,
} from "./denom.js";
export {
  createDenomResolver,
  ibcDenomHash,
  ibcDenomHashHex,
  ibcHashFromDenom,
  identifyDenoms,
  indexDenomTraces,
  isIbcDenom,
  joinTracePath,
  listDenomTraces,
  originCandidates,
  parseDenomTrace,
  parseDenomTracesPage,
  parseTracePath,
  recommendDenom,
  resolveDenom,
  unwindPath,
} from "./denom.js";

/* -------------------------------------------------------------------------- *
 * memo.ts — PFM, ibc-hooks and crosschain-swap memos
 * -------------------------------------------------------------------------- */

export type {
  ForwardHop,
  ForwardHopInfo,
  ForwardMemoInfo,
  ForwardMemoOptions,
  MemoInspection,
  MemoKind,
  MemoLengthReport,
  MemoLimits,
  ValidateMemoOptions,
  WasmHookInfo,
  XcsFailedDelivery,
  XcsSlippage,
  XcsSwapInfo,
  XcsSwapParams,
} from "./memo.js";
export {
  buildForwardMemo,
  buildForwardMemoJson,
  buildWasmHookMemo,
  buildWasmHookMemoJson,
  buildXcsSwapMemo,
  buildXcsSwapMemoJson,
  checkMemoBytes,
  DEFAULT_PFM_RETRIES,
  DEFAULT_PFM_TIMEOUT,
  isWasmHookReceiverValid,
  MAX_FORWARD_HOPS,
  memoByteLength,
  PACKET_MEMO_MAX_BYTES,
  PFM_INTERMEDIATE_RECEIVER,
  TX_MEMO_MAX_BYTES,
  validateMemo,
  wasmHookReceiver,
} from "./memo.js";

/* -------------------------------------------------------------------------- *
 * route.ts — multi-hop planning
 * -------------------------------------------------------------------------- */

export type {
  ChainCapabilities,
  ChainCapabilityLookup,
  ChannelDirectory,
  ChannelLink,
  ChannelLinkSource,
  CreateChannelDirectoryOptions,
  DenomHasher,
  DenomResolverInput,
  FindRoutePathsOptions,
  PlanRouteOptions,
  RouteDenomResolver,
  RouteDurationModel,
  RouteHopOverride,
  RoutePath,
  RoutePlanCandidate,
  RoutePlannerDeps,
  RoutePlanResult,
  RouteStrategy,
  SwapVenue,
} from "./route.js";
export {
  bestRoutePlan,
  createChannelDirectory,
  DEFAULT_MAX_HOPS,
  findRoutePaths,
  MAX_HOPS_CAP,
  planRoute,
  routeDenomResolver,
} from "./route.js";

/* -------------------------------------------------------------------------- *
 * swap.ts — Osmosis quoting and XCS slippage
 * -------------------------------------------------------------------------- */

export type {
  OsmosisPoolLeg,
  OsmosisPoolRoute,
  OsmosisPoolSearch,
  OsmosisQuoteSource,
  OsmosisRouteLeg,
  OsmosisRouterQuote,
  OsmosisRouteSplit,
  OsmosisSwapPaths,
  OsmosisSwapQuote,
  OsmosisSwapQuoteParams,
  XcsMinOutputSlippage,
  XcsSlippageJson,
  XcsTwapSlippage,
} from "./swap.js";
export {
  applySlippage,
  DEFAULT_SLIPPAGE_PERCENT,
  DEFAULT_TWAP_WINDOW_SECONDS,
  findOsmosisPools,
  minOutputFromQuote,
  OSMOSIS_CHAIN_ID_PREFIXES,
  OSMOSIS_ROUTER_ENDPOINTS,
  OSMOSIS_SWAP_PATHS,
  quoteOsmosisSwap,
  slippageToTwapParams,
  toMemoSlippage,
} from "./swap.js";

/* -------------------------------------------------------------------------- *
 * nft.ts — CW721 and ICS721
 * -------------------------------------------------------------------------- */

export type {
  CollectionInfoOptions,
  CosmWasmGateOptions,
  ExecuteContractParams,
  Ics721TransferOptions,
  NftAllInfoResponse,
  NftApproval,
  NftChainContext,
  NftDiscoveryIssue,
  NftDiscoveryOptions,
  NftDiscoveryResult,
  NftDiscoverySource,
  NftHolding,
  NftIndexer,
  NftInfoResponse,
  NftMetadata,
  NftMetadataFetcher,
  NftMetadataOptions,
  NftMetadataResult,
  NftOwnership,
  NftQueryOptions,
  NftTokenIdList,
  NftTokenIdListOptions,
  NftTokenIdPage,
  NftTokenIdPageOptions,
  ResolvedTokenUri,
  ResolveTokenUriOptions,
  SendNftParams,
  TransferNftParams,
} from "./nft.js";
export {
  applyNftMetadata,
  assertCosmWasmChain,
  buildExecuteContractMsg,
  buildIcs721TransferMsg,
  buildNftTransferMsg,
  buildSendNftMsg,
  buildTransferNftMsg,
  DEFAULT_ICS721_TIMEOUT_MINUTES,
  DEFAULT_TOKEN_PAGE_LIMIT,
  discoverNfts,
  fetchNftMetadata,
  getAllNftInfo,
  getCollectionInfo,
  getNftInfo,
  getNftToken,
  getNumTokens,
  getOwnerOf,
  ICS721_VOUCHER_WARNING,
  ics721TransferWarnings,
  listAllOwnedTokenIds,
  listAllTokenIds,
  listOwnedTokenIds,
  NFT_DISCOVERY_LIMITATION,
  parseNftMetadata,
  resolveTokenUri,
  smartQuery,
  supportsCosmWasm,
  supportsIcs721,
} from "./nft.js";

/* -------------------------------------------------------------------------- *
 * tracking.ts — packet status for a transfer already signed
 * -------------------------------------------------------------------------- */

export type {
  DecodedTxEvent,
  ExtractedPacket,
  HopTimingProfile,
  IbcTransferSummary,
  Ics20PacketData,
  LcdResolver,
  PacketAck,
  PacketEndpoints,
  PacketFailureKind,
  PacketRef,
  PacketStatusOptions,
  PacketStatusReport,
  RouteHopTrace,
  RouteTrace,
  StallCheck,
  TrackRouteOptions,
  XcsRecovery,
  XcsRecoverRequest,
} from "./tracking.js";
export {
  buildXcsRecoverMsg,
  createLcdResolver,
  decodeTxEvents,
  DEFAULT_HOP_TIMING,
  estimateHopSeconds,
  estimateRouteSeconds,
  extractPacketsFromTx,
  getPacketStatus,
  hopStallThresholdSeconds,
  isHopStalled,
  isTerminalPacketStatus,
  parseIcs20PacketData,
  parsePacketAcknowledgement,
  trackRoute,
  XCS_RECOVER_EXECUTE_MSG,
} from "./tracking.js";

/* -------------------------------------------------------------------------- *
 * tx.ts — everything around signing, and none of signing
 * -------------------------------------------------------------------------- */

export type {
  BroadcastMode,
  BroadcastOptions,
  FeeEstimateOptions,
  FeeSpeed,
  GetAccountOptions,
  SignModeName,
  SimulateOptions,
  TxBroadcast,
  TxFailure,
  TxFailureKind,
  TxStatusOptions,
  UnsignedTxBody,
  UnsignedTxFee,
  UnsignedTxMsg,
  UnsignedTxRequest,
  UnsignedTxRequestInput,
  UnsignedTxSigner,
  WaitForTxOptions,
} from "./tx.js";
export {
  broadcast,
  buildUnsignedTxRequest,
  classifyTxFailure,
  DEFAULT_GAS_ADJUSTMENT,
  estimateFee,
  getAccount,
  getTxStatus,
  isEthSecp256k1PubKey,
  isTxRejectedError,
  parseAccount,
  parseBroadcastResponse,
  parseTxStatus,
  simulate,
  TxRejectedError,
  waitForTx,
} from "./tx.js";
