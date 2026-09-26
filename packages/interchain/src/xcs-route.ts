/**
 * The route the deployed crosschain-swaps contract will actually execute.
 *
 * Osmosis SQS can price a path the swaprouter contract has never been told
 * about. The contract then rejects the packet (`No route found`) and the
 * escrow sends the funds back. A quote that ignores the contract's table
 * shows a price for a swap that cannot happen.
 *
 * Crosschain-swaps v1.2 (the contract this wallet targets) stores the
 * swaprouter address under the raw key `config` and executes
 * `swap_contract.get_route`. It does not accept a route in the memo, so a
 * path SQS invented cannot be injected at sign time. The only honest quote
 * is the one `get_route` returns.
 */

import { base64ToJson, encodeBase64Utf8, jsonToBase64Url } from "./base64.js";
import {
  InterchainError,
  isInterchainError,
  type JsonObject,
  type LcdClient,
  type LcdRequestOptions,
  type SwapPoolHop,
} from "./types.js";

/** What {@link readXcsExecutableRoute} found. */
export type XcsRouteRead =
  | {
      readonly status: "ready";
      readonly swapContract: string;
      readonly route: readonly SwapPoolHop[];
    }
  | { readonly status: "missing"; readonly swapContract: string | null }
  | { readonly status: "unreadable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bech32-ish, without pulling the checksum checker into this read. */
function looksLikeAddress(value: string): boolean {
  return /^[a-z0-9]+1[a-z0-9]{20,}$/.test(value);
}

/**
 * `swap_contract` from a crosschain-swaps `config` value.
 *
 * @returns The address, or `null` when the body is not that config.
 */
export function parseXcsSwapContract(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const address = data.swap_contract;
  if (typeof address !== "string" || !looksLikeAddress(address)) return null;
  return address;
}

/**
 * `pool_route` from a swaprouter `get_route` reply.
 *
 * @returns The hops, or `null` when the reply is not a non-empty route whose
 *   last hop pays `outputDenom`.
 */
export function parseXcsPoolRoute(data: unknown, outputDenom: string): readonly SwapPoolHop[] | null {
  if (!isRecord(data)) return null;
  const rows = data.pool_route;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const hops: SwapPoolHop[] = [];
  for (const row of rows) {
    if (!isRecord(row)) return null;
    const poolId = row.pool_id;
    const tokenOut = row.token_out_denom;
    const id = typeof poolId === "number" ? String(poolId) : poolId;
    if (typeof id !== "string" || !/^[1-9]\d*$/.test(id)) return null;
    if (typeof tokenOut !== "string" || tokenOut.length === 0) return null;
    hops.push({ poolId: id, tokenOutDenom: tokenOut });
  }
  const last = hops[hops.length - 1];
  if (last === undefined || last.tokenOutDenom !== outputDenom) return null;
  return hops;
}

function rawConfigPath(contract: string): string {
  // The key is the raw bytes of the word `config`, not a JSON string.
  const key = encodeBase64Utf8("config");
  return `/cosmwasm/wasm/v1/contract/${encodeURIComponent(contract)}/raw/${encodeURIComponent(key)}`;
}

function routeQueryPath(contract: string, inputDenom: string, outputDenom: string): string {
  const query: JsonObject = {
    get_route: { input_denom: inputDenom, output_denom: outputDenom },
  };
  return `/cosmwasm/wasm/v1/contract/${encodeURIComponent(contract)}/smart/${jsonToBase64Url(query)}`;
}

/**
 * wasmd answers a missing `get_route` entry with HTTP 500 and
 * `Vec<SwapAmountInRoute> not found`. Anything else (timeout, 403, a body we
 * cannot read) is "we do not know", which the host must also fail closed on,
 * but with different copy.
 */
function classifyRouteError(error: unknown): "missing" | "unreadable" {
  if (!isInterchainError(error)) return "unreadable";
  if (error.code === "aborted" || error.code === "reads-disabled") throw error;
  const text = error.message.toLowerCase();
  if (text.includes("not found") || text.includes("no route")) return "missing";
  return "unreadable";
}

function unwrapData(body: unknown, chainId: string): unknown {
  if (!isRecord(body) || !("data" in body)) {
    throw new InterchainError("malformed-response", `${chainId}: contract query has no data`, {
      chainId,
    });
  }
  const data = body.data;
  if (typeof data === "string") return base64ToJson(data);
  if (data === null || data === undefined) {
    throw new InterchainError("malformed-response", `${chainId}: contract query returned empty data`, {
      chainId,
    });
  }
  return data;
}

/**
 * Read the route the crosschain-swaps contract will execute for this pair.
 *
 * Never invents a path. `missing` means the swaprouter table has no entry
 * (or the query said so). `unreadable` means the check itself failed.
 *
 * @throws {@link InterchainError} `aborted` or `reads-disabled` unchanged, so
 *   a cancelled requote and a reads-off setting keep their own copy.
 */
export async function readXcsExecutableRoute(
  lcd: LcdClient,
  xcsContract: string,
  inputDenom: string,
  outputDenom: string,
  options: LcdRequestOptions = {},
): Promise<XcsRouteRead> {
  const contract = xcsContract.trim();
  if (!looksLikeAddress(contract) || !inputDenom || !outputDenom) {
    return { status: "unreadable" };
  }
  const request: LcdRequestOptions = {
    ...options,
    retries: options.retries ?? 0,
    timeoutMs: options.timeoutMs ?? 8_000,
    cacheTtlMs: options.cacheTtlMs ?? 60_000,
  };

  let swapContract: string | null = null;
  try {
    const body = await lcd.getJson(rawConfigPath(contract), request);
    swapContract = parseXcsSwapContract(unwrapData(body, lcd.chainId));
  } catch (error) {
    if (isInterchainError(error) && (error.code === "aborted" || error.code === "reads-disabled")) {
      throw error;
    }
    return { status: "unreadable" };
  }
  if (!swapContract) return { status: "unreadable" };

  try {
    const body = await lcd.getJson(routeQueryPath(swapContract, inputDenom, outputDenom), request);
    const route = parseXcsPoolRoute(unwrapData(body, lcd.chainId), outputDenom);
    if (!route) return { status: "missing", swapContract };
    return { status: "ready", swapContract, route };
  } catch (error) {
    const status = classifyRouteError(error);
    if (status === "missing") return { status: "missing", swapContract };
    return { status: "unreadable" };
  }
}
