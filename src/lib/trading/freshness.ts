/**
 * Data freshness gate (master spec §3, §12, §42).
 *
 * The single place that decides whether market data is fresh enough to justify
 * generating a live trading signal. Every engine that produces a tradeable
 * recommendation must pass through `assertLiveAnalysisAllowed` first.
 *
 * The rule is deliberately conservative: when we cannot prove data is fresh, it
 * is stale. There is no "probably fine" branch.
 */

import {
  TIMEFRAME_MS,
  TRADEABLE_DATA_STATUSES,
  type CandleSeries,
  type DataStatus,
  type Provenance,
  type Quote,
  type Timeframe,
} from "./types";

/**
 * How long a quote may go without an update before it stops counting as LIVE.
 * Per asset class, because a 5-second gap means something very different for
 * BTC than for a thinly traded ETF.
 */
export interface FreshnessPolicy {
  /** Max age of a LIVE quote, in ms. */
  quoteMaxAgeMs: number;
  /**
   * Max age of the newest candle, expressed as a multiple of the timeframe.
   * 2.5 means: a 1m series is stale once the newest bar is 150s old.
   */
  candleMaxAgeMultiple: number;
  /** Widest acceptable spread as a fraction of price (0.005 = 50 bps). */
  maxSpreadFraction: number;
}

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  quoteMaxAgeMs: 15_000,
  candleMaxAgeMultiple: 2.5,
  maxSpreadFraction: 0.005,
};

export type FreshnessVerdict = {
  /** Effective status after ageing. Never more optimistic than the input. */
  status: DataStatus;
  /** Age of the value in ms at evaluation time. */
  ageMs: number;
  /** True when the status permits live signal generation. */
  liveAnalysisAllowed: boolean;
  reason: string;
};

/**
 * Age a provenance stamp against the clock. A LIVE stamp that has outlived the
 * budget degrades to STALE — it is never silently kept as LIVE.
 *
 * HISTORICAL, PAPER and SIMULATED do not age: a closed daily bar from 2019 is
 * correctly HISTORICAL forever.
 */
export function evaluateProvenance(
  provenance: Provenance,
  maxAgeMs: number,
  now: number = Date.now()
): FreshnessVerdict {
  const ageMs = now - provenance.timestamp;

  if (provenance.status === "UNAVAILABLE") {
    return {
      status: "UNAVAILABLE",
      ageMs,
      liveAnalysisAllowed: false,
      reason: "No data available from the configured provider.",
    };
  }

  if (provenance.status === "HISTORICAL" || provenance.status === "SIMULATED") {
    return {
      status: provenance.status,
      ageMs,
      liveAnalysisAllowed: false,
      reason: `${provenance.status} data cannot drive live signals.`,
    };
  }

  if (provenance.status === "PAPER") {
    return {
      status: "PAPER",
      ageMs,
      liveAnalysisAllowed: false,
      reason: "Paper-trading data is simulated execution, not a market feed.",
    };
  }

  // A timestamp in the future beyond a small tolerance means a clock or parsing
  // fault upstream. Treating it as fresh would let a broken feed drive orders.
  if (ageMs < -5_000) {
    return {
      status: "STALE",
      ageMs,
      liveAnalysisAllowed: false,
      reason: `Timestamp is ${Math.abs(ageMs)}ms in the future — clock or feed fault.`,
    };
  }

  if (ageMs > maxAgeMs) {
    return {
      status: "STALE",
      ageMs,
      liveAnalysisAllowed: false,
      reason: `Data is ${ageMs}ms old, exceeding the ${maxAgeMs}ms freshness budget.`,
    };
  }

  return {
    status: provenance.status,
    ageMs,
    liveAnalysisAllowed: TRADEABLE_DATA_STATUSES.has(provenance.status),
    reason:
      provenance.status === "DELAYED"
        ? `Delayed feed, ${ageMs}ms old — signals are generated but flagged DELAYED.`
        : `Live feed, ${ageMs}ms old.`,
  };
}

export function evaluateQuote(
  quote: Quote,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS_POLICY,
  now: number = Date.now()
): FreshnessVerdict {
  return evaluateProvenance(quote.provenance, policy.quoteMaxAgeMs, now);
}

