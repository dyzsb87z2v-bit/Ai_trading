/**
 * Market structure engine (master spec §6).
 *
 * Detects swing points, trend classification from HH/HL/LH/LL sequences,
 * support/resistance, breakouts and their failures, structure breaks (BOS),
 * change of character (CHoCH) and volatility expansion/compression.
 *
 * SCOPE HONESTY (§6): everything here is derived from OHLCV alone. This module
 * does not claim to see institutional order flow, dark-pool prints or resting
 * liquidity — OHLCV cannot support those claims. "Liquidity area" here means
 * precisely "a price level with a cluster of prior swing points", which is what
 * the data can actually evidence.
 */

import type { Candle } from "./types";
import { atr, realizedVolatility } from "./indicators/volatility";
import { sma } from "./indicators/movingAverages";

export type SwingKind = "high" | "low";

export interface SwingPoint {
  index: number;
  timestamp: number;
  price: number;
  kind: SwingKind;
}

export type StructureLabel = "HH" | "HL" | "LH" | "LL";

export interface LabelledSwing extends SwingPoint {
  /** Null for the first swing of each kind — nothing to compare against. */
  label: StructureLabel | null;
}

export type TrendState = "uptrend" | "downtrend" | "range" | "undetermined";

export type StructureEventKind =
  | "breakout"
  | "breakdown"
  | "fakeout"
  | "break_of_structure"
  | "change_of_character"
  | "momentum_shift";

export interface StructureEvent {
  kind: StructureEventKind;
  index: number;
  timestamp: number;
  price: number;
  /** The level that was broken or reclaimed. */
  level: number;
  evidence: string;
}

export interface PriceLevel {
  price: number;
  /** How many swing points cluster at this level. */
  touches: number;
  kind: "support" | "resistance";
  lastTouchIndex: number;
}

export type VolatilityRegime = "expansion" | "compression" | "normal" | "unknown";

export interface MarketStructure {
  swings: LabelledSwing[];
  trend: TrendState;
  /** Conviction in the trend label, [0,1]. */
  trendStrength: number;
  events: StructureEvent[];
  support: PriceLevel[];
  resistance: PriceLevel[];
  volatility: VolatilityRegime;
  /** Current ATR as a fraction of price; null before warm-up. */
  atrPercent: number | null;
  rationale: string[];
}

export interface StructureOptions {
  /** Bars either side that a swing must dominate to count. */
  swingLookback?: number;
  /** Levels within this fraction of each other merge into one. */
  levelTolerance?: number;
  atrPeriod?: number;
}

const DEFAULTS: Required<StructureOptions> = {
  swingLookback: 3,
  levelTolerance: 0.0025,
  atrPeriod: 14,
};

/**
 * Fractal swing detection: a swing high is a bar whose high is strictly greater
 * than the highs of the `lookback` bars either side.
 *
 * Requiring a confirmed right side means the newest `lookback` bars can never
 * produce a swing. That lag is real and is preserved deliberately — "detecting"
 * a swing before its right side exists is look-ahead bias (§18).
 */
export function findSwings(
  candles: readonly Candle[],
  lookback = DEFAULTS.swingLookback
): SwingPoint[] {
  if (lookback < 1) throw new RangeError("swingLookback must be at least 1");
  const swings: SwingPoint[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) {
      swings.push({
        index: i,
        timestamp: candles[i].timestamp,
        price: candles[i].high,
        kind: "high",
      });
    }
    if (isLow) {
      swings.push({
        index: i,
        timestamp: candles[i].timestamp,
        price: candles[i].low,
        kind: "low",
      });
    }
  }
  return swings.sort((a, b) => a.index - b.index);
}

/** Label each swing HH/HL/LH/LL against the previous swing of the same kind. */
export function labelSwings(swings: readonly SwingPoint[]): LabelledSwing[] {
  let lastHigh: SwingPoint | null = null;
  let lastLow: SwingPoint | null = null;

  return swings.map((swing) => {
    let label: StructureLabel | null = null;
    if (swing.kind === "high") {
      if (lastHigh) label = swing.price > lastHigh.price ? "HH" : "LH";
      lastHigh = swing;
    } else {
      if (lastLow) label = swing.price > lastLow.price ? "HL" : "LL";
      lastLow = swing;
    }
    return { ...swing, label };
  });
}

/**
 * Classify trend from the most recent labelled swings.
 *
 * An uptrend requires BOTH higher highs and higher lows in the recent window —
 * higher highs alone (with lower lows) is a broadening formation, not a trend,
 * and calling it one is how a system talks a user into a bad entry.
 */
