/**
 * Twelve Data adapter — stocks, ETFs, indices, forex and crypto.
 *
 * Chosen as the multi-asset adapter because one key covers every asset class
 * the platform supports, which keeps the provider surface small.
 *
 * Endpoints (https://twelvedata.com/docs):
 *   GET /time_series   candles
 *   GET /quote         quote
 *   GET /symbol_search instrument search
 *
 * Twelve Data signals errors with HTTP 200 and `{"status":"error","message":…}`,
 * so a 200 is not sufficient evidence of success — the body is checked too.
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
import { HttpClient, epochMs, num, type FetchLike } from "./http";

const INTERVALS: Readonly<Record<Timeframe, string>> = {
  "1m": "1min",
  "3m": "5min", // Twelve Data has no 3-minute interval; 5min is the nearest.
  "5m": "5min",
  "15m": "15min",
  "30m": "30min",
  "1H": "1h",
  "2H": "2h",
  "4H": "4h",
  "1D": "1day",
  "1W": "1week",
};

/** Timeframes Twelve Data cannot serve exactly. Callers are told, not fooled. */
const APPROXIMATED: ReadonlySet<Timeframe> = new Set<Timeframe>(["3m"]);

const DESCRIPTOR: ProviderDescriptor = {
  id: "twelvedata",
  label: "Twelve Data (stocks, forex, crypto)",
  docsUrl: "https://twelvedata.com/docs",
  fields: [
    { key: "apiKey", label: "API key", secret: true, required: true, placeholder: "your key" },
  ],
};

export interface TwelveDataOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface TwelveDataError {
  status: string;
  message?: string;
  code?: number;
}

