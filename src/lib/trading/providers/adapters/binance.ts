/**
 * Binance market-data adapter (crypto spot).
 *
 * Chosen as the first real adapter because its public market-data endpoints
 * need no API key, so the terminal can show genuine prices with zero setup.
 *
 * Endpoints used (Binance public REST, documented at
 * https://developers.binance.com/docs/binance-spot-api-docs):
 *   GET /api/v3/klines             candles
 *   GET /api/v3/ticker/24hr        last price, volume, change, VWAP
 *   GET /api/v3/ticker/bookTicker  best bid/ask
 *   GET /api/v3/exchangeInfo       symbol search
 *
 * Design constraints this adapter honours:
 *  - It never synthesises a value. Any failure returns `unavailable(...)` with
 *    a reason, so the caller renders DATA SOURCE UNAVAILABLE rather than a gap
 *    filled with zeros.
 *  - Symbols are passed through VERBATIM. Silently rewriting "BTCUSD" to
 *    "BTCUSDT" would label one instrument's data with another's name; instead
 *    an unknown symbol produces an error that says how Binance names things.
 *  - `fetchImpl` is injectable so the mapping and error handling are unit
 *    tested without network access.
 */

import {
  available,
  unavailable,
  type AssetClass,
  type Availability,
  type Candle,
  type CandleSeries,
  type Instrument,
  type Quote,
  type Timeframe,
} from "../../types";
import type {
  CandleRequest,
  MarketDataProvider,
  ProviderDescriptor,
  ProviderHealth,
} from "../types";

/** Our timeframes map 1:1 onto Binance's interval strings. */
const INTERVALS: Readonly<Record<Timeframe, string>> = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1H": "1h",
  "2H": "2h",
  "4H": "4h",
  "1D": "1d",
  "1W": "1w",
};

/** Binance caps a single klines request at 1000 bars. */
const MAX_LIMIT = 1000;

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface BinanceAdapterOptions {
  /** Override for regional mirrors (api1/api2/api3.binance.com, or a proxy). */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DESCRIPTOR: ProviderDescriptor = {
  id: "binance",
  label: "Binance (crypto spot)",
  docsUrl: "https://developers.binance.com/docs/binance-spot-api-docs",
  // Public market data needs no credentials, so there is nothing to configure.
  fields: [],
};

/**
 * A Binance error body is `{ "code": -1121, "msg": "Invalid symbol." }`.
 * Recognising it lets the adapter report the real cause instead of a bare
 * HTTP status.
 */
interface BinanceError {
  code: number;
  msg: string;
}

function asBinanceError(payload: unknown): BinanceError | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.code === "number" && typeof record.msg === "string") {
    return { code: record.code, msg: record.msg };
  }
  return null;
}

