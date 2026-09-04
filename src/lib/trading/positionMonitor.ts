/**
 * Position monitor and real-time reassessment (master spec §38, §39).
 *
 * Watches an open position and reports how the setup has changed since entry.
 *
 * The hard rule (§38, §40): this module **never closes or modifies a trade**.
 * It returns observations and a recommendation the user acts on. There is no
 * code path here that produces an order.
 */

import type { AnalysisResult } from "./analysisService";
import type { Side, Warning } from "./types";

export interface MonitoredPosition {
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  openedAt: number;
  /** Signal state recorded when the position was opened. */
  entryState?: string;
  /** Signal score recorded when the position was opened. */
  entryScore?: number;
  contractSize?: number;
}

export type PositionTrend =
  "improving" | "weakening" | "unchanged" | "invalidated" | "target_approaching" | "stop_risk";

export interface PositionMonitorResult {
  symbol: string;
  side: Side;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  unrealizedPercent: number | null;
  /** Progress from entry toward the target, in R multiples. */
  rMultiple: number | null;
  distanceToStop: number | null;
  distanceToStopPercent: number | null;
  distanceToTarget: number | null;
  distanceToTargetPercent: number | null;
  trend: PositionTrend;
  /** Score now vs. score at entry, when both are known. */
  scoreDelta: number | null;
  observations: string[];
  warnings: Warning[];
  /** What the evidence supports. The user decides; nothing acts on this. */
  recommendation: "hold" | "watch" | "consider_reducing" | "consider_exiting" | "unknown";
  recommendationReason: string;
}

