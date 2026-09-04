/**
 * Market scanner (master spec §27).
 *
 * Runs the full analysis pipeline across many instruments and ranks what comes
 * back. Two design points matter:
 *
 *  1. It ranks by TRADE QUALITY, not by score alone. A 90-score setup the risk
 *     engine blocked is not a better opportunity than a 70-score one that
 *     passed — it is not an opportunity at all, and the ranking says so.
 *
 *  2. A symbol that fails to analyse is REPORTED, not dropped. Silently
 *     omitting it would make a broken feed look like "no setups today".
 */

import { analyzeInstrument, type AnalysisRequest, type AnalysisResult } from "./analysisService";
import type { CandleSeries, Instrument, Quote, Side, Timeframe } from "./types";
import type { RiskSettings } from "./positionSizing";

export type ScanKind =
  | "strong_trend"
  | "breakout"
  | "momentum"
  | "volume_spike"
  | "oversold"
  | "overbought"
  | "vwap_reclaim"
  | "ema_cross"
  | "high_volatility"
  | "compression";

export interface ScanInput {
  instrument: Instrument;
  timeframe: Timeframe;
  series: CandleSeries;
  quote: Quote | null;
  additionalSeries?: AnalysisRequest["additionalSeries"];
}

export interface ScanHit {
  symbol: string;
  timeframe: Timeframe;
  side: Side;
  score: number;
  grade: string;
  state: string;
  verdict: AnalysisResult["verdict"];
  /** True only when the risk engine did not block AND the signal is tradeable. */
  tradeable: boolean;
  dataStatus: string;
  /** Pattern labels this symbol matched, for filtering. */
  kinds: ScanKind[];
  reasons: string[];
  warnings: string[];
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskReward: number | null;
  quantity: number | null;
  regime: string | null;
  changePercent: number | null;
}

export interface ScanFailure {
  symbol: string;
  reason: string;
}

export interface ScanResult {
  hits: ScanHit[];
  /** Symbols that could not be analysed — never silently dropped. */
  failures: ScanFailure[];
  scanned: number;
  scannedAt: number;
}

export interface ScanOptions {
  settings: RiskSettings;
  /** Only return setups at or above this score. */
  minScore?: number;
  /** Only return setups the risk engine cleared. */
  tradeableOnly?: boolean;
  /** Restrict to symbols matching at least one of these patterns. */
  kinds?: readonly ScanKind[];
  limit?: number;
  now?: number;
}

/**
 * Classify which named patterns a completed analysis matched.
 *
 * These are derived from values the engines already computed — the scanner adds
 * no new market claims of its own.
 */
export function classifyScan(analysis: AnalysisResult): ScanKind[] {
  const kinds: ScanKind[] = [];
  const structure = analysis.structure;
  const regime = analysis.regime;
  const signal = analysis.signal;

  if (structure) {
    if (
      structure.trend !== "range" &&
      structure.trend !== "undetermined" &&
      structure.trendStrength >= 0.6
    ) {
      kinds.push("strong_trend");
    }
    if (structure.volatility === "expansion") kinds.push("high_volatility");
    if (structure.volatility === "compression") kinds.push("compression");

    const recent = structure.events.filter((e) => e.index >= 0);
    const last5 = recent.slice(-5);
    if (last5.some((e) => e.kind === "breakout")) kinds.push("breakout");
    if (last5.some((e) => e.kind === "momentum_shift")) kinds.push("momentum");
  }

  if (regime && (regime.regime === "momentum" || regime.regime === "breakout")) {
    if (!kinds.includes("momentum")) kinds.push("momentum");
  }

  for (const factor of signal?.factors ?? []) {
    if (factor.id === "volume.confirmation" && Math.abs(factor.value) >= 0.5) {
      kinds.push("volume_spike");
    }
    if (factor.id === "momentum.rsi_macd") {
      if (factor.value <= -0.7) kinds.push("oversold");
      if (factor.value >= 0.7) kinds.push("overbought");
    }
    if (factor.id === "vwap.position" && factor.value >= 0.5) kinds.push("vwap_reclaim");
    if (factor.id === "trend.ema_structure" && Math.abs(factor.value) >= 0.8) {
      if (!kinds.includes("ema_cross")) kinds.push("ema_cross");
    }
  }

  return [...new Set(kinds)];
}

