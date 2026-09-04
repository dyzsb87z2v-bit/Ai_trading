/**
 * Finnhub adapters — news, economic calendar, fundamentals.
 *
 * One vendor covers three provider kinds, so one key enables three surfaces.
 *
 * Endpoints (https://finnhub.io/docs/api):
 *   GET /company-news        per-symbol news
 *   GET /news                general market news
 *   GET /calendar/economic   economic calendar
 *   GET /stock/metric        fundamental metrics
 *   GET /quote               used only for the health probe
 *
 * SENTIMENT HONESTY: Finnhub's news endpoints do not score sentiment, so this
 * adapter reports `sentiment: null` rather than deriving one from the headline.
 * A locally-guessed sentiment presented beside provider data would be
 * indistinguishable from a real reading — §13 forbids exactly that.
 */

import { available, unavailable, type Availability } from "../../types";
import type {
  EconomicCalendarProvider,
  EconomicEvent,
  EventImportance,
  Fundamentals,
  FundamentalProvider,
  NewsArticle,
  NewsProvider,
  ProviderDescriptor,
  ProviderHealth,
} from "../types";
import { HttpClient, epochMs, num, type FetchLike } from "./http";

export interface FinnhubOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function client(options: FinnhubOptions): HttpClient {
  return new HttpClient({
    baseUrl: options.baseUrl ?? "https://finnhub.io/api/v1",
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    // The key rides a header rather than the query string, so it cannot end up
    // in a proxy access log.
    headers: options.apiKey ? { "X-Finnhub-Token": options.apiKey } : {},
  });
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// News (§13)
// ---------------------------------------------------------------------------

const NEWS_DESCRIPTOR: ProviderDescriptor = {
  id: "finnhub-news",
  label: "Finnhub news",
  docsUrl: "https://finnhub.io/docs/api/company-news",
  fields: [{ key: "apiKey", label: "API key", secret: true, required: true }],
};

export class FinnhubNewsProvider implements NewsProvider {
  readonly kind = "news" as const;
  readonly descriptor = NEWS_DESCRIPTOR;
  private readonly apiKey: string;
  private readonly http: HttpClient;

  constructor(options: FinnhubOptions = {}) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.http = client(options);
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = Date.now();
    if (!this.isConfigured()) {
      return { configured: false, reachable: false, message: "No API key configured.", checkedAt };
    }
    const result = await this.http.getJson<unknown>("/quote?symbol=AAPL");
    return result.available
      ? { configured: true, reachable: true, message: "Finnhub reachable.", checkedAt }
      : { configured: true, reachable: false, message: result.reason, checkedAt };
  }

  async getNews(params: {
    symbols?: readonly string[];
    from?: number;
    to?: number;
    limit?: number;
  }): Promise<Availability<NewsArticle[]>> {
    if (!this.isConfigured()) {
      return unavailable("NOT_CONFIGURED", "Finnhub news has no API key configured.");
    }

    const to = params.to ?? Date.now();
    const from = params.from ?? to - 7 * 86_400_000;
    const symbols = params.symbols ?? [];

    // Per-symbol news when symbols are given, otherwise the general feed.
    const paths =
      symbols.length > 0
        ? symbols.map(
            (symbol) =>
              `/company-news?symbol=${encodeURIComponent(symbol)}&from=${isoDate(from)}&to=${isoDate(to)}`
          )
        : ["/news?category=general"];

    const articles: NewsArticle[] = [];
    const failures: string[] = [];

    for (const path of paths) {
      const result = await this.http.getJson<unknown>(path);
      if (!result.available) {
        failures.push(result.reason);
        continue;
      }
      if (!Array.isArray(result.data)) {
        failures.push("Finnhub returned a non-array news payload.");
        continue;
      }
      for (const row of result.data) {
        const article = parseFinnhubArticle(row);
        if (article) articles.push(article);
      }
    }

    // Every path failing means the caller gets an error, not an empty list that
    // reads as "no news today".
    if (articles.length === 0 && failures.length === paths.length) {
      return unavailable("PROVIDER_ERROR", failures[0] ?? "Finnhub returned no news.");
    }

    articles.sort((a, b) => b.publishedAt - a.publishedAt);
    return available(articles.slice(0, params.limit ?? 50));
  }
}