export function classifyTrend(
  swings: readonly LabelledSwing[],
  windowSize = 4
): { trend: TrendState; strength: number; rationale: string } {
  const labelled = swings.filter((s) => s.label !== null);
  if (labelled.length < 2) {
    return {
      trend: "undetermined",
      strength: 0,
      rationale: "Fewer than two labelled swings — not enough structure to classify.",
    };
  }

  const recent = labelled.slice(-Math.max(2, windowSize));
  const counts = { HH: 0, HL: 0, LH: 0, LL: 0 };
  for (const swing of recent) counts[swing.label as StructureLabel]++;

  const bullish = counts.HH + counts.HL;
  const bearish = counts.LH + counts.LL;
  const total = recent.length;

  const hasBothBullish = counts.HH > 0 && counts.HL > 0;
  const hasBothBearish = counts.LH > 0 && counts.LL > 0;

  if (hasBothBullish && bullish > bearish) {
    return {
      trend: "uptrend",
      strength: bullish / total,
      rationale: `${counts.HH} higher high(s) and ${counts.HL} higher low(s) in the last ${total} swings.`,
    };
  }
  if (hasBothBearish && bearish > bullish) {
    return {
      trend: "downtrend",
      strength: bearish / total,
      rationale: `${counts.LH} lower high(s) and ${counts.LL} lower low(s) in the last ${total} swings.`,
    };
  }
  return {
    trend: "range",
    strength: 1 - Math.abs(bullish - bearish) / total,
    rationale: `Mixed structure (${counts.HH} HH, ${counts.HL} HL, ${counts.LH} LH, ${counts.LL} LL) — no directional sequence.`,
  };
}

/**
 * Cluster swing points into support and resistance levels. A level's strength
 * is how many swings touched it, so a level tested four times outranks one that
 * formed on a single wick.
 */
export function findLevels(
  swings: readonly SwingPoint[],
  tolerance = DEFAULTS.levelTolerance
): { support: PriceLevel[]; resistance: PriceLevel[] } {
  const cluster = (points: readonly SwingPoint[], kind: "support" | "resistance"): PriceLevel[] => {
    const levels: PriceLevel[] = [];
    for (const point of points) {
      const match = levels.find(
        (level) => Math.abs(level.price - point.price) / level.price <= tolerance
      );
      if (match) {
        // Running mean keeps the level centred on every touch, not the first.
        match.price = (match.price * match.touches + point.price) / (match.touches + 1);
        match.touches++;
        match.lastTouchIndex = Math.max(match.lastTouchIndex, point.index);
      } else {
        levels.push({ price: point.price, touches: 1, kind, lastTouchIndex: point.index });
      }
    }
    return levels.sort((a, b) => b.touches - a.touches || b.lastTouchIndex - a.lastTouchIndex);
  };

  return {
    support: cluster(
      swings.filter((s) => s.kind === "low"),
      "support"
    ),
    resistance: cluster(
      swings.filter((s) => s.kind === "high"),
      "resistance"
    ),
  };
}

/**
 * Detect structure events by walking bars forward and comparing each close to
 * the most recent CONFIRMED swing levels.
 *
 * Confirmation matters: a swing at bar i is only known at bar i + lookback, so
 * events are evaluated against swings that were already visible. Using a swing
 * before its confirmation bar would leak the future into the signal.
 */
