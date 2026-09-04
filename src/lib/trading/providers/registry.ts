/**
 * Trading provider registry (master spec §2, §42).
 *
 * Mirrors the pattern in src/lib/logExport/registry.ts: one array per provider
 * kind, so adding a vendor means writing an adapter and registering it — the
 * engines, the REST layer and the UI read from here and stay vendor-agnostic.
 *
 * The registry ships EMPTY. That is not an omission: registering a market-data
 * adapter means writing one against a real vendor API with real credentials.
 * Until an operator does that, every read path reports DATA SOURCE UNAVAILABLE
 * rather than serving invented prices (§42).
 */

import type {
  BrokerProvider,
  EconomicCalendarProvider,
  FundamentalProvider,
  MarketDataProvider,
  NewsProvider,
  TradingProvider,
  TradingProviderKind,
} from "./types";

const marketData: MarketDataProvider[] = [];
const news: NewsProvider[] = [];
const fundamentals: FundamentalProvider[] = [];
const economicCalendar: EconomicCalendarProvider[] = [];
const brokers: BrokerProvider[] = [];

function bucketFor(kind: TradingProviderKind): TradingProvider[] {
  switch (kind) {
    case "market-data":
      return marketData;
    case "news":
      return news;
    case "fundamentals":
      return fundamentals;
    case "economic-calendar":
      return economicCalendar;
    case "broker":
      return brokers;
  }
}

export function registerTradingProvider(provider: TradingProvider): void {
  const bucket = bucketFor(provider.kind);
  const existing = bucket.findIndex((p) => p.descriptor.id === provider.descriptor.id);
  if (existing >= 0) bucket[existing] = provider;
  else bucket.push(provider);
}

export function unregisterTradingProvider(kind: TradingProviderKind, id: string): void {
  const bucket = bucketFor(kind);
  const index = bucket.findIndex((p) => p.descriptor.id === id);
  if (index >= 0) bucket.splice(index, 1);
}

/** Test-only: drop every registration so suites start from a known state. */
export function __resetTradingProvidersForTest(): void {
  marketData.length = 0;
  news.length = 0;
  fundamentals.length = 0;
  economicCalendar.length = 0;
  brokers.length = 0;
}

export function listMarketDataProviders(): readonly MarketDataProvider[] {
  return marketData;
}
export function listNewsProviders(): readonly NewsProvider[] {
  return news;
}
export function listFundamentalProviders(): readonly FundamentalProvider[] {
  return fundamentals;
}
export function listEconomicCalendarProviders(): readonly EconomicCalendarProvider[] {
  return economicCalendar;
}
export function listBrokerProviders(): readonly BrokerProvider[] {
  return brokers;
}

/**
 * The provider actually used for reads: the first CONFIGURED adapter of that
 * kind. Registration alone is not enough — an adapter without credentials is
 * skipped, so a half-set-up vendor never silently becomes the data source.
 */
export function getActiveMarketDataProvider(): MarketDataProvider | null {
  return marketData.find((p) => p.isConfigured()) ?? null;
}
export function getActiveNewsProvider(): NewsProvider | null {
  return news.find((p) => p.isConfigured()) ?? null;
}
export function getActiveFundamentalProvider(): FundamentalProvider | null {
  return fundamentals.find((p) => p.isConfigured()) ?? null;
}
export function getActiveEconomicCalendarProvider(): EconomicCalendarProvider | null {
  return economicCalendar.find((p) => p.isConfigured()) ?? null;
}
export function getActiveBrokerProvider(): BrokerProvider | null {
  return brokers.find((p) => p.isConfigured()) ?? null;
}

export interface ProviderAvailabilitySummary {
  kind: TradingProviderKind;
  /** Message the UI shows verbatim when nothing is available (§42). */
  unavailableMessage: string;
  registered: number;
  configured: number;
  activeId: string | null;
}

const UNAVAILABLE_MESSAGES: Record<TradingProviderKind, string> = {
  "market-data": "DATA SOURCE UNAVAILABLE — no market-data provider is configured.",
  news: "NEWS DATA UNAVAILABLE — no news provider is configured.",
  fundamentals: "FUNDAMENTAL DATA UNAVAILABLE — no fundamentals provider is configured.",
  "economic-calendar": "ECONOMIC CALENDAR UNAVAILABLE — no calendar provider is configured.",
  broker: "ORDER EXECUTION DISABLED — no broker is connected.",
};

export function summarizeProviders(): ProviderAvailabilitySummary[] {
  const kinds: TradingProviderKind[] = [
    "market-data",
    "news",
    "fundamentals",
    "economic-calendar",
    "broker",
  ];
  return kinds.map((kind) => {
    const bucket = bucketFor(kind);
    const configured = bucket.filter((p) => p.isConfigured());
    return {
      kind,
      unavailableMessage: UNAVAILABLE_MESSAGES[kind],
      registered: bucket.length,
      configured: configured.length,
      activeId: configured[0]?.descriptor.id ?? null,
    };
  });
}

export function unavailableMessageFor(kind: TradingProviderKind): string {
  return UNAVAILABLE_MESSAGES[kind];
}
