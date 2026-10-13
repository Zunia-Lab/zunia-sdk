import { TtlCache } from "./cache.js";
import { type FetchLike, getJson } from "./fetch.js";

/**
 * The Zunia packages on npm, read live from the registry: what `latest` is,
 * when it was published and what it asks of the app. The descriptions are the
 * packages' own, so they match the version they describe.
 */

export const ZUNIA_PACKAGES = [
  "@zunialab/sdk-web",
  "@zunialab/sdk-react",
  "@zunialab/sdk-core",
  "@zunialab/interchain",
  "@zunialab/mcp",
] as const;

const NAME = /^@zunialab\/[a-z0-9][a-z0-9-]{0,63}$/;

export interface PackageInfo {
  name: string;
  /** False when npm does not know the package (yet). */
  published: boolean;
  latest?: string;
  publishedAt?: string;
  description?: string;
  peerDependencies?: Record<string, string>;
  optionalPeers?: string[];
  npm: string;
}

interface Packument {
  description?: string;
  "dist-tags"?: { latest?: string };
  time?: Record<string, string>;
  versions?: Record<
    string,
    { description?: string; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }
  >;
}

export class NpmRegistry {
  private readonly cache: TtlCache<PackageInfo>;

  constructor(
    private readonly options: { fetch?: FetchLike; registry?: string; ttlMs?: number } = {},
  ) {
    this.cache = new TtlCache(options.ttlMs ?? 10 * 60_000);
  }

  async get(name: string): Promise<PackageInfo> {
    if (!NAME.test(name)) throw new Error(`${name} is not a @zunialab package name`);
    const registry = (this.options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
    const { value } = await this.cache.get(name, async () => {
      const body = (await getJson(`${registry}/${name.replace("/", "%2F")}`, { fetch: this.options.fetch })) as Packument | null;
      const npm = `https://www.npmjs.com/package/${name}`;
      const latest = body?.["dist-tags"]?.latest;
      if (!body || !latest) return { name, published: false, npm };
      const manifest = body.versions?.[latest];
      const meta = manifest?.peerDependenciesMeta ?? {};
      return {
        name,
        published: true,
        latest,
        publishedAt: body.time?.[latest],
        description: manifest?.description ?? body.description,
        peerDependencies: manifest?.peerDependencies,
        optionalPeers: Object.keys(meta).filter((peer) => meta[peer]?.optional),
        npm,
      };
    });
    return value;
  }

  /** Several packages at once; one that cannot be read is reported, not thrown. */
  async getMany(names: readonly string[]): Promise<(PackageInfo | { name: string; error: string })[]> {
    return Promise.all(
      names.map((name) =>
        this.get(name).catch((error: unknown) => ({ name, error: error instanceof Error ? error.message : String(error) })),
      ),
    );
  }
}

/** One install line for a set of packages and their required peers. */
export function installCommand(packages: readonly PackageInfo[]): string {
  const names = new Set(packages.filter((info) => info.published).map((info) => info.name));
  for (const info of packages) {
    for (const peer of Object.keys(info.peerDependencies ?? {})) {
      if (!info.optionalPeers?.includes(peer) && !peer.startsWith("@zunialab/") && peer !== "react") names.add(peer);
    }
  }
  return names.size ? `npm install ${[...names].join(" ")}` : "";
}