export function monitorPosition(
  position: MonitoredPosition,
  analysis: AnalysisResult
): PositionMonitorResult {
  const contractSize = position.contractSize ?? 1;
  const direction = position.side === "long" ? 1 : -1;
  const price = currentPriceOf(analysis);

  const observations: string[] = [];
  const warnings: Warning[] = [...analysis.warnings];

  if (price === null) {
    return {
      symbol: position.symbol,
      side: position.side,
      currentPrice: null,
      unrealizedPnl: null,
      unrealizedPercent: null,
      rMultiple: null,
      distanceToStop: null,
      distanceToStopPercent: null,
      distanceToTarget: null,
      distanceToTargetPercent: null,
      trend: "unchanged",
      scoreDelta: null,
      observations: ["No current price — the position cannot be monitored."],
      warnings,
      recommendation: "unknown",
      recommendationReason: "DATA SOURCE UNAVAILABLE — no price for this symbol.",
    };
  }

  const unrealizedPnl =
    (price - position.entryPrice) * direction * position.quantity * contractSize;
  const unrealizedPercent =
    position.entryPrice === 0
      ? null
      : ((price - position.entryPrice) / position.entryPrice) * 100 * direction;

  const riskPerUnit =
    position.stopPrice === null ? null : Math.abs(position.entryPrice - position.stopPrice);
  const rMultiple =
    riskPerUnit === null || riskPerUnit === 0
      ? null
      : ((price - position.entryPrice) * direction) / riskPerUnit;

  const distanceToStop =
    position.stopPrice === null ? null : (price - position.stopPrice) * direction;
  const distanceToStopPercent =
    distanceToStop === null || price === 0 ? null : (distanceToStop / price) * 100;

  const distanceToTarget =
    position.takeProfitPrice === null ? null : (position.takeProfitPrice - price) * direction;
  const distanceToTargetPercent =
    distanceToTarget === null || price === 0 ? null : (distanceToTarget / price) * 100;

  const currentScore = analysis.signal?.score ?? null;
  const scoreDelta =
    currentScore === null || position.entryScore === undefined
      ? null
      : currentScore - position.entryScore;

  // --- Observations, each citing a computed value.
  observations.push(
    `Price ${price.toFixed(4)} vs entry ${position.entryPrice.toFixed(4)} ` +
      `(${unrealizedPercent === null ? "—" : `${unrealizedPercent >= 0 ? "+" : ""}${unrealizedPercent.toFixed(2)}%`}).`
  );
  if (rMultiple !== null) observations.push(`Open result: ${rMultiple.toFixed(2)}R.`);
  if (distanceToStopPercent !== null) {
    observations.push(`Stop is ${distanceToStopPercent.toFixed(2)}% away.`);
  }
  if (distanceToTargetPercent !== null) {
    observations.push(`Target is ${distanceToTargetPercent.toFixed(2)}% away.`);
  }
  if (analysis.structure) {
    observations.push(
      `Structure: ${analysis.structure.trend} (${analysis.structure.volatility} volatility).`
    );
  }
  if (scoreDelta !== null) {
    observations.push(
      `Setup score ${currentScore?.toFixed(0)} vs ${position.entryScore?.toFixed(0)} at entry ` +
        `(${scoreDelta >= 0 ? "+" : ""}${scoreDelta.toFixed(0)}).`
    );
  }

  // --- Trend classification, most severe first.
  const structureBroke = analysis.structure?.events.some(
    (event) =>
      event.index >= (analysis.structure?.swings.length ?? 0) - 1 ||
      (position.side === "long"
        ? event.kind === "change_of_character"
        : event.kind === "break_of_structure")
  );

  let trend: PositionTrend = "unchanged";
  if (position.stopPrice !== null && distanceToStop !== null && distanceToStop <= 0) {
    trend = "invalidated";
  } else if (
    position.takeProfitPrice !== null &&
    distanceToTargetPercent !== null &&
    distanceToTargetPercent <= 0.5
  ) {
    trend = "target_approaching";
  } else if (distanceToStopPercent !== null && distanceToStopPercent <= 1) {
    trend = "stop_risk";
  } else if (scoreDelta !== null && scoreDelta <= -10) {
    trend = "weakening";
  } else if (scoreDelta !== null && scoreDelta >= 10) {
    trend = "improving";
  } else if (structureBroke && position.entryState) {
    trend = "weakening";
  }

  // --- Recommendation. Advisory only; nothing in this module acts on it.
  let recommendation: PositionMonitorResult["recommendation"] = "hold";
  let recommendationReason = "The setup is broadly unchanged since entry.";

  if (!analysis.liveAnalysisAllowed) {
    recommendation = "unknown";
    recommendationReason = `LIVE ANALYSIS DISABLED — ${analysis.freshness.reason} Monitoring is not reliable.`;
  } else if (trend === "invalidated") {
    recommendation = "consider_exiting";
    recommendationReason = "Price has reached or passed the stop — the trade's premise is void.";
  } else if (trend === "stop_risk") {
    recommendation = "watch";
    recommendationReason = "Price is within 1% of the stop.";
  } else if (trend === "target_approaching") {
    recommendation = "watch";
    recommendationReason = "Price is within 0.5% of the first target.";
  } else if (trend === "weakening") {
    recommendation = "consider_reducing";
    recommendationReason =
      scoreDelta !== null && scoreDelta <= -10
        ? `The setup score has fallen ${Math.abs(scoreDelta).toFixed(0)} points since entry.`
        : "Market structure has turned against the position.";
  } else if (trend === "improving") {
    recommendation = "hold";
    recommendationReason = `The setup has strengthened by ${scoreDelta?.toFixed(0)} points since entry.`;
  }

  if (analysis.warnings.some((w) => w.severity === "critical")) {
    recommendation = recommendation === "hold" ? "watch" : recommendation;
    recommendationReason += " A critical warning is active on this instrument.";
  }

  return {
    symbol: position.symbol,
    side: position.side,
    currentPrice: price,
    unrealizedPnl,
    unrealizedPercent,
    rMultiple,
    distanceToStop,
    distanceToStopPercent,
    distanceToTarget,
    distanceToTargetPercent,
    trend,
    scoreDelta,
    observations,
    warnings,
    recommendation,
    recommendationReason,
  };
}

// ---------------------------------------------------------------------------
// Real-time reassessment (§39)
// ---------------------------------------------------------------------------

export interface SignalSnapshot {
  state: string;
  score: number;
  regime: string | null;
  at: number;
}

export type ReassessTrigger =
  | "large_price_move"
  | "volume_spike"
  | "breakout"
  | "breakdown"
  | "structure_change"
  | "regime_change"
  | "volatility_spike"
  | "signal_change";

export interface ReassessmentResult {
  changed: boolean;
  triggers: ReassessTrigger[];
  previous: SignalSnapshot | null;
  current: SignalSnapshot | null;
  /** The §39 message, rendered exactly as the spec shows it. */
  summary: string;
  reason: string;
}

