import { TtlCache } from "./cache.js";
import { type FetchLike, getJson } from "./fetch.js";

/**
 * Chains from the Zunia chain registry, the catalogue the wallets ship with
 * (https://github.com/Zunia-Lab/zunia-chain-registry). A Cosmos chain's file
 * is its chain id without the revision suffix: `osmosis-1` is `cosmos/osmosis.json`.
 */

export const CHAIN_REGISTRY_REPO = "https://github.com/Zunia-Lab/zunia-chain-registry";
const RAW = "https://raw.githubusercontent.com/Zunia-Lab/zunia-chain-registry/main";
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export interface Currency {
  coinDenom: string;
  coinMinimalDenom: string;
  coinDecimals: number;
  coinGeckoId?: string;
}

/** The fields of a registry entry this server reads. The file has more. */
export interface RegistryChain {
  chainId: string;
  chainName: string;
  rpc?: string;
  rest?: string;
  bip44?: { coinType: number };
  bech32Config?: { bech32PrefixAccAddr: string; bech32PrefixValAddr?: string };
  stakeCurrency?: Currency;
  currencies?: Currency[];
  feeCurrencies?: (Currency & { gasPriceStep?: { low: number; average: number; high: number } })[];
  features?: string[];
  [field: string]: unknown;
}

export interface ChainLookup {
  chain: RegistryChain;
  /** Path in the registry repo, e.g. `cosmos/osmosis.json`. */
  path: string;
  rawUrl: string;
  githubUrl: string;
}

/** Registry files to try for one input, best guess first. */
export function chainCandidates(input: string): string[] {
  const id = input.trim();
  if (!SAFE.test(id) || id.includes("..")) return [];
  if (/^eip155:\d+$/.test(id)) return [`evm/${id}.json`];
  if (/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) return [`svm/${id}.json`];
  if (id.includes(":")) return [];
  const names = [/^(.+)-(\d+)$/.exec(id)?.[1], id, id.toLowerCase()].filter((name): name is string => Boolean(name));
  return [...new Set(names)].map((name) => `cosmos/${name}.json`);
}

export class ChainRegistry {
  private readonly cache: TtlCache<ChainLookup | null>;

  constructor(private readonly options: { fetch?: FetchLike; ttlMs?: number } = {}) {
    this.cache = new TtlCache(options.ttlMs ?? 60 * 60_000);
  }

  /** The entry for a chain id (`osmosis-1`), a registry name (`osmosis`) or a CAIP-2 id (`eip155:1`); `null` when absent. */
  async find(input: string): Promise<{ lookup: ChainLookup | null; tried: string[] }> {
    const tried = chainCandidates(input);
    for (const path of tried) {
      const { value } = await this.cache.get(path, async () => {
        const rawUrl = `${RAW}/${path}`;
        const chain = (await getJson(rawUrl, { fetch: this.options.fetch })) as RegistryChain | null;
        if (!chain || typeof chain.chainId !== "string") return null;
        return { chain, path, rawUrl, githubUrl: `${CHAIN_REGISTRY_REPO}/blob/main/${path}` };
      });
      if (value) return { lookup: value, tried };
    }
    return { lookup: null, tried };
  }
}

/** What a dApp needs to know about a chain, without the full currency list. */
export function summarizeChain(lookup: ChainLookup): Record<string, unknown> {
  const { chain } = lookup;
  const currencies = chain.currencies ?? [];
  return {
    chainId: chain.chainId,
    chainName: chain.chainName,
    rpc: chain.rpc,
    rest: chain.rest,
    coinType: chain.bip44?.coinType,
    bech32Prefix: chain.bech32Config?.bech32PrefixAccAddr,
    stakeCurrency: chain.stakeCurrency,
    feeCurrencies: chain.feeCurrencies,
    features: chain.features ?? [],
    currencyCount: currencies.length,
    currencies: currencies.slice(0, 10).map(({ coinDenom, coinMinimalDenom, coinDecimals }) => ({ coinDenom, coinMinimalDenom, coinDecimals })),
    registryFile: lookup.githubUrl,
    rawJson: lookup.rawUrl,
  };
}
