/**
 * Analysis orchestrator (master spec §8, §9, §10, §12, §35, §37, §42).
 *
 * Runs the full pipeline for one instrument and returns a complete, explainable
 * trade plan — or a documented refusal.
 *
 * The ordering is deliberate and is the safety property of the whole system:
 *
 *   providers → freshness gate → indicators → structure → MTF → regime
 *     → signal → levels → sizing → RISK ENGINE → verdict
 *
 * The risk engine runs LAST and can veto everything upstream of it. No caller
 * can reach a tradeable verdict without passing it, because the verdict is
 * produced here rather than assembled by the caller.
 */

import { analyzeStructure, barsPerYear, realizedVolatility } from "./structure";
import { analyzeMultiTimeframe, type MtfAnalysis } from "./mtf";
import { computeIndicatorSet, latest } from "./indicators";
import { detectRegime } from "./regime";
import { computeSignal, type SignalResult, type SignalThresholds } from "./signal";
import { buildTradePlanLevels, type TradePlanLevels } from "./entry";
import {
  calculatePositionSize,
  DEFAULT_COST_MODEL,
  type CostModel,
  type PositionSizeResult,
  type RiskSettings,
} from "./positionSizing";
import { assessRisk, type OpenPositionSnapshot, type RiskAssessment } from "./riskEngine";
import {
  DEFAULT_FRESHNESS_POLICY,
  evaluateQuote,
  evaluateSeries,
  inspectSeriesIntegrity,
  type FreshnessPolicy,
  type FreshnessVerdict,
} from "./freshness";
import { buildCopilotMessages, type CopilotEvidence, type CopilotMessage } from "./copilot";
import type { EconomicEvent, Fundamentals, NewsArticle } from "./providers/types";
import {
  TIMEFRAME_MS,
  type CandleSeries,
  type DataStatus,
  type Quote,
  type Side,
  type Timeframe,
  type Warning,
} from "./types";

export interface AnalysisRequest {
  /** Primary series the plan is built on. */
  series: CandleSeries;
  /** Additional timeframes for the MTF read. Optional. */
  additionalSeries?: ReadonlyArray<{ timeframe: Timeframe; candles: CandleSeries["candles"] }>;
  quote: Quote | null;
  settings: RiskSettings;
  costs?: CostModel;
  freshnessPolicy?: FreshnessPolicy;
  thresholds?: SignalThresholds;
  news?: readonly NewsArticle[] | null;
  events?: readonly EconomicEvent[] | null;
  fundamentals?: Fundamentals | null;
  dailyPnl?: number | null;
  openPositions?: readonly OpenPositionSnapshot[];
  correlationGroup?: string;
  /** Direction to evaluate. Omit to take the direction the signal implies. */
  side?: Side;
  now?: number;
}

export interface AnalysisResult {
  symbol: string;
  timeframe: Timeframe;
  generatedAt: number;
  /** Effective status after the freshness gate — never more optimistic. */
  dataStatus: DataStatus;
  dataSource: string;
  freshness: FreshnessVerdict;
  liveAnalysisAllowed: boolean;
  seriesIntegrity: ReturnType<typeof inspectSeriesIntegrity>;
  structure: ReturnType<typeof analyzeStructure> | null;
  mtf: MtfAnalysis | null;
  regime: ReturnType<typeof detectRegime> | null;
  signal: SignalResult | null;
  levels: TradePlanLevels | null;
  sizing: PositionSizeResult | null;
  risk: RiskAssessment | null;
  /** Annualised realised volatility as a fraction, or null. */
  volatility: number | null;
  /** The single answer: may this trade be taken right now? */
  verdict: "TRADEABLE" | "NO_TRADE" | "BLOCKED" | "DATA_UNAVAILABLE";
  reasons: string[];
  warnings: Warning[];
  /** Messages ready to send to the Copilot. Null when there is nothing to explain. */
  copilotMessages: CopilotMessage[] | null;
}