export function detectStructureEvents(
  candles: readonly Candle[],
  swings: readonly LabelledSwing[],
  options: StructureOptions = {}
): StructureEvent[] {
  const o = { ...DEFAULTS, ...options };
  const events: StructureEvent[] = [];
  if (candles.length === 0) return events;

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const atrSeries = atr(highs, lows, closes, o.atrPeriod);

  /** Pending breakouts awaiting confirmation or failure. */
  const pending: { index: number; level: number; direction: "up" | "down" }[] = [];

  for (let i = 1; i < candles.length; i++) {
    const visible = swings.filter((s) => s.index + o.swingLookback <= i);
    const lastHigh = [...visible].reverse().find((s) => s.kind === "high");
    const lastLow = [...visible].reverse().find((s) => s.kind === "low");
    const candle = candles[i];
    const band = atrSeries[i] ?? 0;

    if (lastHigh && candles[i - 1].close <= lastHigh.price && candle.close > lastHigh.price) {
      events.push({
        kind: "breakout",
        index: i,
        timestamp: candle.timestamp,
        price: candle.close,
        level: lastHigh.price,
        evidence: `Close ${candle.close} cleared the prior swing high ${lastHigh.price.toFixed(4)}.`,
      });
      pending.push({ index: i, level: lastHigh.price, direction: "up" });

      // Taking out a swing high while the trend was making lower highs is a
      // break of structure, not just a breakout.
      if (lastHigh.label === "LH") {
        events.push({
          kind: "break_of_structure",
          index: i,
          timestamp: candle.timestamp,
          price: candle.close,
          level: lastHigh.price,
          evidence: `Lower-high ${lastHigh.price.toFixed(4)} taken out — bearish sequence broken.`,
        });
      }
    }

    if (lastLow && candles[i - 1].close >= lastLow.price && candle.close < lastLow.price) {
      events.push({
        kind: "breakdown",
        index: i,
        timestamp: candle.timestamp,
        price: candle.close,
        level: lastLow.price,
        evidence: `Close ${candle.close} lost the prior swing low ${lastLow.price.toFixed(4)}.`,
      });
      pending.push({ index: i, level: lastLow.price, direction: "down" });

      if (lastLow.label === "HL") {
        events.push({
          kind: "change_of_character",
          index: i,
          timestamp: candle.timestamp,
          price: candle.close,
          level: lastLow.price,
          evidence: `Higher-low ${lastLow.price.toFixed(4)} lost — bullish sequence broken.`,
        });
      }
    }

    // A breakout that closes back inside the level within a few bars is a
    // fakeout. This is the single most useful "do not trade" pattern (§35).
    for (let p = pending.length - 1; p >= 0; p--) {
      const entry = pending[p];
      const barsSince = i - entry.index;
      if (barsSince === 0) continue;
      const failedUp = entry.direction === "up" && candle.close < entry.level;
      const failedDown = entry.direction === "down" && candle.close > entry.level;
      if (failedUp || failedDown) {
        events.push({
          kind: "fakeout",
          index: i,
          timestamp: candle.timestamp,
          price: candle.close,
          level: entry.level,
          evidence: `Price returned through ${entry.level.toFixed(4)} ${barsSince} bar(s) after breaking it — breakout failed.`,
        });
        pending.splice(p, 1);
      } else if (barsSince > 5) {
        pending.splice(p, 1);
      }
    }

    // Momentum shift: a bar whose range dwarfs the prevailing ATR.
    if (band > 0 && candle.high - candle.low > band * 2) {
      events.push({
        kind: "momentum_shift",
        index: i,
        timestamp: candle.timestamp,
        price: candle.close,
        level: candle.close,
        evidence: `Bar range ${(candle.high - candle.low).toFixed(4)} exceeded 2× ATR (${band.toFixed(4)}).`,
      });
    }
  }

  return events;
}

/**
 * Volatility regime from ATR relative to its own recent average — expansion
 * when current ATR runs 30% hot, compression when it runs 30% cold.
 */
export function classifyVolatility(
  candles: readonly Candle[],
  period = DEFAULTS.atrPeriod
): { regime: VolatilityRegime; atrPercent: number | null } {
  if (candles.length < period * 3) return { regime: "unknown", atrPercent: null };

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const atrSeries = atr(highs, lows, closes, period);
  const last = atrSeries[atrSeries.length - 1];
  const lastClose = closes[closes.length - 1];
  if (last === null || lastClose === 0) return { regime: "unknown", atrPercent: null };

  const defined = atrSeries.filter((v): v is number => v !== null);
  const baseline = sma(defined, Math.min(period * 2, defined.length));
  const reference = baseline[baseline.length - 1];
  const atrPercent = last / lastClose;

  if (reference === null || reference === 0) return { regime: "unknown", atrPercent };
  const ratio = last / reference;
  if (ratio > 1.3) return { regime: "expansion", atrPercent };
  if (ratio < 0.7) return { regime: "compression", atrPercent };
  return { regime: "normal", atrPercent };
}

/** Full structure analysis for one series. */
export function analyzeStructure(
  candles: readonly Candle[],
  options: StructureOptions = {}
): MarketStructure {
  const o = { ...DEFAULTS, ...options };
  const swings = labelSwings(findSwings(candles, o.swingLookback));
  const { trend, strength, rationale } = classifyTrend(swings);
  const { support, resistance } = findLevels(swings, o.levelTolerance);
  const events = detectStructureEvents(candles, swings, o);
  const { regime, atrPercent } = classifyVolatility(candles, o.atrPeriod);

  const rationales = [rationale];
  const recentEvents = events.filter((e) => e.index >= candles.length - 10);
  for (const event of recentEvents.slice(-3)) {
    rationales.push(`${event.kind.replace(/_/g, " ")}: ${event.evidence}`);
  }
  if (regime !== "unknown") {
    rationales.push(
      `Volatility regime: ${regime}${atrPercent !== null ? ` (ATR ${(atrPercent * 100).toFixed(2)}% of price)` : ""}.`
    );
  }

  return {
    swings,
    trend,
    trendStrength: strength,
    events,
    support: support.slice(0, 5),
    resistance: resistance.slice(0, 5),
    volatility: regime,
    atrPercent,
    rationale: rationales,
  };
}

/**
 * Annualisation factors for realised volatility, per timeframe. Exported so
 * callers cannot silently pass a daily factor to an intraday series.
 */
export function barsPerYear(timeframeMs: number): number {
  const tradingDaysPerYear = 252;
  const msPerTradingDay = 6.5 * 3_600_000;
  if (timeframeMs >= 86_400_000) return tradingDaysPerYear * (86_400_000 / timeframeMs);
  return tradingDaysPerYear * (msPerTradingDay / timeframeMs);
}

export { realizedVolatility };