export function parseFinnhubArticle(row: unknown): NewsArticle | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;

  const headline = typeof record.headline === "string" ? record.headline.trim() : "";
  if (headline.length === 0) return null;

  const publishedAt = epochMs(record.datetime);
  if (publishedAt === null) return null;

  const related = typeof record.related === "string" ? record.related : "";

  return {
    id: String(record.id ?? `${publishedAt}-${headline.slice(0, 24)}`),
    headline,
    url: typeof record.url === "string" ? record.url : null,
    source: typeof record.source === "string" ? record.source : "Finnhub",
    publishedAt,
    symbols:
      related.length > 0
        ? related
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    summary:
      typeof record.summary === "string" && record.summary.length > 0 ? record.summary : null,
    // Finnhub's news endpoints carry no sentiment or impact score. Deriving one
    // here would be indistinguishable from a provider reading (§13).
    sentiment: null,
    impact: null,
    relevance: null,
  };
}

// ---------------------------------------------------------------------------
// Economic calendar (§14)
// ---------------------------------------------------------------------------

const CALENDAR_DESCRIPTOR: ProviderDescriptor = {
  id: "finnhub-calendar",
  label: "Finnhub economic calendar",
  docsUrl: "https://finnhub.io/docs/api/economic-calendar",
  fields: [{ key: "apiKey", label: "API key", secret: true, required: true }],
};

export class FinnhubCalendarProvider implements EconomicCalendarProvider {
  readonly kind = "economic-calendar" as const;
  readonly descriptor = CALENDAR_DESCRIPTOR;
  private readonly apiKey: string;
  private readonly http: HttpClient;

  constructor(options: FinnhubOptions = {}) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.http = client(options);
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = Date.now();
    if (!this.isConfigured()) {
      return { configured: false, reachable: false, message: "No API key configured.", checkedAt };
    }
    const result = await this.http.getJson<unknown>("/calendar/economic");
    return result.available
      ? { configured: true, reachable: true, message: "Finnhub calendar reachable.", checkedAt }
      : { configured: true, reachable: false, message: result.reason, checkedAt };
  }

  async getEvents(params: {
    from: number;
    to: number;
    countries?: readonly string[];
  }): Promise<Availability<EconomicEvent[]>> {
    if (!this.isConfigured()) {
      return unavailable("NOT_CONFIGURED", "Finnhub calendar has no API key configured.");
    }

    const result = await this.http.getJson<unknown>(
      `/calendar/economic?from=${isoDate(params.from)}&to=${isoDate(params.to)}`
    );
    if (!result.available) return result;

    const record = result.data as Record<string, unknown>;
    const rows = record.economicCalendar;
    if (!Array.isArray(rows)) {
      return unavailable("MALFORMED_RESPONSE", "Finnhub returned no economicCalendar array.");
    }

    const wanted = params.countries ? new Set(params.countries.map((c) => c.toUpperCase())) : null;
    const events: EconomicEvent[] = [];
    for (const row of rows) {
      const event = parseFinnhubEvent(row);
      if (!event) continue;
      if (event.scheduledAt < params.from || event.scheduledAt > params.to) continue;
      if (wanted && !wanted.has(event.country.toUpperCase())) continue;
      events.push(event);
    }

    events.sort((a, b) => a.scheduledAt - b.scheduledAt);
    return available(events);
  }
}

export function parseFinnhubEvent(row: unknown): EconomicEvent | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;

  const name = typeof record.event === "string" ? record.event.trim() : "";
  if (name.length === 0) return null;
  const scheduledAt = epochMs(record.time);
  if (scheduledAt === null) return null;

  return {
    id: `${record.country ?? "??"}-${name}-${scheduledAt}`,
    name,
    country: typeof record.country === "string" ? record.country : "??",
    scheduledAt,
    importance: mapImportance(record.impact),
    previous: stringOrNull(record.prev),
    forecast: stringOrNull(record.estimate),
    actual: stringOrNull(record.actual),
    currency: typeof record.unit === "string" ? record.unit : null,
  };
}