function toFiniteNumber(value: unknown): number | null {
  // Binance returns every price and size as a decimal STRING.
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class BinanceMarketDataProvider implements MarketDataProvider {
  readonly kind = "market-data" as const;
  readonly descriptor = DESCRIPTOR;
  readonly supportedAssetClasses: readonly AssetClass[] = ["crypto"];
  readonly isRealtime = true;

  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: BinanceAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.binance.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Public market data needs no key, so the adapter is always usable. */
  isConfigured(): boolean {
    return true;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = Date.now();
    const result = await this.request<unknown>("/api/v3/ping");
    return result.available
      ? { configured: true, reachable: true, message: "Binance reachable.", checkedAt }
      : { configured: true, reachable: false, message: result.reason, checkedAt };
  }

  async getCandles(request: CandleRequest): Promise<Availability<CandleSeries>> {
    const { instrument, timeframe, from, to } = request;
    const interval = INTERVALS[timeframe];
    if (!interval) {
      return unavailable("UNSUPPORTED_TIMEFRAME", `Binance has no ${timeframe} interval.`);
    }

    const limit = Math.min(request.limit ?? 500, MAX_LIMIT);
    const params = new URLSearchParams({
      symbol: instrument.symbol.toUpperCase(),
      interval,
      limit: String(limit),
    });
    // startTime/endTime are optional; sending them lets the caller page history.
    if (Number.isFinite(from)) params.set("startTime", String(Math.floor(from)));
    if (Number.isFinite(to)) params.set("endTime", String(Math.floor(to)));

    const result = await this.request<unknown>(`/api/v3/klines?${params.toString()}`);
    if (!result.available) return result;

    if (!Array.isArray(result.data)) {
      return unavailable("MALFORMED_RESPONSE", "Binance returned a non-array klines payload.");
    }

    const candles: Candle[] = [];
    for (const row of result.data) {
      const candle = parseKline(row);
      // Skip a malformed row rather than inventing values for it. A partial
      // series with a gap is honest; a fabricated bar is not.
      if (candle) candles.push(candle);
    }

    if (candles.length === 0) {
      return unavailable(
        "NO_CANDLES",
        `Binance returned no usable bars for ${instrument.symbol} at ${timeframe}.`
      );
    }

    const newest = candles[candles.length - 1];
    return available<CandleSeries>({
      instrument,
      timeframe,
      candles,
      provenance: {
        source: DESCRIPTOR.id,
        // The newest bar's OPEN time; the freshness gate adds the bar duration.
        timestamp: newest.timestamp,
        status: "LIVE",
      },
    });
  }

  async getQuote(instrument: Instrument): Promise<Availability<Quote>> {
    const symbol = instrument.symbol.toUpperCase();
    const params = new URLSearchParams({ symbol });

    const [tickerResult, bookResult] = await Promise.all([
      this.request<unknown>(`/api/v3/ticker/24hr?${params.toString()}`),
      this.request<unknown>(`/api/v3/ticker/bookTicker?${params.toString()}`),
    ]);

    if (!tickerResult.available) return tickerResult;
    if (typeof tickerResult.data !== "object" || tickerResult.data === null) {
      return unavailable("MALFORMED_RESPONSE", "Binance returned a malformed ticker payload.");
    }

    const ticker = tickerResult.data as Record<string, unknown>;
    const last = toFiniteNumber(ticker.lastPrice);
    if (last === null) {
      return unavailable("MALFORMED_RESPONSE", `Binance ticker for ${symbol} carried no price.`);
    }

    // The book is a separate call; if it fails the quote is still valid, it
    // just has no bid/ask. Null is the correct value, not a guessed spread.
    let bid: number | null = null;
    let ask: number | null = null;
    if (bookResult.available && typeof bookResult.data === "object" && bookResult.data !== null) {
      const book = bookResult.data as Record<string, unknown>;
      bid = toFiniteNumber(book.bidPrice);
      ask = toFiniteNumber(book.askPrice);
    }

    return available<Quote>({
      instrument,
      last,
      bid,
      ask,
      spread: bid !== null && ask !== null ? ask - bid : null,
      volume: toFiniteNumber(ticker.volume),
      tradeCount: toFiniteNumber(ticker.count),
      // Binance's weightedAvgPrice IS the 24h VWAP — a real provider value, not
      // one this adapter computes.
      vwap: toFiniteNumber(ticker.weightedAvgPrice),
      changePercent: toFiniteNumber(ticker.priceChangePercent),
      // Crypto spot trades continuously; there is no session concept.
      session: "regular",
      provenance: {
        source: DESCRIPTOR.id,
        timestamp: toFiniteNumber(ticker.closeTime) ?? Date.now(),
        status: "LIVE",
      },
    });
  }

  async searchInstruments(query: string): Promise<Availability<Instrument[]>> {
    const result = await this.request<unknown>("/api/v3/exchangeInfo");
    if (!result.available) return result;

    if (typeof result.data !== "object" || result.data === null) {
      return unavailable(
        "MALFORMED_RESPONSE",
        "Binance returned a malformed exchangeInfo payload."
      );
    }
    const symbols = (result.data as Record<string, unknown>).symbols;
    if (!Array.isArray(symbols)) {
      return unavailable("MALFORMED_RESPONSE", "exchangeInfo carried no symbols array.");
    }

    const needle = query.trim().toUpperCase();
    const matches: Instrument[] = [];
    for (const entry of symbols) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const symbol = record.symbol;
      if (typeof symbol !== "string") continue;
      // Only tradeable pairs; a delisted symbol would return no candles.
      if (record.status !== "TRADING") continue;
      if (needle.length > 0 && !symbol.includes(needle)) continue;

      matches.push({
        symbol,
        assetClass: "crypto",
        exchange: "BINANCE",
        currency: typeof record.quoteAsset === "string" ? record.quoteAsset : undefined,
        contractSize: 1,
      });
      if (matches.length >= 50) break;
    }
    return available(matches);
  }

  /**
   * One request, with the failure taxonomy the caller actually needs to
   * distinguish: rate limiting, a bad symbol, and everything else.
   */
  private async request<T>(path: string): Promise<Availability<T>> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      return unavailable("NETWORK_ERROR", `Could not reach Binance: ${reason}`);
    }

    if (!response.ok) {
      // 429 = rate limited, 418 = IP banned for ignoring 429s. Both mean back
      // off, and both must be distinguishable from a bad request.
      if (response.status === 429) {
        return unavailable("RATE_LIMITED", "Binance rate limit hit — back off before retrying.");
      }
      if (response.status === 418) {
        return unavailable(
          "IP_BANNED",
          "Binance has temporarily banned this IP for exceeding rate limits."
        );
      }

      const payload = await response.json().catch(() => null);
      const binanceError = asBinanceError(payload);
      if (binanceError) {
        const hint =
          binanceError.code === -1121
            ? " Binance spot symbols are concatenated pairs such as BTCUSDT or ETHUSDT."
            : "";
        return unavailable(
          "PROVIDER_ERROR",
          `Binance error ${binanceError.code}: ${binanceError.msg}.${hint}`
        );
      }
      return unavailable("HTTP_ERROR", `Binance responded with HTTP ${response.status}.`);
    }

    const payload = await response.json().catch(() => null);
    if (payload === null) {
      return unavailable("MALFORMED_RESPONSE", "Binance returned a body that is not valid JSON.");
    }
    // A 200 can still carry an error body on some Binance endpoints.
    const binanceError = asBinanceError(payload);
    if (binanceError) {
      return unavailable(
        "PROVIDER_ERROR",
        `Binance error ${binanceError.code}: ${binanceError.msg}.`
      );
    }
    return available(payload as T);
  }
}

/**
 * Parse one kline row.
 *
 * Binance returns a positional array:
 *   [0] open time (ms)  [1] open  [2] high  [3] low  [4] close  [5] volume
 *   [6] close time      [7] quote volume    [8] trade count     ...
 *
 * Returns null on anything malformed, so the caller can skip the bar instead of
 * carrying a NaN into the indicator maths.
 */
export function parseKline(row: unknown): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null;

  const timestamp = toFiniteNumber(row[0]);
  const open = toFiniteNumber(row[1]);
  const high = toFiniteNumber(row[2]);
  const low = toFiniteNumber(row[3]);
  const close = toFiniteNumber(row[4]);
  const volume = toFiniteNumber(row[5]);

  if (
    timestamp === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null
  ) {
    return null;
  }
  // A bar whose high is below its low is corrupt, not merely unusual.
  if (high < low || volume < 0) return null;

  return { timestamp, open, high, low, close, volume };
}

export { INTERVALS as BINANCE_INTERVALS };
