import { USER_AGENT } from "./version.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class UpstreamError extends Error {
  constructor(
    readonly url: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface GetJsonOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * GET a JSON document from one of the fixed upstreams (docs site, npm, chain
 * registry). Resolves `null` on 404, so a missing package or chain can be
 * cached like any answer.
 */
export async function getJson(url: string, options: GetJsonOptions = {}): Promise<unknown> {
  const { fetch: fetchImpl = fetch, timeoutMs = 10_000, maxBytes = 8_000_000 } = options;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new UpstreamError(url, `Could not reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new UpstreamError(url, `${new URL(url).host} answered HTTP ${response.status}`, response.status);
  const text = await response.text();
  if (text.length > maxBytes) throw new UpstreamError(url, `${url} is larger than ${maxBytes} bytes`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpstreamError(url, `${url} did not return JSON`);
  }
}