/**
 * Run the pipeline.
 *
 * Every early return is a REFUSAL with a reason, not an empty result — §42
 * requires the UI to be able to say exactly what is unavailable.
 */
export function analyzeInstrument(request: AnalysisRequest): AnalysisResult {
  const now = request.now ?? Date.now();
  const { series } = request;
  const timeframe = series.timeframe;
  const symbol = series.instrument.symbol;
  const policy = request.freshnessPolicy ?? DEFAULT_FRESHNESS_POLICY;

  const seriesIntegrity = inspectSeriesIntegrity(series.candles, timeframe);
  const seriesFreshness = evaluateSeries(series, policy, now);
  const quoteFreshness = request.quote ? evaluateQuote(request.quote, policy, now) : null;

  // The effective status is the WORSE of the series and the quote. A live quote
  // does not rescue a stale candle series, and vice versa.
  const freshness = pickWorse(seriesFreshness, quoteFreshness);
  const liveAnalysisAllowed = freshness.liveAnalysisAllowed;

  const base = {
    symbol,
    timeframe,
    generatedAt: now,
    dataStatus: freshness.status,
    dataSource: series.provenance.source,
    freshness,
    liveAnalysisAllowed,
    seriesIntegrity,
  };

  if (series.candles.length === 0) {
    return {
      ...base,
      structure: null,
      mtf: null,
      regime: null,
      signal: null,
      levels: null,
      sizing: null,
      risk: null,
      volatility: null,
      verdict: "DATA_UNAVAILABLE",
      reasons: ["DATA SOURCE UNAVAILABLE — no candles for this instrument and timeframe."],
      warnings: [],
      copilotMessages: null,
    };
  }

  // --- Analysis. These run even on stale data so the UI can still SHOW the
  // chart and its structure; what stale data forbids is a tradeable verdict.
  const indicators = computeIndicatorSet(series.candles);
  const structure = analyzeStructure(series.candles);
  const regime = detectRegime({ candles: series.candles });

  const mtfSeries = [{ timeframe, candles: series.candles }, ...(request.additionalSeries ?? [])];
  const mtf = mtfSeries.length > 1 ? analyzeMultiTimeframe(mtfSeries) : null;

  const volatilitySeries = realizedVolatility(
    series.candles.map((c) => c.close),
    Math.min(20, Math.max(5, Math.floor(series.candles.length / 4))),
    barsPerYear(TIMEFRAME_MS[timeframe])
  );
  const volatility = latest(volatilitySeries);

  // --- Direction. Taken from the signal's own read unless the caller pinned it.
  const provisional = computeSignal({
    candles: series.candles,
    indicators,
    structure,
    regime,
    mtf,
    news: request.news ?? undefined,
    fundamentalBias: null,
    riskReward: null,
    minRiskReward: request.settings.minRiskRewardRatio,
    thresholds: request.thresholds,
    liveDataAvailable: liveAnalysisAllowed,
  });

  const side: Side = request.side ?? (provisional.score >= 50 ? "long" : "short");

  // --- Levels, then re-score WITH the resulting risk/reward, so R:R actually
  // influences the score rather than being reported alongside it.
  const levels = buildTradePlanLevels(series.candles, structure, side);

  const signal = computeSignal({
    candles: series.candles,
    indicators,
    structure,
    regime,
    mtf,
    news: request.news ?? undefined,
    fundamentalBias: null,
    riskReward: levels?.riskReward ?? null,
    minRiskReward: request.settings.minRiskRewardRatio,
    thresholds: request.thresholds,
    liveDataAvailable: liveAnalysisAllowed,
  });

  // --- Sizing.
  const lastClose = series.candles[series.candles.length - 1].close;
  const entryPrice = request.quote?.last ?? lastClose;
  const sizing = levels
    ? calculatePositionSize({
        entryPrice,
        stopPrice: levels.stopLoss,
        side,
        settings: request.settings,
        costs: request.costs ?? DEFAULT_COST_MODEL,
        contractSize: series.instrument.contractSize ?? 1,
        quantityIncrement: quantityIncrementFor(series.instrument.assetClass),
        riskMultiplier: regime.riskMultiplier,
      })
    : null;

  // --- Risk engine. Runs last; it can veto everything above.
  const risk = assessRisk({
    symbol,
    side,
    settings: request.settings,
    quote: request.quote,
    freshnessPolicy: policy,
    proposedNotional: sizing?.notional ?? 0,
    proposedMaximumLoss: sizing?.maximumLoss ?? 0,
    stopPrice: levels?.stopLoss ?? null,
    riskRewardRatio: levels?.riskReward ?? null,
    dailyPnl: request.dailyPnl ?? null,
    openPositions: request.openPositions ?? [],
    upcomingEvents: request.events ?? undefined,
    volatility,
    correlationGroup: request.correlationGroup,
    now,
  });

  // --- Verdict.
  const reasons: string[] = [];
  let verdict: AnalysisResult["verdict"];

  if (!liveAnalysisAllowed) {
    verdict = "DATA_UNAVAILABLE";
    reasons.push(`LIVE ANALYSIS DISABLED — ${freshness.reason}`);
  } else if (risk.verdict === "BLOCKED") {
    verdict = "BLOCKED";
    reasons.push(...risk.blockingReasons);
  } else if (!signal.tradeable) {
    verdict = "NO_TRADE";
    reasons.push(
      `Signal state ${signal.state} at ${signal.score.toFixed(0)}/100 — below the tradeable bar.`
    );
    if (signal.warnings.length > 0) reasons.push(...signal.warnings.map((w) => w.message));
  } else if (sizing && !sizing.tradeable) {
    verdict = "NO_TRADE";
    reasons.push(sizing.reason);
  } else {
    verdict = "TRADEABLE";
    reasons.push(
      `${signal.state.replace(/_/g, " ")} — score ${signal.score.toFixed(0)}/100, grade ${signal.grade}.`
    );
  }

  if (!seriesIntegrity.ok) {
    reasons.push(`Data quality: ${seriesIntegrity.issues.join("; ")}.`);
  }

  const warnings: Warning[] = [...signal.warnings];
  for (const message of risk.warnings) {
    warnings.push({ code: "RISK_WARNING", severity: "warning", message });
  }
  if (!seriesIntegrity.ok) {
    warnings.push({
      code: "SERIES_INTEGRITY",
      severity: "warning",
      message: `Candle series has defects: ${seriesIntegrity.issues.join("; ")}.`,
    });
  }

  const evidence: CopilotEvidence = {
    instrument: series.instrument,
    timeframe,
    generatedAt: now,
    dataStatus: freshness.status,
    dataSource: series.provenance.source,
    quote: request.quote,
    structure,
    regime,
    mtf,
    signal,
    levels,
    sizing,
    risk,
    news: request.news ?? null,
    events: request.events ?? null,
    fundamentals: request.fundamentals ?? null,
    portfolio: null,
    portfolioRisk: null,
  };

  return {
    ...base,
    structure,
    mtf,
    regime,
    signal,
    levels,
    sizing,
    risk,
    volatility,
    verdict,
    reasons,
    warnings,
    copilotMessages: buildCopilotMessages(evidence),
  };
}

/**
 * The worse of two freshness verdicts. Ranking is by how much analysis each
 * permits, so "worse" always means "less permissive".
 */
function pickWorse(a: FreshnessVerdict, b: FreshnessVerdict | null): FreshnessVerdict {
  if (!b) return a;
  const rank: Record<DataStatus, number> = {
    LIVE: 5,
    DELAYED: 4,
    HISTORICAL: 3,
    PAPER: 2,
    SIMULATED: 1,
    STALE: 0,
    UNAVAILABLE: 0,
  };
  return rank[a.status] <= rank[b.status] ? a : b;
}

/** Tradeable increments per asset class. Shares are whole; crypto is not. */
function quantityIncrementFor(assetClass: string): number {
  switch (assetClass) {
    case "crypto":
      return 0.00000001;
    case "forex":
      return 0.01;
    default:
      return 1;
  }
}