export interface ReassessOptions {
  /** Percent move that counts as large. Default 2%. */
  largeMovePercent?: number;
  /** Score delta that counts as a material change. Default 15. */
  materialScoreDelta?: number;
}

/**
 * Compare the previous signal snapshot with a fresh analysis and decide whether
 * the change is material enough to tell the user about.
 *
 * Reporting every tick would be noise; the thresholds are what make this a
 * signal rather than a firehose.
 */
export function reassessSignal(
  previous: SignalSnapshot | null,
  analysis: AnalysisResult,
  options: ReassessOptions = {}
): ReassessmentResult {
  const materialDelta = options.materialScoreDelta ?? 15;
  const largeMove = options.largeMovePercent ?? 2;

  const current: SignalSnapshot | null = analysis.signal
    ? {
        state: analysis.signal.state,
        score: analysis.signal.score,
        regime: analysis.regime?.regime ?? null,
        at: analysis.generatedAt,
      }
    : null;

  if (!current) {
    return {
      changed: false,
      triggers: [],
      previous,
      current: null,
      summary: "No signal could be computed.",
      reason: analysis.reasons[0] ?? "analysis produced no signal",
    };
  }
  if (!previous) {
    return {
      changed: false,
      triggers: [],
      previous: null,
      current,
      summary: `Baseline recorded: ${current.state} ${current.score.toFixed(0)}/100.`,
      reason: "No earlier snapshot to compare against.",
    };
  }

  const triggers: ReassessTrigger[] = [];

  if (previous.state !== current.state) triggers.push("signal_change");
  if (previous.regime !== current.regime) triggers.push("regime_change");

  const recent = analysis.structure?.events.slice(-4) ?? [];
  if (recent.some((e) => e.kind === "breakout")) triggers.push("breakout");
  if (recent.some((e) => e.kind === "breakdown")) triggers.push("breakdown");
  if (recent.some((e) => e.kind === "change_of_character" || e.kind === "break_of_structure")) {
    triggers.push("structure_change");
  }
  if (analysis.structure?.volatility === "expansion") triggers.push("volatility_spike");

  for (const factor of analysis.signal?.factors ?? []) {
    if (factor.id === "volume.confirmation" && Math.abs(factor.value) >= 0.6) {
      triggers.push("volume_spike");
    }
  }

  const priceMove = priceMovePercent(analysis);
  if (priceMove !== null && Math.abs(priceMove) >= largeMove) triggers.push("large_price_move");

  const scoreDelta = current.score - previous.score;
  const material = Math.abs(scoreDelta) >= materialDelta || previous.state !== current.state;

  const unique = [...new Set(triggers)];

  if (!material) {
    return {
      changed: false,
      triggers: unique,
      previous,
      current,
      summary: `Unchanged: ${current.state} ${current.score.toFixed(0)}/100.`,
      reason: `Score moved ${scoreDelta >= 0 ? "+" : ""}${scoreDelta.toFixed(0)}, below the ${materialDelta}-point threshold.`,
    };
  }

  // The §39 worked example, rendered literally.
  const summary = [
    "SIGNAL CHANGED",
    "",
    `Previous:`,
    `${previous.state.replace(/_/g, " ")} ${previous.score.toFixed(0)}/100`,
    "",
    `Current:`,
    `${current.state.replace(/_/g, " ")} ${current.score.toFixed(0)}/100`,
    "",
    "Reason:",
    ...(unique.length > 0
      ? unique.map((t) => `- ${t.replace(/_/g, " ")}`)
      : [`- Score moved ${scoreDelta >= 0 ? "+" : ""}${scoreDelta.toFixed(0)} points.`]),
  ].join("\n");

  return {
    changed: true,
    triggers: unique,
    previous,
    current,
    summary,
    reason: unique.length > 0 ? unique.join(", ") : "material score change",
  };
}

function currentPriceOf(analysis: AnalysisResult): number | null {
  const levels = analysis.levels;
  if (levels) return levels.preferredEntry;
  return null;
}

function priceMovePercent(analysis: AnalysisResult): number | null {
  for (const factor of analysis.signal?.factors ?? []) {
    if (factor.id === "vwap.position") {
      // The VWAP factor's evidence carries the percentage distance; the factor
      // value itself is normalised, so derive from it rather than parsing text.
      return factor.value * 1; // value is distance/0.01, i.e. already percent
    }
  }
  return null;
}
