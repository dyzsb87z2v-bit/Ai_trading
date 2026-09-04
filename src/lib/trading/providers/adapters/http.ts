/**
 * Shared HTTP plumbing for provider adapters.
 *
 * Every adapter needs the same failure taxonomy, and duplicating it per vendor
 * is how one adapter ends up silently returning `null` where another returns an
 * error. Centralising it means "we could not get this" is expressed identically
 * everywhere, and `fetchImpl` injection makes every adapter offline-testable.
 */

import { available, unavailable, type Availability } from "../../types";

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface HttpClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.headers = options.headers ?? {};
  }

  async getJson<T>(path: string): Promise<Availability<T>> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: this.headers,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      return unavailable("NETWORK_ERROR", `Request failed: ${reason}`);
    }

    if (response.status === 429) {
      return unavailable("RATE_LIMITED", "Rate limit hit — back off before retrying.");
    }
    if (response.status === 401 || response.status === 403) {
      // Never echo the key or the URL: both can carry the credential.
      return unavailable(
        "UNAUTHORIZED",
        "The provider rejected the credentials. Check the API key in .env."
      );
    }
    if (!response.ok) {
      return unavailable("HTTP_ERROR", `Provider responded with HTTP ${response.status}.`);
    }

    const payload = await response.json().catch(() => null);
    if (payload === null) {
      return unavailable("MALFORMED_RESPONSE", "Provider returned a body that is not valid JSON.");
    }
    return available(payload as T);
  }
}

/** Parse a value that a JSON API may deliver as either a number or a string. */
export function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse an ISO date or epoch value into epoch ms, or null. */
export function epochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: a 10-digit value is seconds, 13 is milliseconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
