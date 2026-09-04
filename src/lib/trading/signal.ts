/**
 * Signal engine and Trade Quality Score (master spec §8, §34, §36, §37).
 *
 * A transparent, regime-weighted scoring model. Every number it emits can be
 * traced to a named factor with cited evidence — there is no path through this
 * module that produces a score without the factors that made it (§34).
 *
 * On "confidence" (§8): the value reported is the model's INTERNAL AGREEMENT —
 * how strongly the factors concur — not a probability of profit. It is not
 * calibrated against outcomes, and the field name and docs say so, because
 * presenting agreement as win probability is the most consequential lie a
 * trading system can tell.
 */

import type { FactorWeights, RegimeAssessment } from "./regime";
import type { MarketStructure } from "./structure";
import type { MtfAnalysis } from "./mtf";
import type { IndicatorSet } from "./indicators";
import { lastDefinedIndex } from "./indicators";
import { clampUnit } from "./indicators/types";
import type { NewsArticle } from "./providers/types";
import type { Candle, ScoreFactor, SignalState, Warning } from "./types";

export type TradeGrade = "A+" | "A" | "B" | "C" | "NO_TRADE";

export interface SignalThresholds {
  strongBuy: number;
  buy: number;
  sell: number;
  strongSell: number;
  /** Below this score, no directional trade is proposed at all. */
  minimumTradeable: number;
  gradeAPlus: number;
  gradeA: number;
  gradeB: number;
  gradeC: number;
}

/** User-configurable per §36. */
export const DEFAULT_THRESHOLDS: SignalThresholds = {
  strongBuy: 80,
  buy: 65,
  sell: 35,
  strongSell: 20,
  minimumTradeable: 60,
  gradeAPlus: 90,
  gradeA: 80,
  gradeB: 70,
  gradeC: 60,
};

export interface SignalInput {
  candles: readonly Candle[];
  indicators: IndicatorSet;
  structure: MarketStructure;
  regime: RegimeAssessment;
  mtf: MtfAnalysis | null;
  news?: readonly NewsArticle[];
  /** Fundamental bias in [-1,1] if a provider supplied one; null otherwise. */
  fundamentalBias?: number | null;
  /** Risk:reward of the proposed setup, when levels have been computed. */
  riskReward?: number | null;
  minRiskReward?: number;
  thresholds?: SignalThresholds;
  /** False when data is stale — forces NO_TRADE regardless of score (§3). */
  liveDataAvailable: boolean;
}

export interface SignalResult {
  /** 0–100, where 50 is neutral. */
  score: number;
  state: SignalState;
  grade: TradeGrade;
  /**
   * Internal factor agreement in [0,1]. NOT a probability of profit and not
   * statistically calibrated — see the module header.
   */
  agreement: number;
  factors: ScoreFactor[];
  bullishReasons: string[];
  bearishReasons: string[];
  warnings: Warning[];
  tradeable: boolean;
  /** Plain-language answer to "why buy / why sell / why wait" (§34). */
  explanation: string;
}

/**
 * Score a setup.
 *
 * Each factor produces a reading in [-1, 1]; the weighted mean is mapped onto
 * 0–100 with 50 as neutral. Factors that cannot be computed are OMITTED and
 * their weight redistributed — scoring a missing input as 0 would quietly drag
 * every score toward neutral and disguise missing data as balance.
 */
export function computeSignal(input: SignalInput): SignalResult {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const weights = input.regime.weights;
  const factors: ScoreFactor[] = [];
  const warnings: Warning[] = [];

  pushIfDefined(factors, trendFactor(input, weights));
  pushIfDefined(factors, momentumFactor(input, weights));
  pushIfDefined(factors, volumeFactor(input, weights));
  pushIfDefined(factors, volatilityFactor(input, weights));
  pushIfDefined(factors, structureFactor(input, weights));
  pushIfDefined(factors, levelsFactor(input, weights));
  pushIfDefined(factors, vwapFactor(input, weights));
  pushIfDefined(factors, mtfFactor(input, weights));
  pushIfDefined(factors, newsFactor(input, weights));
  pushIfDefined(factors, fundamentalsFactor(input, weights));
  pushIfDefined(factors, riskRewardFactor(input, weights));

  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  const weightedSum = factors.reduce((sum, f) => sum + f.value * f.weight, 0);
  const netBias = totalWeight === 0 ? 0 : weightedSum / totalWeight;
  const score = clampScore(50 + netBias * 50);

  // Agreement: the share of weight pulling the same way as the net bias. High
  // agreement on a weak bias is still a weak signal — this only measures concord.
  const agreement = computeAgreement(factors, netBias);

  collectWarnings(input, warnings);

  const bullishReasons = factors
    .filter((f) => f.value > 0.15)
    .sort((a, b) => b.value * b.weight - a.value * a.weight)
    .map((f) => f.evidence);
  const bearishReasons = factors
    .filter((f) => f.value < -0.15)
    .sort((a, b) => a.value * a.weight - b.value * b.weight)
    .map((f) => f.evidence);

  const criticalWarnings = warnings.filter((w) => w.severity === "critical");
  const state = deriveState(score, input, thresholds, criticalWarnings.length > 0);
  const grade = deriveGrade(score, state, thresholds);

  const minRr = input.minRiskReward ?? 1.5;
  const rrOk =
    input.riskReward === null || input.riskReward === undefined ? false : input.riskReward >= minRr;

  const tradeable =
    input.liveDataAvailable &&
    criticalWarnings.length === 0 &&
    state !== "NO_TRADE" &&
    state !== "WAIT" &&
    state !== "HOLD" &&
    rrOk &&
    score >= thresholds.minimumTradeable;

  return {
    score,
    state,
    grade,
    agreement,
    factors,
    bullishReasons,
    bearishReasons,
    warnings,
    tradeable,
    explanation: explain(state, score, bullishReasons, bearishReasons, warnings, input),
  };
}

