/**
 * Multi-timeframe intelligence (master spec §7).
 *
 * Reads the same instrument across several timeframes and reports both the
 * per-timeframe trend and — crucially — the CONFLICTS between them.
 *
 * The spec's worked example is the whole point of this module: 1D/4H/1H bullish
 * with 15m bearish must read "higher-timeframe bullish trend with short-term
 * pullback", not "BUY". A system that collapses that into one direction is
 * hiding the information a trader most needs.
 */

import { analyzeStructure, type MarketStructure, type TrendState } from "./structure";
import { computeIndicatorSet, lastDefinedIndex } from "./indicators";
import type { Candle, Timeframe } from "./types";

/** Horizon each timeframe speaks to. */
export type TrendHorizon = "short_term" | "intraday" | "swing" | "higher";

export const TIMEFRAME_HORIZON: Readonly<Record<Timeframe, TrendHorizon>> = {
  "1m": "short_term",
  "3m": "short_term",
  "5m": "short_term",
  "15m": "intraday",
  "30m": "intraday",
  "1H": "intraday",
  "2H": "swing",
  "4H": "swing",
  "1D": "higher",
  "1W": "higher",
};

/** Weight each horizon carries in the aggregate bias. */
const HORIZON_WEIGHT: Readonly<Record<TrendHorizon, number>> = {
  higher: 4,
  swing: 3,
  intraday: 2,
  short_term: 1,
};

export interface TimeframeView {
  timeframe: Timeframe;
  horizon: TrendHorizon;
  trend: TrendState;
  trendStrength: number;
  /** +1 fully bullish, −1 fully bearish, 0 neutral/undetermined. */
  bias: number;
  close: number | null;
  ema200: number | null;
  rsi: number | null;
  structure: MarketStructure;
  evidence: string;
}

export type MtfAlignment = "aligned_bullish" | "aligned_bearish" | "conflicted" | "neutral";

export interface MtfAnalysis {
  views: TimeframeView[];
  alignment: MtfAlignment;
  /** Weighted directional bias across timeframes, in [-1, 1]. */
  aggregateBias: number;
  /** Share of weight agreeing with the dominant direction, in [0, 1]. */
  agreement: number;
  conflicts: string[];
  /** One-sentence reading a human can act on. Never collapses a conflict. */
  narrative: string;
}

function trendToBias(trend: TrendState, strength: number): number {
  if (trend === "uptrend") return strength;
  if (trend === "downtrend") return -strength;
  return 0;
}

export function analyzeTimeframe(timeframe: Timeframe, candles: readonly Candle[]): TimeframeView {
  const structure = analyzeStructure(candles);
  const indicators = computeIndicatorSet(candles);
  const closeIndex = candles.length - 1;
  const ema200Index = lastDefinedIndex(indicators.ema200);
  const rsiIndex = lastDefinedIndex(indicators.rsi);

  const close = closeIndex >= 0 ? candles[closeIndex].close : null;
  const ema200 = ema200Index >= 0 ? (indicators.ema200[ema200Index] as number) : null;
  const rsiValue = rsiIndex >= 0 ? (indicators.rsi[rsiIndex] as number) : null;

  const parts: string[] = [structure.rationale[0] ?? "No structure available."];
  if (close !== null && ema200 !== null) {
    parts.push(
      `Price ${close.toFixed(4)} is ${close > ema200 ? "above" : "below"} the 200 EMA (${ema200.toFixed(4)}).`
    );
  }
  if (rsiValue !== null) parts.push(`RSI(14) ${rsiValue.toFixed(1)}.`);

  return {
    timeframe,
    horizon: TIMEFRAME_HORIZON[timeframe],
    trend: structure.trend,
    trendStrength: structure.trendStrength,
    bias: trendToBias(structure.trend, structure.trendStrength),
    close,
    ema200,
    rsi: rsiValue,
    structure,
    evidence: parts.join(" "),
  };
}

/**
 * Combine per-timeframe readings. Higher timeframes carry more weight, but a
 * disagreeing lower timeframe is surfaced as a conflict rather than outvoted
 * into silence.
 */