/**
 * A candle series is fresh when its newest bar is younger than
 * `candleMaxAgeMultiple` × the timeframe. Empty series are UNAVAILABLE, not
 * "fresh with no data".
 */
export function evaluateSeries(
  series: CandleSeries,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS_POLICY,
  now: number = Date.now()
): FreshnessVerdict {
  if (series.candles.length === 0) {
    return {
      status: "UNAVAILABLE",
      ageMs: 0,
      liveAnalysisAllowed: false,
      reason: "Candle series is empty.",
    };
  }
  const newest = series.candles[series.candles.length - 1];
  const budget = TIMEFRAME_MS[series.timeframe] * policy.candleMaxAgeMultiple;
  // The bar's own close time is what ages, not its open time.
  const closeTime = newest.timestamp + TIMEFRAME_MS[series.timeframe];
  return evaluateProvenance({ ...series.provenance, timestamp: closeTime }, budget, now);
}

/** Thrown when an engine is asked to produce a live signal from unusable data. */
export class StaleDataError extends Error {
  readonly code = "STALE_MARKET_DATA";
  readonly verdict: FreshnessVerdict;

  constructor(verdict: FreshnessVerdict) {
    super(`LIVE ANALYSIS DISABLED — ${verdict.reason}`);
    this.name = "StaleDataError";
    this.verdict = verdict;
  }
}

export function assertLiveAnalysisAllowed(verdict: FreshnessVerdict): void {
  if (!verdict.liveAnalysisAllowed) throw new StaleDataError(verdict);
}

/**
 * Detect structural defects in a series that would corrupt indicator maths:
 * out-of-order bars, duplicate timestamps, missing bars and impossible OHLC.
 * (§3 — "handle out-of-order events, duplicate events, missing candles".)
 */
export interface SeriesIntegrityReport {
  ok: boolean;
  outOfOrder: number;
  duplicates: number;
  /** Count of expected bars absent from the series (regular sessions only). */
  gaps: number;
  invalidOhlc: number;
  issues: string[];
}

export function inspectSeriesIntegrity(
  candles: readonly {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[],
  timeframe: Timeframe
): SeriesIntegrityReport {
  const issues: string[] = [];
  let outOfOrder = 0;
  let duplicates = 0;
  let gaps = 0;
  let invalidOhlc = 0;
  const step = TIMEFRAME_MS[timeframe];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close) ||
      c.high < c.low ||
      c.high < c.open ||
      c.high < c.close ||
      c.low > c.open ||
      c.low > c.close ||
      c.volume < 0
    ) {
      invalidOhlc++;
    }
    if (i === 0) continue;
    const prev = candles[i - 1];
    const delta = c.timestamp - prev.timestamp;
    if (delta === 0) duplicates++;
    else if (delta < 0) outOfOrder++;
    else if (delta > step) gaps += Math.round(delta / step) - 1;
  }

  if (outOfOrder > 0) issues.push(`${outOfOrder} out-of-order bar(s)`);
  if (duplicates > 0) issues.push(`${duplicates} duplicate timestamp(s)`);
  if (invalidOhlc > 0) issues.push(`${invalidOhlc} bar(s) with impossible OHLC`);
  if (gaps > 0) issues.push(`${gaps} missing bar(s)`);

  return {
    ok: outOfOrder === 0 && duplicates === 0 && invalidOhlc === 0,
    outOfOrder,
    duplicates,
    gaps,
    invalidOhlc,
    issues,
  };
}

/**
 * Normalise a raw provider series: drop impossible bars, de-duplicate by
 * timestamp (last write wins, matching how streaming updates revise a forming
 * bar) and sort ascending. Returns a new array; never mutates the input.
 */
export function normalizeCandles<
  T extends {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  },
>(candles: readonly T[]): T[] {
  const byTimestamp = new Map<number, T>();
  for (const c of candles) {
    if (
      !Number.isFinite(c.timestamp) ||
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close) ||
      c.high < c.low
    ) {
      continue;
    }
    byTimestamp.set(c.timestamp, c);
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}