// ---------------------------------------------------------------------------
// Factors
// ---------------------------------------------------------------------------

function trendFactor(input: SignalInput, w: FactorWeights): ScoreFactor | null {
  const { indicators } = input;
  const emaIndex = lastDefinedIndex(indicators.ema200);
  const closeIndex = indicators.closes.length - 1;
  if (emaIndex < 0 || closeIndex < 0) return null;

  const price = indicators.closes[closeIndex];
  const ema200 = indicators.ema200[emaIndex] as number;
  const ema50 = indicators.ema50[lastDefinedIndex(indicators.ema50)] ?? null;
  const distance = (price - ema200) / ema200;

  // Saturate at 5% from the 200 EMA: beyond that, "further" is not "more bullish",
  // it is extended.
  let value = clampUnit(distance / 0.05);
  const stacked =
    ema50 !== null && ((price > ema200 && ema50 > ema200) || (price < ema200 && ema50 < ema200));
  if (stacked) value = clampUnit(value * 1.2);

  return {
    id: "trend.ema_structure",
    label: "Trend",
    value,
    weight: w.trend,
    evidence:
      `Price ${price.toFixed(4)} is ${(distance * 100).toFixed(2)}% ` +
      `${price > ema200 ? "above" : "below"} the 200 EMA` +
      (stacked ? `, with the 50 EMA on the same side (stacked).` : "."),
  };
}

function momentumFactor(input: SignalInput, w: FactorWeights): ScoreFactor | null {
  const { indicators } = input;
  const rsiIndex = lastDefinedIndex(indicators.rsi);
  const histIndex = lastDefinedIndex(indicators.macd.histogram);
  if (rsiIndex < 0 && histIndex < 0) return null;

  const parts: string[] = [];
  let sum = 0;
  let count = 0;

  if (rsiIndex >= 0) {
    const rsiValue = indicators.rsi[rsiIndex] as number;
    // RSI 50 is the neutral line; 30/70 saturate.
    sum += clampUnit((rsiValue - 50) / 20);
    count++;
    parts.push(`RSI(14) ${rsiValue.toFixed(1)}`);
  }
  if (histIndex >= 0) {
    const hist = indicators.macd.histogram[histIndex] as number;
    const price = indicators.closes[indicators.closes.length - 1] || 1;
    // Normalise the histogram against price so it is comparable across assets.
    sum += clampUnit(hist / price / 0.005);
    count++;
    parts.push(`MACD histogram ${hist >= 0 ? "positive" : "negative"} (${hist.toFixed(4)})`);
  }

  return {
    id: "momentum.rsi_macd",
    label: "Momentum",
    value: clampUnit(sum / count),
    weight: w.momentum,
    evidence: parts.join(", ") + ".",
  };
}

function volumeFactor(input: SignalInput, w: FactorWeights): ScoreFactor | null {
  const { indicators } = input;
  const rvIndex = lastDefinedIndex(indicators.relativeVolume);
  if (rvIndex < 0 || indicators.closes.length < 2) return null;

  const relVolume = indicators.relativeVolume[rvIndex] as number;
  const price = indicators.closes[indicators.closes.length - 1];
  const previous = indicators.closes[indicators.closes.length - 2];
  const direction = price > previous ? 1 : price < previous ? -1 : 0;

  // Volume confirms direction; it has no direction of its own. Heavy volume on
  // a down bar is bearish confirmation, not a bullish "high interest" reading.
  const magnitude = clampUnit((relVolume - 1) / 1.5);
  return {
    id: "volume.confirmation",
    label: "Volume",
    value: clampUnit(magnitude * direction),
    weight: w.volume,
    evidence: `Relative volume ${relVolume.toFixed(2)}× on a ${
      direction > 0 ? "rising" : direction < 0 ? "falling" : "flat"
    } bar.`,
  };
}

