/**
 * Provider adapter contracts (master spec §2, §13, §14, §15, §21).
 *
 * The platform is never coupled to one vendor. Every external fact — a price, a
 * headline, an earnings figure, a broker balance — arrives through one of these
 * interfaces, and every method returns `Availability<T>` so "we don't know" is a
 * first-class result rather than an empty object that reads like zero.
 *
 * No adapter in this repository may synthesise a value it did not receive from
 * its upstream. An adapter that cannot answer returns `unavailable(...)`.
 */

import type {
  AssetClass,
  Availability,
  CandleSeries,
  Instrument,
  Quote,
  Timeframe,
} from "../types";

export interface ProviderDescriptor {
  /** Stable id used in provenance stamps and config, e.g. "polygon". */
  id: string;
  label: string;
  /** Where the operator gets credentials. Rendered in the UI, never fabricated. */
  docsUrl: string | null;
  /** Config keys this adapter needs; `secret: true` keys are encrypted at rest. */
  fields: readonly ProviderConfigField[];
}

export interface ProviderConfigField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
}

export interface ProviderHealth {
  configured: boolean;
  reachable: boolean;
  message: string;
  checkedAt: number;
}

interface BaseProvider {
  readonly descriptor: ProviderDescriptor;
  /**
   * Whether the operator has supplied the credentials this adapter needs.
   * A provider that is not configured must never be presented as working.
   */
  isConfigured(): boolean;
  health(): Promise<ProviderHealth>;
}

// ---------------------------------------------------------------------------
// Market data (§3)
// ---------------------------------------------------------------------------

export interface CandleRequest {
  instrument: Instrument;
  timeframe: Timeframe;
  /** Inclusive epoch-ms lower bound. */
  from: number;
  /** Exclusive epoch-ms upper bound. */
  to: number;
  limit?: number;
}

/** A push update from a streaming feed. */
export type MarketStreamEvent =
  | { type: "quote"; quote: Quote }
  | { type: "candle"; series: CandleSeries }
  | { type: "status"; connected: boolean; message: string };

export interface MarketStreamSubscription {
  close(): void;
}

export interface MarketDataProvider extends BaseProvider {
  readonly kind: "market-data";
  supportedAssetClasses: readonly AssetClass[];
  /** True when the feed is real-time; false means quotes are stamped DELAYED. */
  isRealtime: boolean;

  getQuote(instrument: Instrument): Promise<Availability<Quote>>;
  getCandles(request: CandleRequest): Promise<Availability<CandleSeries>>;
  searchInstruments(query: string): Promise<Availability<Instrument[]>>;

  /**
   * Optional streaming. Adapters without a websocket omit this; the runtime then
   * polls `getQuote` rather than pretending to stream.
   */
  subscribe?(
    instruments: readonly Instrument[],
    onEvent: (event: MarketStreamEvent) => void
  ): Promise<Availability<MarketStreamSubscription>>;
}

// ---------------------------------------------------------------------------
// News (§13)
// ---------------------------------------------------------------------------

export type NewsSentiment = "positive" | "neutral" | "negative";
export type NewsImpact = "low" | "medium" | "high" | "critical";

export interface NewsArticle {
  id: string;
  headline: string;
  url: string | null;
  /** Publisher name as reported by the provider. */
  source: string;
  publishedAt: number;
  symbols: readonly string[];
  summary: string | null;
  /**
   * Sentiment as scored BY THE PROVIDER. Null when the provider does not score
   * sentiment — the platform does not invent a reading to fill the column.
   */
  sentiment: NewsSentiment | null;
  impact: NewsImpact | null;
  /** Provider-supplied relevance in [0,1], or null. */
  relevance: number | null;
}

export interface NewsProvider extends BaseProvider {
  readonly kind: "news";
  getNews(params: {
    symbols?: readonly string[];
    from?: number;
    to?: number;
    limit?: number;
  }): Promise<Availability<NewsArticle[]>>;
}

