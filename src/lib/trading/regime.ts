/**
 * Market regime detection and regime-adaptive weighting (master spec §16).
 *
 * The regime does not change WHAT is measured — it changes how much each
 * measurement counts. In a strong trend, trend and momentum dominate; in a
 * range, levels and mean reversion do; in extreme volatility, risk controls
 * tighten and every directional factor is discounted.
 */

import { computeIndicatorSet, lastDefinedIndex } from "./indicators";
import { classifyVolatility } from "./structure";
import type { Candle } from "./types";

export type MarketRegime =
  | "trending"
  | "ranging"
  | "high_volatility"
  | "low_volatility"
  | "breakout"
  | "panic"
  | "momentum"
  | "mean_reversion"
  | "undetermined";

/** Score-component weights, summing to 1 within each regime. */
export interface FactorWeights {
  trend: number;
  momentum: number;
  volume: number;
  volatility: number;
  structure: number;
  levels: number;
  vwap: number;
  mtfAlignment: number;
  news: number;
  fundamentals: number;
  riskReward: number;
}

export interface RegimeAssessment {
  regime: MarketRegime;
  /** Conviction in the regime label, [0,1]. */
  confidence: number;
  weights: FactorWeights;
  /** Multiplier applied to permitted position size, [0,1]. */
  riskMultiplier: number;
  evidence: string[];
}

function normalize(weights: FactorWeights): FactorWeights {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total === 0) return weights;
  const out = {} as FactorWeights;
  for (const [key, value] of Object.entries(weights)) {
    out[key as keyof FactorWeights] = value / total;
  }
  return out;
}

const BASE_WEIGHTS: FactorWeights = {
  trend: 0.16,
  momentum: 0.12,
  volume: 0.1,
  volatility: 0.08,
  structure: 0.14,
  levels: 0.1,
  vwap: 0.06,
  mtfAlignment: 0.14,
  news: 0.04,
  fundamentals: 0.02,
  riskReward: 0.04,
};

const REGIME_WEIGHTS: Record<MarketRegime, FactorWeights> = {
  // Trend + momentum dominate; levels matter less because they keep breaking.
  trending: normalize({
    ...BASE_WEIGHTS,
    trend: 0.26,
    momentum: 0.18,
    mtfAlignment: 0.18,
    levels: 0.05,
    structure: 0.14,
  }),
  momentum: normalize({
    ...BASE_WEIGHTS,
    momentum: 0.26,
    volume: 0.18,
    trend: 0.18,
    levels: 0.05,
  }),
  // In a range, the edges are the trade; trend-following is a losing read.
  ranging: normalize({
    ...BASE_WEIGHTS,
    levels: 0.26,
    structure: 0.2,
    trend: 0.06,
    momentum: 0.08,
    vwap: 0.12,
  }),
  mean_reversion: normalize({
    ...BASE_WEIGHTS,
    levels: 0.24,
    vwap: 0.16,
    momentum: 0.06,
    trend: 0.06,
    volatility: 0.12,
  }),
  breakout: normalize({
    ...BASE_WEIGHTS,
    volume: 0.22,
    structure: 0.2,
    volatility: 0.12,
    momentum: 0.16,
  }),
  // Volatility regimes discount every directional read and lean on risk terms.
  high_volatility: normalize({
    ...BASE_WEIGHTS,
    volatility: 0.2,
    riskReward: 0.14,
    trend: 0.1,
    momentum: 0.08,
    news: 0.08,
  }),
  low_volatility: normalize({
    ...BASE_WEIGHTS,
    structure: 0.18,
    levels: 0.16,
    volatility: 0.12,
  }),
  // Panic: nothing technical is reliable; this regime exists to say "stand down".
  panic: normalize({
    ...BASE_WEIGHTS,
    volatility: 0.26,
    riskReward: 0.18,
    news: 0.14,
    trend: 0.06,
    momentum: 0.04,
  }),
  undetermined: BASE_WEIGHTS,
};