/**
 * Rank a hit.
 *
 * Blocked and untradeable setups are pushed below every tradeable one
 * regardless of score, because §27 asks for "top setups" and a setup you may
 * not take is not a setup.
 */
function rankValue(hit: ScanHit): number {
  const base = hit.score;
  if (!hit.tradeable) return base - 1000;
  // Among tradeable setups, a better risk/reward breaks the tie.
  return base + Math.min(10, (hit.riskReward ?? 0) * 2);
}

export function scanMarkets(inputs: readonly ScanInput[], options: ScanOptions): ScanResult {
  const now = options.now ?? Date.now();
  const hits: ScanHit[] = [];
  const failures: ScanFailure[] = [];

  for (const input of inputs) {
    let analysis: AnalysisResult;
    try {
      analysis = analyzeInstrument({
        series: input.series,
        additionalSeries: input.additionalSeries,
        quote: input.quote,
        settings: options.settings,
        dailyPnl: 0,
        openPositions: [],
        now,
      });
    } catch (error) {
      // A symbol that throws is reported, never silently skipped.
      failures.push({
        symbol: input.instrument.symbol,
        reason: error instanceof Error ? error.message : "analysis failed",
      });
      continue;
    }

    if (!analysis.signal) {
      failures.push({
        symbol: input.instrument.symbol,
        reason: analysis.reasons[0] ?? "no signal could be computed",
      });
      continue;
    }

    const levels = analysis.levels;
    hits.push({
      symbol: input.instrument.symbol,
      timeframe: input.timeframe,
      side: levels?.side ?? (analysis.signal.score >= 50 ? "long" : "short"),
      score: analysis.signal.score,
      grade: analysis.signal.grade,
      state: analysis.signal.state,
      verdict: analysis.verdict,
      tradeable: analysis.verdict === "TRADEABLE",
      dataStatus: analysis.dataStatus,
      kinds: classifyScan(analysis),
      reasons: analysis.reasons,
      warnings: analysis.warnings.map((w) => w.message),
      entry: levels?.preferredEntry ?? null,
      stop: levels?.stopLoss ?? null,
      target: levels?.takeProfit1 ?? null,
      riskReward: levels?.riskReward ?? null,
      quantity: analysis.sizing?.tradeable ? analysis.sizing.quantity : null,
      regime: analysis.regime?.regime ?? null,
      changePercent: input.quote?.changePercent ?? null,
    });
  }

  let filtered = hits;
  if (options.minScore !== undefined) {
    const min = options.minScore;
    filtered = filtered.filter((hit) => hit.score >= min);
  }
  if (options.tradeableOnly) {
    filtered = filtered.filter((hit) => hit.tradeable);
  }
  if (options.kinds && options.kinds.length > 0) {
    const wanted = new Set(options.kinds);
    filtered = filtered.filter((hit) => hit.kinds.some((kind) => wanted.has(kind)));
  }

  filtered.sort((a, b) => rankValue(b) - rankValue(a));

  return {
    hits: filtered.slice(0, options.limit ?? 50),
    failures,
    scanned: inputs.length,
    scannedAt: now,
  };
}

export const SCAN_KIND_LABELS: Readonly<Record<ScanKind, string>> = {
  strong_trend: "Strong trend",
  breakout: "Breakout",
  momentum: "Momentum",
  volume_spike: "Volume spike",
  oversold: "Oversold",
  overbought: "Overbought",
  vwap_reclaim: "VWAP reclaim",
  ema_cross: "EMA extension",
  high_volatility: "High volatility",
  compression: "Volatility compression",
};