function asError(payload: unknown): TwelveDataError | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record.status === "error") {
    return {
      status: "error",
      message: typeof record.message === "string" ? record.message : undefined,
    };
  }
  return null;
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly kind = "market-data" as const;
  readonly descriptor = DESCRIPTOR;
  readonly supportedAssetClasses: readonly AssetClass[] = [
    "stock",
    "etf",
    "index",
    "forex",
    "crypto",
  ];
  /** The free tier is delayed; quotes are stamped accordingly. */
  readonly isRealtime: boolean;

  private readonly apiKey: string;
  private readonly http: HttpClient;

  constructor(options: TwelveDataOptions = {}) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.isRealtime = false;
    this.http = new HttpClient({
      baseUrl: options.baseUrl ?? "https://api.twelvedata.com",
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = Date.now();
    if (!this.isConfigured()) {
      return { configured: false, reachable: false, message: "No API key configured.", checkedAt };
    }
    const result = await this.request<unknown>(`/quote?symbol=AAPL&apikey=${this.key()}`);
    return result.available
      ? { configured: true, reachable: true, message: "Twelve Data reachable.", checkedAt }
      : { configured: true, reachable: false, message: result.reason, checkedAt };
  }

  async getCandles(request: CandleRequest): Promise<Availability<CandleSeries>> {
    if (!this.isConfigured()) {
      return unavailable("NOT_CONFIGURED", "Twelve Data has no API key configured.");
    }
    const interval = INTERVALS[request.timeframe];
    const limit = Math.min(request.limit ?? 500, 5000);
    const params = new URLSearchParams({
      symbol: request.instrument.symbol,
      interval,
      outputsize: String(limit),
      // Ascending order so no re-sorting is needed downstream.
      order: "ASC",
      apikey: this.key(),
    });

    const result = await this.request<unknown>(`/time_series?${params.toString()}`);
    if (!result.available) return result;

    const record = result.data as Record<string, unknown>;
    const values = record.values;
    if (!Array.isArray(values)) {
      return unavailable("MALFORMED_RESPONSE", "Twelve Data returned no values array.");
    }

    const candles: Candle[] = [];
    for (const row of values) {
      const candle = parseTimeSeriesRow(row);
      if (candle) candles.push(candle);
    }
    // The API is asked for ascending order, but sorting is cheap insurance
    // against a silent contract change.
    candles.sort((a, b) => a.timestamp - b.timestamp);

    if (candles.length === 0) {
      return unavailable(
        "NO_CANDLES",
        `Twelve Data returned no usable bars for ${request.instrument.symbol}.`
      );
    }

    const newest = candles[candles.length - 1];
    return available<CandleSeries>({
      instrument: request.instrument,
      timeframe: request.timeframe,
      candles,
      provenance: {
        source: DESCRIPTOR.id,
        timestamp: newest.timestamp,
        // Never claim LIVE on a delayed plan.
        status: "DELAYED",
      },
    });
  }

  async getQuote(instrument: Instrument): Promise<Availability<Quote>> {
    if (!this.isConfigured()) {
      return unavailable("NOT_CONFIGURED", "Twelve Data has no API key configured.");
    }
    const params = new URLSearchParams({ symbol: instrument.symbol, apikey: this.key() });
    const result = await this.request<unknown>(`/quote?${params.toString()}`);
    if (!result.available) return result;

    const record = result.data as Record<string, unknown>;
    const last = num(record.close) ?? num(record.price);
    if (last === null) {
      return unavailable(
        "MALFORMED_RESPONSE",
        `Twelve Data quote for ${instrument.symbol} carried no price.`
      );
    }

    const timestamp = epochMs(record.timestamp) ?? epochMs(record.datetime) ?? Date.now();

    return available<Quote>({
      instrument,
      last,
      // The quote endpoint carries no book, and inventing one would be a lie.
      bid: null,
      ask: null,
      spread: null,
      volume: num(record.volume),
      tradeCount: null,
      // Twelve Data exposes no VWAP on this endpoint.
      vwap: null,
      changePercent: num(record.percent_change),
      session: mapSession(record.is_market_open),
      provenance: { source: DESCRIPTOR.id, timestamp, status: "DELAYED" },
    });
  }

  async searchInstruments(query: string): Promise<Availability<Instrument[]>> {
    if (!this.isConfigured()) {
      return unavailable("NOT_CONFIGURED", "Twelve Data has no API key configured.");
    }
    const params = new URLSearchParams({ symbol: query, apikey: this.key() });
    const result = await this.request<unknown>(`/symbol_search?${params.toString()}`);
    if (!result.available) return result;

    const record = result.data as Record<string, unknown>;
    const data = record.data;
    if (!Array.isArray(data)) {
      return unavailable("MALFORMED_RESPONSE", "Twelve Data returned no search data array.");
    }

    const instruments: Instrument[] = [];
    for (const entry of data.slice(0, 50)) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.symbol !== "string") continue;
      instruments.push({
        symbol: row.symbol,
        assetClass: mapAssetClass(row.instrument_type),
        exchange: typeof row.exchange === "string" ? row.exchange : undefined,
        currency: typeof row.currency === "string" ? row.currency : undefined,
        contractSize: 1,
      });
    }
    return available(instruments);
  }

  /** True when the requested timeframe is served by a different interval. */
  static isApproximated(timeframe: Timeframe): boolean {
    return APPROXIMATED.has(timeframe);
  }

  private key(): string {
    return encodeURIComponent(this.apiKey);
  }

  /** Wraps the HTTP layer to also treat a 200 error body as a failure. */
  private async request<T>(path: string): Promise<Availability<T>> {
    const result = await this.http.getJson<T>(path);
    if (!result.available) return result;
    const error = asError(result.data);
    if (error) {
      return unavailable("PROVIDER_ERROR", `Twelve Data: ${error.message ?? "unknown error"}`);
    }
    return result;
  }
}

export function parseTimeSeriesRow(row: unknown): Candle | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;

  const timestamp = epochMs(record.datetime);
  const open = num(record.open);
  const high = num(record.high);
  const low = num(record.low);
  const close = num(record.close);
  // Forex and index series legitimately carry no volume; 0 is correct there,
  // and is distinguishable from a corrupt row because OHLC still parsed.
  const volume = num(record.volume) ?? 0;

  if (timestamp === null || open === null || high === null || low === null || close === null) {
    return null;
  }
  if (high < low || volume < 0) return null;

  return { timestamp, open, high, low, close, volume };
}

function mapAssetClass(value: unknown): AssetClass {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text.includes("etf")) return "etf";
  if (text.includes("index")) return "index";
  if (text.includes("currency") || text.includes("forex")) return "forex";
  if (text.includes("crypto") || text.includes("digital")) return "crypto";
  return "stock";
}

function mapSession(value: unknown): Quote["session"] {
  if (value === true) return "regular";
  if (value === false) return "closed";
  // Unknown is honest; the risk engine blocks on it rather than assuming open.
  return "unknown";
}