function volatilityFactor(input: SignalInput, w: FactorWeights): ScoreFactor | null {
  const { structure } = input;
  if (structure.atrPercent === null) return null;

  // Volatility is not directional. It scores negatively when extreme, because
  // extreme volatility degrades every other reading and widens stops.
  const atrPct = structure.atrPercent;
  let value = 0;
  let note = `ATR is ${(atrPct * 100).toFixed(2)}% of price — normal.`;
  if (atrPct > 0.05) {
    value = -clampUnit((atrPct - 0.05) / 0.05);
    note = `ATR is ${(atrPct * 100).toFixed(2)}% of price — elevated; stops must widen and slippage rises.`;
  } else if (structure.volatility === "compression") {
    value = 0.1;
    note = `Volatility compressed (ATR ${(atrPct * 100).toFixed(2)}% of price) — expansion often follows, direction unknown.`;
  }
  return {
    id: "volatility.atr_regime",
    label: "Volatility",
    value,
    weight: w.volatility,
    evidence: note,
  };
}

function structureFactor(input: SignalInput, w: FactorWeights): ScoreFactor | null {
  const { structure, candles } = input;
  if (structure.trend === "undetermined") return null;

  let value =
    structure.trend === "uptrend"
      ? structure.trendStrength
      : structure.trend === "downtrend"
        ? -structure.trendStrength
        : 0;

  const recent = structure.events.filter((e) => e.index >= candles.length - 5);
  const notes = [structure.rationale[0] ?? ""];

  for (const event of recent) {
    if (event.kind === "breakout") value = clampUnit(value + 0.25);
    else if (event.kind === "breakdown") value = clampUnit(value - 0.25);
    else if (event.kind === "fakeout") {
      // A failed breakout is the strongest "stand aside" tell in the module.
      value = clampUnit(value * 0.3);
      notes.push(`Recent failed breakout — ${event.evidence}`);
    } else if (event.kind === "change_of_character") {
      value = clampUnit(value - 0.3);
      notes.push(event.evidence);
    } else if (event.kind === "break_of_structure") {
      value = clampUnit(value + 0.3);
      notes.push(event.evidence);
    }
  }

  return {
    id: "structure.trend_events",
    label: "Market structure",
    value,
    weight: w.structure,
    evidence: notes.filter(Boolean).join(" "),
  };
}

function levelsFactor(input: SignalInput, w: FactorWeights): ScoreFactor | null {
  const { structure, indicators } = input;
  const price = indicators.closes[indicators.closes.length - 1];
  if (price === undefined) return null;

  const nearestResistance = structure.resistance
    .filter((l) => l.price > price)
    .sort((a, b) => a.price - b.price)[0];
  const nearestSupport = structure.support
    .filter((l) => l.price < price)
    .sort((a, b) => b.price - a.price)[0];

  if (!nearestResistance && !nearestSupport) return null;

  const toResistance = nearestResistance ? (nearestResistance.price - price) / price : Infinity;
  const toSupport = nearestSupport ? (price - nearestSupport.price) / price : Infinity;

  // Room above and a floor nearby is constructive; running into resistance is not.
  const value = clampUnit((toResistance - toSupport) / 0.03);

  const parts: string[] = [];
  if (nearestSupport) {
    parts.push(
      `Support ${nearestSupport.price.toFixed(4)} (${(toSupport * 100).toFixed(2)}% below, ${nearestSupport.touches} touch(es))`
    );
  }
  if (nearestResistance) {
    parts.push(
      `resistance ${nearestResistance.price.toFixed(4)} (${(toResistance * 100).toFixed(2)}% above, ${nearestResistance.touches} touch(es))`
    );
  }

  return {
    id: "levels.support_resistance",
    label: "Support / resistance",
    value,
    weight: w.levels,
    evidence: parts.join("; ") + ".",
  };
}

