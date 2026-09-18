/**
 * The one concrete {@link LcdClient}.
 *
 * Every network read in this package goes through here. Feature modules take
 * the interface, never `fetch`, so all of the awkward parts of talking to a
 * public LCD live in one place: per-attempt timeouts, bounded retries with
 * backoff, ordered endpoint fallback, a small TTL cache, and the host's
 * "live reads" privacy gate.
 *
 * It also owns the one POST path — simulate and broadcast — for the same
 * reason: `fetch` is called here and nowhere else. This module still never
 * signs. It moves bytes that zunia-core already signed.
 */

import {
  InterchainError,
  isInterchainError,
  type ChainInfoLike,
  type JsonObject,
  type LcdClient,
  type LcdClientFactory,
  type LcdRequestOptions,
} from "./types.js";

/** Matches the 9s budget the extension already used, so behaviour is unchanged. */
const DEFAULT_TIMEOUT_MS = 9_000;
/** One extra attempt per endpoint. Public LCDs fail transiently; they also fail hard. */
const DEFAULT_RETRIES = 1;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_MAX_CACHE_ENTRIES = 128;
/** Simulation runs the whole transaction, so it is slower than any read. */
const DEFAULT_POST_TIMEOUT_MS = 15_000;

/**
 * The subset of `fetch` this module uses.
 *
 * Declared structurally so tests can pass a plain function and so we never
 * depend on a DOM or Node specific `fetch` type.
 */