// ---------------------------------------------------------------------------
// Fundamentals (§15)
// ---------------------------------------------------------------------------

/** Every field is nullable: a missing fundamental stays missing (§15). */
export interface Fundamentals {
  symbol: string;
  asOf: number;
  currency: string | null;
  revenue: number | null;
  revenueGrowthYoy: number | null;
  eps: number | null;
  epsGrowthYoy: number | null;
  peRatio: number | null;
  forwardPeRatio: number | null;
  pegRatio: number | null;
  priceToSales: number | null;
  priceToBook: number | null;
  totalDebt: number | null;
  cash: number | null;
  freeCashFlow: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  returnOnEquity: number | null;
  returnOnInvestedCapital: number | null;
  dividendYield: number | null;
  nextEarningsDate: number | null;
  analystTargetPrice: number | null;
}

export interface FundamentalProvider extends BaseProvider {
  readonly kind: "fundamentals";
  getFundamentals(symbol: string): Promise<Availability<Fundamentals>>;
}

// ---------------------------------------------------------------------------
// Economic calendar (§14)
// ---------------------------------------------------------------------------

export type EventImportance = "low" | "medium" | "high";

export interface EconomicEvent {
  id: string;
  name: string;
  country: string;
  scheduledAt: number;
  importance: EventImportance;
  previous: string | null;
  forecast: string | null;
  actual: string | null;
  currency: string | null;
}

export interface EconomicCalendarProvider extends BaseProvider {
  readonly kind: "economic-calendar";
  getEvents(params: {
    from: number;
    to: number;
    countries?: readonly string[];
  }): Promise<Availability<EconomicEvent[]>>;
}

// ---------------------------------------------------------------------------
// Broker / exchange (§21)
// ---------------------------------------------------------------------------

export type OrderType = "market" | "limit" | "stop";
export type OrderStatus =
  "pending" | "open" | "partially_filled" | "filled" | "cancelled" | "rejected";

export interface BrokerAccount {
  id: string;
  currency: string;
  equity: number;
  cash: number;
  buyingPower: number | null;
  asOf: number;
}

export interface BrokerPosition {
  symbol: string;
  quantity: number;
  averageEntryPrice: number;
  marketValue: number | null;
  unrealizedPnl: number | null;
  asOf: number;
}

export interface OrderRequest {
  instrument: Instrument;
  side: "buy" | "sell";
  type: OrderType;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  /** Caller-generated id used to reject duplicate submissions (§22 check 11). */
  clientOrderId: string;
}

export interface BrokerOrder {
  id: string;
  clientOrderId: string | null;
  symbol: string;
  side: "buy" | "sell";
  type: OrderType;
  quantity: number;
  filledQuantity: number;
  averageFillPrice: number | null;
  status: OrderStatus;
  submittedAt: number;
  updatedAt: number;
}

/**
 * Broker adapters are READ-ONLY by default (§21). `placeOrder` and `cancelOrder`
 * exist on the interface but an adapter whose `tradingEnabled` is false must
 * reject them — and the risk engine gates them regardless.
 */
export interface BrokerProvider extends BaseProvider {
  readonly kind: "broker";
  /** False unless the operator has explicitly enabled live execution. */
  readonly tradingEnabled: boolean;

  getAccount(): Promise<Availability<BrokerAccount>>;
  getPositions(): Promise<Availability<BrokerPosition[]>>;
  getOrders(): Promise<Availability<BrokerOrder[]>>;
  getOrderStatus(orderId: string): Promise<Availability<BrokerOrder>>;
  placeOrder(request: OrderRequest): Promise<Availability<BrokerOrder>>;
  cancelOrder(orderId: string): Promise<Availability<BrokerOrder>>;
}

export type TradingProvider =
  | MarketDataProvider
  | NewsProvider
  | FundamentalProvider
  | EconomicCalendarProvider
  | BrokerProvider;

export type TradingProviderKind = TradingProvider["kind"];