function vwapFactor(input: SignalInput, w: FactorWeights): ScoreFactor | null {
  const { indicators } = input;
  const vwapIndex = lastDefinedIndex(indicators.vwap);
  if (vwapIndex < 0) return null;
  const vwapValue = indicators.vwap[vwapIndex] as number;
  const price = indicators.closes[indicators.closes.length - 1];
  if (vwapValue === 0) return null;

  const distance = (price - vwapValue) / vwapValue;
  return {
    id: "vwap.position",
    label: "VWAP",
    value: clampUnit(distance / 0.01),
    weight: w.vwap,
    evidence: `Price is ${(distance * 100).toFixed(2)}% ${price > vwapValue ? "above" : "below"} session VWAP (${vwapValue.toFixed(4)}).`,
  };
}

function mtfFactor(input: SignalInput, w: FactorWeights): ScoreFactor | null {
  const { mtf } = input;
  if (!mtf || mtf.views.length === 0) return null;

  // A conflicted read is damped, not zeroed: the higher-timeframe trend still
  // matters, it just cannot carry full weight while lower frames disagree.
  const value =
    mtf.alignment === "conflicted"
      ? clampUnit(mtf.aggregateBias * 0.4)
      : clampUnit(mtf.aggregateBias);

  return {
    id: "mtf.alignment",
    label: "Multi-timeframe alignment",
    value,
    weight: w.mtfAlignment,
    evidence: mtf.narrative,
  };
}

function newsFactor(input: SignalInput, w: FactorWeights): ScoreFactor | null {
  const articles = input.news;
  // No provider configured means no news factor at all — not "neutral news".
  if (!articles || articles.length === 0) return null;

  const scored = articles.filter((a) => a.sentiment !== null);
  if (scored.length === 0) return null;

  const impactWeight = (article: NewsArticle): number => {
    switch (article.impact) {
      case "critical":
        return 3;
      case "high":
        return 2;
      case "medium":
        return 1;
      default:
        return 0.5;
    }
  };

  let sum = 0;
  let weightTotal = 0;
  for (const article of scored) {
    const direction =
      article.sentiment === "positive" ? 1 : article.sentiment === "negative" ? -1 : 0;
    const weight = impactWeight(article);
    sum += direction * weight;
    weightTotal += weight;
  }

  return {
    id: "news.sentiment",
    label: "News",
    value: weightTotal === 0 ? 0 : clampUnit(sum / weightTotal),
    weight: w.news,
    evidence: `${scored.length} provider-scored article(s); net sentiment ${(weightTotal === 0 ? 0 : sum / weightTotal).toFixed(2)}.`,
  };
}

function fundamentalsFactor(input: SignalInput, w: FactorWeights): ScoreFactor | null {
  if (input.fundamentalBias === null || input.fundamentalBias === undefined) return null;
  return {
    id: "fundamentals.bias",
    label: "Fundamentals",
    value: clampUnit(input.fundamentalBias),
    weight: w.fundamentals,
    evidence: `Fundamental bias ${input.fundamentalBias.toFixed(2)} from the configured provider.`,
  };
}

function riskRewardFactor(input: SignalInput, w: FactorWeights): ScoreFactor | null {
  if (input.riskReward === null || input.riskReward === undefined) return null;
  const minRr = input.minRiskReward ?? 1.5;
  // Below the minimum this is negative — poor R:R argues against the trade
  // regardless of how good the chart looks.
  const value = clampUnit((input.riskReward - minRr) / 2);
  return {
    id: "risk.reward_ratio",
    label: "Risk / reward",
    value,
    weight: w.riskReward,
    evidence: `Risk/reward 1:${input.riskReward.toFixed(2)} against a 1:${minRr.toFixed(2)} minimum.`,
  };
}

// ---------------------------------------------------------------------------
// State, grade, explanation
// ---------------------------------------------------------------------------

function collectWarnings(input: SignalInput, warnings: Warning[]): void {
  if (!input.liveDataAvailable) {
    warnings.push({
      code: "STALE_DATA",
      severity: "critical",
      message: "LIVE ANALYSIS DISABLED — market data is stale or unavailable.",
    });
  }
  if (input.regime.regime === "panic") {
    warnings.push({
      code: "PANIC_REGIME",
      severity: "critical",
      message: "Disorderly conditions detected — technical readings are unreliable.",
    });
  }
  if (input.regime.regime === "high_volatility") {
    warnings.push({
      code: "HIGH_VOLATILITY",
      severity: "warning",
      message: "Elevated volatility — stops must widen and slippage will be higher than modelled.",
    });
  }
  if (input.mtf?.alignment === "conflicted") {
    warnings.push({
      code: "TIMEFRAME_CONFLICT",
      severity: "warning",
      message: `Timeframes disagree: ${input.mtf.conflicts[0] ?? "mixed structure"}`,
    });
  }
  const recentFakeout = input.structure.events.some(
    (e) => e.kind === "fakeout" && e.index >= input.candles.length - 5
  );
  if (recentFakeout) {
    warnings.push({
      code: "RECENT_FAKEOUT",
      severity: "warning",
      message: "A breakout failed within the last 5 bars — wait for confirmation.",
    });
  }
  if (input.structure.trend === "undetermined" || input.structure.trend === "range") {
    warnings.push({
      code: "NO_CLEAR_STRUCTURE",
      severity: "info",
      message: "No directional market structure — breakout traders have no edge here.",
    });
  }
}