export function analyzeMultiTimeframe(
  series: ReadonlyArray<{ timeframe: Timeframe; candles: readonly Candle[] }>
): MtfAnalysis {
  const views = series.map((s) => analyzeTimeframe(s.timeframe, s.candles));

  if (views.length === 0) {
    return {
      views,
      alignment: "neutral",
      aggregateBias: 0,
      agreement: 0,
      conflicts: [],
      narrative: "No timeframe data available.",
    };
  }

  let weightedSum = 0;
  let totalWeight = 0;
  let bullishWeight = 0;
  let bearishWeight = 0;

  for (const view of views) {
    const weight = HORIZON_WEIGHT[view.horizon];
    weightedSum += view.bias * weight;
    totalWeight += weight;
    if (view.trend === "uptrend") bullishWeight += weight;
    else if (view.trend === "downtrend") bearishWeight += weight;
  }

  const aggregateBias = totalWeight === 0 ? 0 : weightedSum / totalWeight;
  const directionalWeight = bullishWeight + bearishWeight;
  const agreement =
    directionalWeight === 0 ? 0 : Math.max(bullishWeight, bearishWeight) / directionalWeight;

  const conflicts: string[] = [];
  const sorted = [...views].sort((a, b) => HORIZON_WEIGHT[b.horizon] - HORIZON_WEIGHT[a.horizon]);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const higher = sorted[i];
      const lower = sorted[j];
      const opposed =
        (higher.trend === "uptrend" && lower.trend === "downtrend") ||
        (higher.trend === "downtrend" && lower.trend === "uptrend");
      if (opposed) {
        conflicts.push(
          `${higher.timeframe} is in a ${higher.trend} while ${lower.timeframe} is in a ${lower.trend}.`
        );
      }
    }
  }

  let alignment: MtfAlignment;
  if (conflicts.length > 0) alignment = "conflicted";
  else if (bullishWeight > 0 && bearishWeight === 0) alignment = "aligned_bullish";
  else if (bearishWeight > 0 && bullishWeight === 0) alignment = "aligned_bearish";
  else alignment = "neutral";

  return {
    views,
    alignment,
    aggregateBias,
    agreement,
    conflicts,
    narrative: buildNarrative(sorted, alignment, conflicts),
  };
}

/**
 * Build the human reading. The conflicted branch deliberately describes the
 * higher-timeframe trend AND the lower-timeframe counter-move, because that
 * combination ("pullback" vs "reversal") is the decision, not noise to discard.
 */
function buildNarrative(
  sortedByHorizon: readonly TimeframeView[],
  alignment: MtfAlignment,
  conflicts: readonly string[]
): string {
  const dominant = sortedByHorizon[0];
  if (!dominant) return "No timeframe data available.";

  if (alignment === "aligned_bullish") {
    return `Bullish across every analysed timeframe (${sortedByHorizon.map((v) => v.timeframe).join(", ")}).`;
  }
  if (alignment === "aligned_bearish") {
    return `Bearish across every analysed timeframe (${sortedByHorizon.map((v) => v.timeframe).join(", ")}).`;
  }
  if (alignment === "conflicted") {
    const counter = sortedByHorizon.find(
      (v) =>
        (dominant.trend === "uptrend" && v.trend === "downtrend") ||
        (dominant.trend === "downtrend" && v.trend === "uptrend")
    );
    if (dominant.trend === "uptrend" && counter) {
      return `Higher-timeframe bullish trend (${dominant.timeframe}) with a short-term pullback on ${counter.timeframe}. Not a sell signal, and not yet a confirmed buy.`;
    }
    if (dominant.trend === "downtrend" && counter) {
      return `Higher-timeframe bearish trend (${dominant.timeframe}) with a short-term bounce on ${counter.timeframe}. Not a buy signal, and not yet a confirmed sell.`;
    }
    return `Timeframes disagree: ${conflicts[0]}`;
  }
  return `No clear directional structure on ${sortedByHorizon.map((v) => v.timeframe).join(", ")} — ranging or undetermined.`;
}
