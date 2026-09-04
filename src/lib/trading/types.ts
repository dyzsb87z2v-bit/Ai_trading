/**
 * Trading domain types.
 *
 * Design rule #1 (master spec §32): every market-dependent value carries its
 * provenance — `source`, `timestamp` and `status`. There is no type in this file
 * that lets a price exist without saying where it came from and when. That is
 * deliberate: it makes "fabricate a price" a compile error rather than a habit.
 */

/**
 * Provenance of a market value. Never mix these without labelling (§32).
 *
 * - LIVE        real-time from a provider, inside the freshness window
 * - DELAYED     real provider data, knowingly behind (e.g. 15-min exchange feeds)
 * - HISTORICAL  closed/settled bars from a provider
 * - PAPER       simulated execution against real market data
 * - SIMULATED   synthetic values (backtests, fixtures) — never a real quote
 * - STALE       was LIVE, exceeded the freshness window; analysis must degrade
 * - UNAVAILABLE no data at all; the caller must render "DATA SOURCE UNAVAILABLE"
 */
export type DataStatus =
  "LIVE" | "DELAYED" | "HISTORICAL" | "PAPER" | "SIMULATED" | "STALE" | "UNAVAILABLE";

/** Statuses that permit live signal generation (§3). */
export const TRADEABLE_DATA_STATUSES: ReadonlySet<DataStatus> = new Set<DataStatus>([
  "LIVE",
  "DELAYED",
]);

export type AssetClass = "stock" | "etf" | "index" | "forex" | "crypto";

export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1H" | "2H" | "4H" | "1D" | "1W";

/** Milliseconds per timeframe. Used for gap detection and staleness budgets. */
export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1H": 3_600_000,
  "2H": 7_200_000,
  "4H": 14_400_000,
  "1D": 86_400_000,
  "1W": 604_800_000,
};

export const ALL_TIMEFRAMES: readonly Timeframe[] = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1H",
  "2H",
  "4H",
  "1D",
  "1W",
];

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, value);
}

/** Envelope attached to every market-dependent value (§3, §32). */
export interface Provenance {
  /** Provider id that produced the value, e.g. "polygon". Never invented. */
  source: string;
  /** Epoch ms of the value itself (not of the fetch). */
  timestamp: number;
  status: DataStatus;
}

export interface Instrument {
  symbol: string;
  assetClass: AssetClass;
  /** Exchange MIC or venue id when the provider supplies one. */
  exchange?: string;
  currency?: string;
  /** Value of one point/unit move for one contract/share. Defaults to 1. */
  contractSize?: number;
  /** Smallest price increment the venue accepts, when known. */
  tickSize?: number;
}

/** A single OHLCV bar. `timestamp` is the bar's OPEN time, epoch ms, UTC. */
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** A time-ordered candle series with provenance. Always ascending by timestamp. */
export interface CandleSeries {
  instrument: Instrument;
  timeframe: Timeframe;
  candles: readonly Candle[];
  provenance: Provenance;
}

export type MarketSession = "pre" | "regular" | "post" | "closed" | "unknown";

/** A real-time (or delayed) quote. */
export interface Quote {
  instrument: Instrument;
  last: number | null;
  bid: number | null;
  ask: number | null;
  /** Absolute spread in price units; null when bid/ask are unavailable. */
  spread: number | null;
  volume: number | null;
  tradeCount: number | null;
  /** Session VWAP when the provider reports one. Never locally faked. */
  vwap: number | null;
  changePercent: number | null;
  session: MarketSession;
  provenance: Provenance;
}

export type Side = "long" | "short";

export type SignalState =
  "STRONG_BUY" | "BUY" | "HOLD" | "WAIT" | "SELL" | "STRONG_SELL" | "NO_TRADE";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";

/**
 * A named contribution to a score. The spec (§8, §34) requires every signal be
 * explainable, so scores are never emitted as a bare number — they carry the
 * factors that produced them.
 */
export interface ScoreFactor {
  /** Stable machine id, e.g. "trend.htf_alignment". */
  id: string;
  label: string;
  /** Normalised directional reading in [-1, 1]; +1 maximally bullish. */
  value: number;
  /** Weight applied to `value` for this market regime. */
  weight: number;
  /** Human-readable evidence. Must cite computed values, never adjectives alone. */
  evidence: string;
}

export interface Warning {
  code: string;
  message: string;
  severity: "info" | "warning" | "critical";
}

/** Result wrapper used across engines so "unknown" is representable (§42). */
export type Availability<T> =
  { available: true; data: T } | { available: false; reason: string; code: string };

export function unavailable<T>(code: string, reason: string): Availability<T> {
  return { available: false, code, reason };
}

export function available<T>(data: T): Availability<T> {
  return { available: true, data };
}