function deriveState(
  score: number,
  input: SignalInput,
  thresholds: SignalThresholds,
  hasCriticalWarning: boolean
): SignalState {
  // Critical conditions override the score outright (§35, §45).
  if (!input.liveDataAvailable || hasCriticalWarning) return "NO_TRADE";
  if (input.mtf?.alignment === "conflicted") {
    // A conflicted read is exactly the case the spec says must NOT become a BUY.
    return score >= thresholds.buy || score <= thresholds.sell ? "WAIT" : "HOLD";
  }
  if (score >= thresholds.strongBuy) return "STRONG_BUY";
  if (score >= thresholds.buy) return "BUY";
  if (score <= thresholds.strongSell) return "STRONG_SELL";
  if (score <= thresholds.sell) return "SELL";
  if (score > 52 || score < 48) return "HOLD";
  return "WAIT";
}

function deriveGrade(score: number, state: SignalState, thresholds: SignalThresholds): TradeGrade {
  if (state === "NO_TRADE") return "NO_TRADE";
  // Grade the CONVICTION, so a strong short grades as highly as a strong long.
  const conviction = Math.abs(score - 50) * 2;
  if (conviction >= thresholds.gradeAPlus) return "A+";
  if (conviction >= thresholds.gradeA) return "A";
  if (conviction >= thresholds.gradeB) return "B";
  if (conviction >= thresholds.gradeC) return "C";
  return "NO_TRADE";
}

function computeAgreement(factors: readonly ScoreFactor[], netBias: number): number {
  if (factors.length === 0 || netBias === 0) return 0;
  const direction = Math.sign(netBias);
  let agreeing = 0;
  let total = 0;
  for (const factor of factors) {
    if (factor.value === 0) continue;
    total += factor.weight;
    if (Math.sign(factor.value) === direction) agreeing += factor.weight;
  }
  return total === 0 ? 0 : agreeing / total;
}

/** Render the §34 "why buy / why sell / why wait" block. */
function explain(
  state: SignalState,
  score: number,
  bullish: readonly string[],
  bearish: readonly string[],
  warnings: readonly Warning[],
  input: SignalInput
): string {
  const heading =
    state === "BUY" || state === "STRONG_BUY"
      ? "WHY BUY?"
      : state === "SELL" || state === "STRONG_SELL"
        ? "WHY SELL?"
        : state === "NO_TRADE"
          ? "WHY NO TRADE?"
          : "WHY WAIT?";

  const lines: string[] = [heading, ""];
  const supporting = state === "SELL" || state === "STRONG_SELL" ? bearish : bullish;
  const opposing = state === "SELL" || state === "STRONG_SELL" ? bullish : bearish;

  if (state === "NO_TRADE") {
    const critical = warnings.filter((w) => w.severity === "critical");
    if (critical.length > 0) {
      critical.forEach((w, i) => lines.push(`${i + 1}. ${w.message}`));
    } else {
      lines.push("1. No factor combination reached the configured tradeable threshold.");
    }
  } else if (supporting.length === 0) {
    lines.push("1. No factor reached the evidence threshold in either direction.");
  } else {
    supporting.slice(0, 6).forEach((reason, i) => lines.push(`${i + 1}. ${reason}`));
  }

  if (opposing.length > 0) {
    lines.push("", "AGAINST:");
    opposing.slice(0, 4).forEach((reason, i) => lines.push(`${i + 1}. ${reason}`));
  }

  const risks = warnings.filter((w) => w.severity !== "info");
  if (risks.length > 0) {
    lines.push("", "RISKS:");
    risks.forEach((w, i) => lines.push(`${i + 1}. ${w.message}`));
  }

  lines.push(
    "",
    `MARKET REGIME: ${input.regime.regime.replace(/_/g, " ")} (${(input.regime.confidence * 100).toFixed(0)}% confidence)`,
    `SETUP SCORE: ${score.toFixed(0)}/100`,
    `DECISION: ${state.replace(/_/g, " ")}`
  );
  return lines.join("\n");
}

function pushIfDefined(target: ScoreFactor[], factor: ScoreFactor | null): void {
  if (factor !== null) target.push(factor);
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, value));
}
