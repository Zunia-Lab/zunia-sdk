import { TtlCache } from "./cache.js";
import { type FetchLike, getJson } from "./fetch.js";

/**
 * The Zunia packages on pub.dev (Flutter), read live like the npm ones: what
 * `latest` is, when it was published and which Dart and Flutter it needs.
 */

export const ZUNIA_PUB_PACKAGES = ["zunia_sdk"] as const;

const NAME = /^zunia_[a-z0-9_]{1,60}$/;

export interface PubPackageInfo {
  name: string;
  /** False when pub.dev does not know the package (yet). */
  published: boolean;
  latest?: string;
  publishedAt?: string;
  description?: string;
  /** The `environment` constraints of the latest version, e.g. `{ sdk: "^3.6.0", flutter: ">=3.27.0" }`. */
  environment?: Record<string, string>;
  pub: string;
}

interface PubPackage {
  latest?: {
    version?: string;
    published?: string;
    pubspec?: { description?: string; environment?: Record<string, string> };
  };
}

export class PubRegistry {
  private readonly cache: TtlCache<PubPackageInfo>;

  constructor(private readonly options: { fetch?: FetchLike; registry?: string; ttlMs?: number } = {}) {
    this.cache = new TtlCache(options.ttlMs ?? 10 * 60_000);
  }

  async get(name: string): Promise<PubPackageInfo> {
    if (!NAME.test(name)) throw new Error(`${name} is not a Zunia pub.dev package name`);
    const registry = (this.options.registry ?? "https://pub.dev").replace(/\/+$/, "");
    const { value } = await this.cache.get(name, async () => {
      const body = (await getJson(`${registry}/api/packages/${name}`, { fetch: this.options.fetch })) as PubPackage | null;
      const pub = `https://pub.dev/packages/${name}`;
      const latest = body?.latest;
      if (!latest?.version) return { name, published: false, pub };
      return {
        name,
        published: true,
        latest: latest.version,
        publishedAt: latest.published,
        description: latest.pubspec?.description?.replace(/\s+/g, " ").trim(),
        environment: latest.pubspec?.environment,
        pub,
      };
    });
    return value;
  }

  /** Several packages at once; one that cannot be read is reported, not thrown. */
  async getMany(names: readonly string[]): Promise<(PubPackageInfo | { name: string; error: string })[]> {
    return Promise.all(
      names.map((name) =>
        this.get(name).catch((error: unknown) => ({ name, error: error instanceof Error ? error.message : String(error) })),
      ),
    );
  }
}

/** One line per package for a tool answer. */
export function pubPackageLine(info: PubPackageInfo | { name: string; error: string }): string {
  if ("error" in info) return `- ${info.name}: pub.dev could not be read (${info.error})`;
  if (!info.published) return `- ${info.name}: not on pub.dev yet`;
  const date = info.publishedAt ? `, published ${info.publishedAt.slice(0, 10)}` : "";
  const env = Object.entries(info.environment ?? {})
    .map(([key, range]) => `${key === "sdk" ? "Dart" : key === "flutter" ? "Flutter" : key} ${range}`)
    .join(", ");
  return `- ${info.name} ${info.latest}${date}: ${info.description ?? ""}${env ? `\n  Needs ${env}` : ""}\n  Install: \`flutter pub add ${info.name}\`\n  ${info.pub}`;
}