export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/** Construction options for {@link createLcdClient}. */
export interface LcdClientConfig {
  /** Chain this client reads. Reported on every error. */
  readonly chainId: string;
  /**
   * REST base URLs, highest priority first. Trailing slashes are trimmed and
   * duplicates dropped. Must not be empty; see {@link lcdEndpointsFromChain}.
   */
  readonly endpoints: readonly string[];
  /** Per-attempt timeout. Default 9000. */
  readonly timeoutMs?: number;
  /** Extra attempts per endpoint after the first. Default 1. */
  readonly retries?: number;
  /** Default cache TTL. `0` (the default) means no caching unless a call asks. */
  readonly cacheTtlMs?: number;
  /** Cache capacity before the oldest entries are dropped. Default 128. */
  readonly maxCacheEntries?: number;
  /** First backoff delay; doubles per attempt. Default 250. */
  readonly backoffMs?: number;
  /** Per-attempt timeout for {@link LcdPostClient.postJson}. Default 15000. */
  readonly postTimeoutMs?: number;
  /**
   * The host's live-reads gate.
   *
   * The extension only reads chain state when the user has enabled live
   * balances *and* granted the optional host permissions; mobile has the same
   * switch. When this returns false nothing is fetched and the call throws
   * `reads-disabled`, which is a settings prompt in the UI, not an error.
   */
  readonly readsAllowed?: () => boolean | Promise<boolean>;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Injected for tests. Defaults to a `setTimeout` promise. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Extra request headers, merged under `accept: application/json`. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * An {@link LcdClient} that can also POST.
 *
 * Simulation and broadcast are the only writes this package performs and
 * {@link LcdClient} is deliberately read-only, so the capability is a separate
 * port: a host with its own POST-capable transport implements this and passes
 * it to `tx.ts`, and everyone else gets it for free from
 * {@link createLcdClient}.
 *
 * The shape mirrors {@link LcdClient.getJson} — the body comes back as
 * `unknown` and is narrowed by hand.
 */
export interface LcdPostClient extends LcdClient {
  /**
   * POST `body` as JSON and parse the response as JSON.
   *
   * @param path - Path beginning with `/`, e.g. `/cosmos/tx/v1beta1/txs`.
   * @returns The parsed body as `unknown`.
   * @throws {@link InterchainError} `lcd-unreachable` for a transport failure
   *   or a non-2xx response — the node's own `message` field is folded into
   *   {@link Error.message} when it sent one, because that text is the only
   *   description of *why* a simulation was rejected.
   */
  postJson(
    path: string,
    body: JsonObject,
    options?: LcdRequestOptions,
  ): Promise<unknown>;
}

/** An {@link LcdClient} plus POST and the cache controls only the owner needs. */
export interface LcdClientHandle extends LcdPostClient {
  /** Drop every cached body. Call when the user switches network or account. */
  clearCache(): void;
  /** The endpoints in use, after normalisation. Useful in diagnostics. */
  readonly endpoints: readonly string[];
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly body: unknown;
}

function normalizeEndpoints(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * REST base URLs for a chain, highest priority first.
 *
 * Host-supplied `restEndpoints` come before the registry's single `rest`: a
 * host that configured its own node wants it used, and the registry entry is a
 * public fallback.
 *
 * Returns an empty array when the chain has no REST endpoint at all — check
 * this before constructing a client, so features can say "No REST endpoint for
 * this chain" instead of throwing.
 */
export function lcdEndpointsFromChain(chain: ChainInfoLike): string[] {
  return normalizeEndpoints([...(chain.restEndpoints ?? []), chain.rest ?? ""]);
}

function buildPath(path: string, query: LcdRequestOptions["query"]): string {
  const base = path.startsWith("/") ? path : `/${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return base;
  return base.includes("?") ? `${base}&${qs}` : `${base}?${qs}`;
}

/**
 * How to react to an HTTP status.
 *
 * - `retry` — transient. Retry this endpoint, then move on.
 * - `fallback` — this endpoint is unhappy but another may serve the request
 *   (gateway auth, a proxy that 404s everything). Move on without retrying.
 * - `fatal` — the chain answered and the answer is "no". Retrying anywhere
 *   gives the same result, so stop.
 */
function classifyStatus(status: number): "retry" | "fallback" | "fatal" {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return "retry";
  }
  if (status === 401 || status === 403 || status === 404) return "fallback";
  return "fatal";
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}


/* -------------------------------------------------------------------------- *
 * POST transport
 * -------------------------------------------------------------------------- */

/** Shared settings for {@link createPostTransport}. */
interface PostTransportConfig {
  readonly chainId: string;
  readonly endpoints: readonly string[];
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly fetchImpl: FetchLike;
}

/** The gRPC-gateway error shape: `{ code, message, details }`. */
function serverMessage(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "";
  const row = body as Record<string, unknown>;
  const message = row["message"];
  if (typeof message === "string") return message;
  const error = row["error"];
  return typeof error === "string" ? error : "";
}

/**
 * The POST half of the transport, shared by {@link createLcdClient} and
 * {@link createLcdPostClient}.
 *
 * Deliberately thinner than the GET path: endpoints are tried in order, but a
 * failed attempt is never retried against the same endpoint. Broadcasting is
 * not idempotent from the user's point of view — the tx hash is deterministic,
 * so a duplicate submission comes back as `tx already exists in cache` (code
 * 19) rather than spending twice, but presenting that to a user as a failure is
 * worse than simply not retrying.
 *
 * Endpoint fallback is still on and carries the same caveat: if the first
 * endpoint accepted the transaction but the response was lost, the second
 * returns code 19, which `tx.ts` maps to `already-in-mempool` — "sent, now
 * poll", not "failed".
 *
 * There is no live-reads gate here. That switch governs background reads of the
 * user's chain state; broadcasting is an explicit, foreground user action.
 */
function createPostTransport(
  config: PostTransportConfig,
): LcdPostClient["postJson"] {
  const { chainId, endpoints, fetchImpl } = config;

  async function attempt(
    endpoint: string,
    path: string,
    payload: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // Linked by hand rather than with AbortSignal.any, which is not in every
    // browser the extension ships to.
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onCallerAbort);

    try {
      const res = await fetchImpl(`${endpoint}${path}`, {
        method: "POST",
        body: payload,
        signal: controller.signal,
        // No cookies to a third-party node, ever.
        credentials: "omit",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(config.headers ?? {}),
        },
      });

      // Read as text either way: a gRPC-gateway error carries the only
      // explanation of a rejected simulation in its JSON body, and a proxy's
      // HTML error page must become `malformed-response`, not a parse crash.
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch (cause) {
        if (res.ok) {
          throw new InterchainError(
            "malformed-response",
            `${chainId}: ${endpoint} returned a non-JSON body`,
            { chainId, endpoint, httpStatus: res.status, cause },
          );
        }
        parsed = null;
      }

      if (!res.ok) {
        throw new HttpFailure(res.status, endpoint, chainId, serverMessage(parsed));
      }
      return parsed;
    } catch (error) {
      if (signal?.aborted === true) {
        throw new InterchainError("aborted", `${chainId}: request cancelled`, {
          chainId,
          endpoint,
          cause: error,
        });
      }
      if (timedOut || isAbortError(error)) {
        throw new InterchainError(
          "lcd-unreachable",
          `${chainId}: ${endpoint} timed out after ${timeoutMs}ms`,
          { chainId, endpoint, cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  return async function postJson(
    path: string,
    body: JsonObject,
    options: LcdRequestOptions = {},
  ): Promise<unknown> {
    if (options.signal?.aborted === true) {
      throw new InterchainError("aborted", `${chainId}: request cancelled`, {
        chainId,
      });
    }
    const payload = JSON.stringify(body);
    const timeoutMs = options.timeoutMs ?? config.timeoutMs;
    let lastError: InterchainError | undefined;

    for (const endpoint of endpoints) {
      try {
        return await attempt(endpoint, path, payload, timeoutMs, options.signal);
      } catch (error) {
        if (error instanceof HttpFailure) {
          lastError = error.toInterchainError();
          // A 4xx other than the "this gateway is not serving you" statuses is
          // the chain answering "no". Another endpoint answers the same.
          if (classifyStatus(error.status) === "fatal") throw lastError;
        } else if (isInterchainError(error)) {
          if (error.code === "aborted") throw error;
          lastError = error;
        } else {
          lastError = new InterchainError(
            "lcd-unreachable",
            `${chainId}: ${endpoint} is unreachable`,
            { chainId, endpoint, cause: error },
          );
        }
      }
    }

    throw (
      lastError ??
      new InterchainError(
        "lcd-unreachable",
        `${chainId}: no REST endpoint answered`,
        { chainId },
      )
    );
  };
}

/**
 * Create the LCD client for one chain.
 *
 * @throws {@link InterchainError} `unsupported-chain` when no usable endpoint
 *   was supplied.
 */
export function createLcdClient(config: LcdClientConfig): LcdClientHandle {
  const endpoints = normalizeEndpoints(config.endpoints);
  if (endpoints.length === 0) {
    throw new InterchainError(
      "unsupported-chain",
      `No REST endpoint configured for ${config.chainId}`,
      { chainId: config.chainId },
    );
  }

  const chainId = config.chainId;
  const defaultTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultRetries = config.retries ?? DEFAULT_RETRIES;
  const defaultCacheTtlMs = config.cacheTtlMs ?? 0;
  const maxCacheEntries = config.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const backoffMs = config.backoffMs ?? DEFAULT_BACKOFF_MS;
  const doFetch: FetchLike = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = config.now ?? (() => Date.now());
  const sleep =
    config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const cache = new Map<string, CacheEntry>();

  function readCache(key: string): CacheEntry | undefined {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now()) {
      cache.delete(key);
      return undefined;
    }
    return hit;
  }

  function writeCache(key: string, body: unknown, ttlMs: number): void {
    cache.set(key, { expiresAt: now() + ttlMs, body });
    // Insertion order eviction. Not an LRU: these are cheap JSON bodies and a
    // wallet's read pattern is bursty, not long-tailed.
    while (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  async function attempt(
    url: string,
    endpoint: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // Link the caller's signal by hand rather than with AbortSignal.any, which
    // is not in every browser we ship to.
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onCallerAbort);

    try {
      const res = await doFetch(url, {
        method: "GET",
        signal: controller.signal,
        // No cookies to a third-party node, ever.
        credentials: "omit",
        headers: { accept: "application/json", ...(config.headers ?? {}) },
      });

      if (!res.ok) {
        throw new HttpFailure(res.status, endpoint, chainId);
      }

      // Read as text so a proxy's HTML error page becomes a clear
      // `malformed-response` rather than an opaque parse failure.
      const text = await res.text();
      try {
        return JSON.parse(text) as unknown;
      } catch (cause) {
        throw new InterchainError(
          "malformed-response",
          `${chainId}: ${endpoint} returned a non-JSON body`,
          { chainId, endpoint, httpStatus: res.status, cause },
        );
      }
    } catch (error) {
      if (signal?.aborted === true) {
        throw new InterchainError("aborted", `${chainId}: request cancelled`, {
          chainId,
          endpoint,
          cause: error,
        });
      }
      if (timedOut || isAbortError(error)) {
        throw new InterchainError(
          "lcd-unreachable",
          `${chainId}: ${endpoint} timed out after ${timeoutMs}ms`,
          { chainId, endpoint, cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  async function getJson(
    path: string,
    options: LcdRequestOptions = {},
  ): Promise<unknown> {
    if (config.readsAllowed && !(await config.readsAllowed())) {
      throw new InterchainError(
        "reads-disabled",
        `${chainId}: live reads are turned off`,
        { chainId },
      );
    }
    if (options.signal?.aborted === true) {
      throw new InterchainError("aborted", `${chainId}: request cancelled`, {
        chainId,
      });
    }

    const suffix = buildPath(path, options.query);
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const retries = options.retries ?? defaultRetries;
    const ttlMs = options.cacheTtlMs ?? defaultCacheTtlMs;

    // Keyed by the request, not by the endpoint that served it, so a body
    // fetched from a fallback endpoint still satisfies later reads.
    const cacheKey = `${chainId}${suffix}`;
    if (ttlMs > 0) {
      const hit = readCache(cacheKey);
      if (hit) return hit.body;
    }

    let lastError: InterchainError | undefined;

    for (const endpoint of endpoints) {
      for (let tries = 0; tries <= retries; tries++) {
        try {
          const body = await attempt(
            `${endpoint}${suffix}`,
            endpoint,
            timeoutMs,
            options.signal,
          );
          if (ttlMs > 0) writeCache(cacheKey, body, ttlMs);
          return body;
        } catch (error) {
          if (error instanceof HttpFailure) {
            const verdict = classifyStatus(error.status);
            lastError = error.toInterchainError();
            if (verdict === "fatal") throw lastError;
            if (verdict === "fallback") break;
          } else if (error instanceof InterchainError) {
            if (error.code === "aborted") throw error;
            lastError = error;
            // A bad body is the endpoint's fault and will not change on a
            // retry, so move on instead of asking it twice.
            if (error.code === "malformed-response") break;
          } else {
            // Network-level failure: DNS, TLS, connection reset.
            lastError = new InterchainError(
              "lcd-unreachable",
              `${chainId}: ${endpoint} is unreachable`,
              { chainId, endpoint, cause: error },
            );
          }
          if (tries < retries) {
            await sleep(backoffMs * 2 ** tries);
          }
        }
      }
    }

    throw (
      lastError ??
      new InterchainError(
        "lcd-unreachable",
        `${chainId}: no REST endpoint answered`,
        { chainId },
      )
    );
  }

  return {
    chainId,
    endpoints,
    getJson,
    postJson: createPostTransport({
      chainId,
      endpoints,
      timeoutMs: config.postTimeoutMs ?? DEFAULT_POST_TIMEOUT_MS,
      headers: config.headers,
      fetchImpl: doFetch,
    }),
    clearCache: () => cache.clear(),
  };
}

/**
 * Build clients for any chain with one shared configuration.
 *
 * Multi-hop routing touches several chains in one operation; handing modules a
 * factory keeps the timeout, retry and privacy settings identical across them.
 */
export function createLcdClientFactory(
  defaults: Omit<LcdClientConfig, "chainId" | "endpoints"> = {},
): LcdClientFactory {
  const clients = new Map<string, LcdClientHandle>();
  return (chain: ChainInfoLike): LcdClient => {
    const existing = clients.get(chain.chainId);
    if (existing) return existing;
    const created = createLcdClient({
      ...defaults,
      chainId: chain.chainId,
      endpoints: lcdEndpointsFromChain(chain),
    });
    clients.set(chain.chainId, created);
    return created;
  };
}


/** Construction options for {@link createLcdPostClient}. */
export interface LcdPostClientConfig {
  /** Reads are delegated to this client unchanged, cache and retries included. */
  readonly client: LcdClient;
  /**
   * POST base URLs, highest priority first. Usually
   * {@link lcdEndpointsFromChain}(chain).
   */
  readonly endpoints: readonly string[];
  /** Per-attempt timeout. Default 15000 — simulation is slower than a read. */
  readonly timeoutMs?: number;
  /** Extra request headers, merged under `content-type` and `accept`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
}

/**
 * Wrap a read-only client so it can also POST.
 *
 * Only needed when the reader was not built by {@link createLcdClient} — its
 * handle already implements {@link LcdPostClient}. Hosts that hold someone
 * else's `LcdClient` (a cached wrapper, a test stub) use this to bolt the write
 * path on without giving up the read path's cache.
 *
 * @throws {@link InterchainError} `unsupported-chain` when no usable endpoint
 *   was supplied.
 *
 * @example
 * ```ts
 * const post = createLcdPostClient({
 *   client: lcdFactory(chain),
 *   endpoints: lcdEndpointsFromChain(chain),
 * });
 * ```
 */
export function createLcdPostClient(config: LcdPostClientConfig): LcdPostClient {
  const endpoints = normalizeEndpoints(config.endpoints);
  const chainId = config.client.chainId;
  if (endpoints.length === 0) {
    throw new InterchainError(
      "unsupported-chain",
      `No REST endpoint configured for ${chainId}`,
      { chainId },
    );
  }

  return {
    chainId,
    getJson: (path, options) => config.client.getJson(path, options),
    postJson: createPostTransport({
      chainId,
      endpoints,
      timeoutMs: config.timeoutMs ?? DEFAULT_POST_TIMEOUT_MS,
      headers: config.headers,
      fetchImpl: config.fetchImpl ?? ((input, init) => fetch(input, init)),
    }),
  };
}

/**
 * True when a client can POST.
 *
 * Lets a caller hold a plain {@link LcdClient} and only demand the POST port
 * where it is actually needed.
 */
export function isLcdPostClient(value: LcdClient): value is LcdPostClient {
  return typeof (value as { postJson?: unknown }).postJson === "function";
}

/**
 * Internal carrier for a non-2xx response.
 *
 * Kept separate from {@link InterchainError} so the retry loop can see the
 * status before deciding whether to retry, fall back, or give up.
 */
class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly chainId: string,
    /** The gateway's own explanation, when it sent one. `""` for a read. */
    readonly detail: string = "",
  ) {
    super(`HTTP ${status}`);
    this.name = "HttpFailure";
    Object.setPrototypeOf(this, HttpFailure.prototype);
  }

  toInterchainError(): InterchainError {
    const suffix = this.detail ? `: ${this.detail}` : "";
    return new InterchainError(
      "lcd-unreachable",
      `${this.chainId}: ${this.endpoint} returned HTTP ${this.status}${suffix}`,
      { chainId: this.chainId, endpoint: this.endpoint, httpStatus: this.status },
    );
  }
}