function mapImportance(value: unknown): EventImportance {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text === "high" || text === "3") return "high";
  if (text === "medium" || text === "2") return "medium";
  if (typeof value === "number") {
    if (value >= 3) return "high";
    if (value === 2) return "medium";
  }
  // Unknown importance defaults to LOW, never HIGH: over-reporting importance
  // would block trading around events that do not warrant it (§14).
  return "low";
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

// ---------------------------------------------------------------------------
// Fundamentals (§15)
// ---------------------------------------------------------------------------

const FUNDAMENTALS_DESCRIPTOR: ProviderDescriptor = {
  id: "finnhub-fundamentals",
  label: "Finnhub fundamentals",
  docsUrl: "https://finnhub.io/docs/api/company-basic-financials",
  fields: [{ key: "apiKey", label: "API key", secret: true, required: true }],
};

export class FinnhubFundamentalsProvider implements FundamentalProvider {
  readonly kind = "fundamentals" as const;
  readonly descriptor = FUNDAMENTALS_DESCRIPTOR;
  private readonly apiKey: string;
  private readonly http: HttpClient;

  constructor(options: FinnhubOptions = {}) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.http = client(options);
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = Date.now();
    if (!this.isConfigured()) {
      return { configured: false, reachable: false, message: "No API key configured.", checkedAt };
    }
    const result = await this.http.getJson<unknown>("/stock/metric?symbol=AAPL&metric=all");
    return result.available
      ? { configured: true, reachable: true, message: "Finnhub fundamentals reachable.", checkedAt }
      : { configured: true, reachable: false, message: result.reason, checkedAt };
  }

  async getFundamentals(symbol: string): Promise<Availability<Fundamentals>> {
    if (!this.isConfigured()) {
      return unavailable("NOT_CONFIGURED", "Finnhub fundamentals has no API key configured.");
    }
    const result = await this.http.getJson<unknown>(
      `/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`
    );
    if (!result.available) return result;

    const record = result.data as Record<string, unknown>;
    const metric = record.metric;
    if (typeof metric !== "object" || metric === null) {
      return unavailable("MALFORMED_RESPONSE", `Finnhub returned no metrics for ${symbol}.`);
    }
    return available(parseFinnhubMetrics(symbol, metric as Record<string, unknown>));
  }
}

/**
 * Map Finnhub's metric bag onto the domain type.
 *
 * Every field is nullable and a missing metric stays null — §15 forbids filling
 * a gap with a derived or defaulted figure.
 */
export function parseFinnhubMetrics(symbol: string, metric: Record<string, unknown>): Fundamentals {
  return {
    symbol,
    asOf: Date.now(),
    currency: typeof metric.currency === "string" ? metric.currency : null,
    revenue: num(metric.revenuePerShareTTM),
    revenueGrowthYoy: num(metric.revenueGrowthTTMYoy),
    eps: num(metric.epsTTM) ?? num(metric.epsBasicExclExtraItemsTTM),
    epsGrowthYoy: num(metric.epsGrowthTTMYoy),
    peRatio: num(metric.peTTM) ?? num(metric.peBasicExclExtraTTM),
    forwardPeRatio: num(metric.forwardPE),
    pegRatio: num(metric.pegTTM),
    priceToSales: num(metric.psTTM),
    priceToBook: num(metric.pbQuarterly) ?? num(metric.pbAnnual),
    totalDebt: num(metric.totalDebtToEquityQuarterly),
    cash: num(metric.cashPerSharePerShareQuarterly),
    freeCashFlow: num(metric.freeCashFlowPerShareTTM),
    grossMargin: num(metric.grossMarginTTM),
    operatingMargin: num(metric.operatingMarginTTM),
    netMargin: num(metric.netProfitMarginTTM),
    returnOnEquity: num(metric.roeTTM),
    returnOnInvestedCapital: num(metric.roiTTM),
    dividendYield: num(metric.dividendYieldIndicatedAnnual),
    nextEarningsDate: null,
    analystTargetPrice: null,
  };
}