/** How much of the normal position size each regime permits (§16). */
const REGIME_RISK_MULTIPLIER: Record<MarketRegime, number> = {
  trending: 1,
  momentum: 1,
  breakout: 0.9,
  ranging: 0.8,
  mean_reversion: 0.8,
  low_volatility: 1,
  high_volatility: 0.5,
  panic: 0.25,
  undetermined: 0.6,
};

export interface RegimeInput {
  candles: readonly Candle[];
  /** Aggregate MTF bias in [-1,1], when available. */
  mtfBias?: number;
}

/**
 * Classify the regime from ADX (trend strength), ATR behaviour (volatility) and
 * recent range expansion.
 *
 * Thresholds follow Wilder's conventional readings: ADX above 25 is a trending
 * market, below 20 is not.
 */
export function detectRegime(input: RegimeInput): RegimeAssessment {
  const { candles } = input;
  const evidence: string[] = [];

  if (candles.length < 40) {
    return {
      regime: "undetermined",
      confidence: 0,
      weights: REGIME_WEIGHTS.undetermined,
      riskMultiplier: REGIME_RISK_MULTIPLIER.undetermined,
      evidence: [`Only ${candles.length} bars available — too few to classify a regime.`],
    };
  }

  const indicators = computeIndicatorSet(candles);
  const adxIndex = lastDefinedIndex(indicators.adx.adx);
  const adxValue = adxIndex >= 0 ? (indicators.adx.adx[adxIndex] as number) : null;
  const { regime: volRegime, atrPercent } = classifyVolatility(candles);

  const bbIndex = lastDefinedIndex(indicators.bollinger.bandwidth);
  const bandwidth = bbIndex >= 0 ? (indicators.bollinger.bandwidth[bbIndex] as number) : null;

  const rvIndex = lastDefinedIndex(indicators.relativeVolume);
  const relVolume = rvIndex >= 0 ? (indicators.relativeVolume[rvIndex] as number) : null;

  if (adxValue !== null) evidence.push(`ADX(14) = ${adxValue.toFixed(1)}.`);
  if (atrPercent !== null) evidence.push(`ATR is ${(atrPercent * 100).toFixed(2)}% of price.`);
  if (relVolume !== null) evidence.push(`Relative volume ${relVolume.toFixed(2)}×.`);
  if (bandwidth !== null) evidence.push(`Bollinger bandwidth ${(bandwidth * 100).toFixed(2)}%.`);

  // Declared without initialisers: the branch chain below is exhaustive (it ends
  // in an else), so any default here would be dead code.
  let regime: MarketRegime;
  let confidence: number;

  // Panic first: extreme volatility overrides every other read.
  if (atrPercent !== null && atrPercent > 0.08) {
    regime = "panic";
    confidence = 0.8;
    evidence.push("ATR above 8% of price — treating conditions as disorderly.");
  } else if (volRegime === "expansion" && relVolume !== null && relVolume > 2) {
    regime = "breakout";
    confidence = 0.7;
    evidence.push("Volatility expanding on above-average volume.");
  } else if (atrPercent !== null && atrPercent > 0.04) {
    regime = "high_volatility";
    confidence = 0.7;
  } else if (adxValue !== null && adxValue >= 25) {
    regime = relVolume !== null && relVolume > 1.5 ? "momentum" : "trending";
    confidence = Math.min(1, adxValue / 50);
    evidence.push("ADX at or above 25 — a directional trend is present.");
  } else if (adxValue !== null && adxValue < 20) {
    regime = volRegime === "compression" ? "low_volatility" : "ranging";
    confidence = Math.min(1, (20 - adxValue) / 20 + 0.4);
    evidence.push("ADX below 20 — no directional trend; treating as a range.");
  } else {
    regime = "mean_reversion";
    confidence = 0.5;
    evidence.push("ADX between 20 and 25 — transitional; favouring mean reversion.");
  }

  return {
    regime,
    confidence,
    weights: REGIME_WEIGHTS[regime],
    riskMultiplier: REGIME_RISK_MULTIPLIER[regime],
    evidence,
  };
}

export function weightsForRegime(regime: MarketRegime): FactorWeights {
  return REGIME_WEIGHTS[regime];
}

export function riskMultiplierForRegime(regime: MarketRegime): number {
  return REGIME_RISK_MULTIPLIER[regime];
}
