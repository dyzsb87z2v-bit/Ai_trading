/**
 * Risk engine (master spec §12, §22, §35).
 *
 * The mandatory gate every trade passes through. It runs a fixed battery of
 * checks and returns a verdict; if ANY critical check fails the verdict is
 * BLOCKED and no order may proceed.
 *
 * Design notes that matter:
 *  - Checks are data-driven and always ALL evaluated, so the caller sees every
 *    reason a trade was blocked, not just the first.
 *  - A check that cannot be evaluated (missing data) fails CLOSED when it is
 *    critical. "We could not verify the daily loss" is not permission to trade.
 *  - The engine never approves; it only fails to block. Final authority stays
 *    with the user (§40).
 */

import { evaluateQuote, type FreshnessPolicy, DEFAULT_FRESHNESS_POLICY } from "./freshness";
import type { RiskSettings } from "./positionSizing";
import type { EconomicEvent } from "./providers/types";
import type { MarketSession, Quote, Side } from "./types";

export type RiskVerdict = "ALLOWED" | "WARNED" | "BLOCKED";

export type RiskCheckId =
  | "account"
  | "data_freshness"
  | "market_session"
  | "spread"
  | "volatility"
  | "position_size"
  | "daily_loss"
  | "max_exposure"
  | "correlation"
  | "duplicate_order"
  | "news_event"
  | "stop_loss"
  | "risk_reward";

export interface RiskCheckResult {
  id: RiskCheckId;
  /** Critical checks block; non-critical ones only warn. */
  critical: boolean;
  passed: boolean;
  /** True when the check could not be evaluated at all. */
  indeterminate: boolean;
  message: string;
}

export interface RiskAssessment {
  verdict: RiskVerdict;
  checks: RiskCheckResult[];
  blockingReasons: string[];
  warnings: string[];
  /** Rendered exactly as the spec's example output (§12). */
  summary: string;
}

export interface OpenPositionSnapshot {
  symbol: string;
  side: Side;
  notional: number;
  /** Correlation group, e.g. "us_tech" or "crypto_beta". */
  correlationGroup?: string;
}

export interface RiskEvaluationInput {
  symbol: string;
  side: Side;
  settings: RiskSettings;
  /** Quote backing the decision. Null means no market data at all. */
  quote: Quote | null;
  freshnessPolicy?: FreshnessPolicy;
  /** Sized position under evaluation. */
  proposedNotional: number;
  proposedMaximumLoss: number;
  stopPrice: number | null;
  riskRewardRatio: number | null;
  /** Realised + unrealised P&L for the current session. Negative = a loss. */
  dailyPnl: number | null;
  openPositions: readonly OpenPositionSnapshot[];
  /** Client order ids submitted recently, for duplicate detection. */
  recentClientOrderIds?: readonly string[];
  clientOrderId?: string;
  /** Upcoming events; the engine looks for high-importance ones nearby. */
  upcomingEvents?: readonly EconomicEvent[];
  /** Block new trades near high-importance events. Default true (§14). */
  blockAroundHighImpactEvents?: boolean;
  /** Minutes before an event during which new trades are blocked. */
  eventBlockWindowMinutes?: number;
  /** Current annualised volatility as a fraction, when known. */
  volatility?: number | null;
  /** Volatility above which conditions are considered too disorderly. */
  maxVolatility?: number;
  correlationGroup?: string;
  now?: number;
}

const MAX_CORRELATED_GROUP_FRACTION = 0.5;

/**
 * Run every check and produce a verdict. Order of the returned array matches
 * the spec's §22 pre-trade sequence so the UI can render it as a checklist.
 */
export function assessRisk(input: RiskEvaluationInput): RiskAssessment {
  const now = input.now ?? Date.now();
  const checks: RiskCheckResult[] = [];
  const settings = input.settings;

  const add = (
    id: RiskCheckId,
    critical: boolean,
    passed: boolean,
    message: string,
    indeterminate = false
  ) => checks.push({ id, critical, passed, indeterminate, message });

  // 1. Account -------------------------------------------------------------
  if (settings.accountEquity > 0) {
    add("account", true, true, `Account equity ${settings.accountEquity.toFixed(2)}.`);
  } else {
    add("account", true, false, "Account equity is zero or unknown.", true);
  }

  // 2. Data freshness ------------------------------------------------------
  if (!input.quote) {
    add("data_freshness", true, false, "DATA SOURCE UNAVAILABLE — no quote for this symbol.", true);
  } else {
    const verdict = evaluateQuote(
      input.quote,
      input.freshnessPolicy ?? DEFAULT_FRESHNESS_POLICY,
      now
    );
    add(
      "data_freshness",
      true,
      verdict.liveAnalysisAllowed,
      verdict.liveAnalysisAllowed
        ? `Market data ${verdict.status} (${verdict.ageMs}ms old).`
        : `LIVE ANALYSIS DISABLED — ${verdict.reason}`
    );
  }

  // 3. Market session ------------------------------------------------------
  const session: MarketSession = input.quote?.session ?? "unknown";
  if (session === "regular") {
    add("market_session", true, true, "Regular trading session.");
  } else if (session === "closed") {
    add("market_session", true, false, "Market is closed.");
  } else if (session === "unknown") {
    add("market_session", true, false, "Trading session could not be determined.", true);
  } else {
    add(
      "market_session",
      false,
      true,
      `${session}-market session — liquidity is thinner and spreads wider than regular hours.`
    );
  }

  // 4. Spread --------------------------------------------------------------
  const policy = input.freshnessPolicy ?? DEFAULT_FRESHNESS_POLICY;
  if (input.quote && input.quote.spread !== null && input.quote.last) {
    const fraction = input.quote.spread / input.quote.last;
    const ok = fraction <= policy.maxSpreadFraction;
    add(
      "spread",
      true,
      ok,
      ok
        ? `Spread ${(fraction * 10_000).toFixed(1)} bps.`
        : `Spread ${(fraction * 10_000).toFixed(1)} bps exceeds the ${(policy.maxSpreadFraction * 10_000).toFixed(0)} bps limit.`
    );
  } else {
    // Not knowing the spread is a warning, not a block: many feeds are
    // trade-only, and refusing every such symbol would be over-restrictive.
    add("spread", false, false, "Spread unavailable from this feed.", true);
  }

  // 5. Volatility ----------------------------------------------------------
  const maxVolatility = input.maxVolatility ?? 1.5;
  if (input.volatility === null || input.volatility === undefined) {
    add("volatility", false, false, "Volatility could not be measured.", true);
  } else {
    const ok = input.volatility <= maxVolatility;
    add(
      "volatility",
      true,
      ok,
      ok
        ? `Annualised volatility ${(input.volatility * 100).toFixed(1)}%.`
        : `Annualised volatility ${(input.volatility * 100).toFixed(1)}% exceeds the ${(maxVolatility * 100).toFixed(0)}% ceiling.`
    );
  }

  // 6. Position size -------------------------------------------------------
  const maxPositionNotional = settings.accountEquity * settings.maxPositionFraction;
  if (input.proposedNotional <= 0) {
    add("position_size", true, false, "Proposed position size is zero.");
  } else {
    const ok = input.proposedNotional <= maxPositionNotional;
    add(
      "position_size",
      true,
      ok,
      ok
        ? `Position notional ${input.proposedNotional.toFixed(2)} within the ${maxPositionNotional.toFixed(2)} cap.`
        : `Position notional ${input.proposedNotional.toFixed(2)} exceeds the ${maxPositionNotional.toFixed(2)} cap.`
    );
  }

  // 7. Daily loss ----------------------------------------------------------
  const dailyLossLimit = settings.accountEquity * settings.maxDailyLossFraction;
  if (input.dailyPnl === null) {
    add("daily_loss", true, false, "Daily P&L is unknown — cannot verify the loss limit.", true);
  } else {
    const lossSoFar = Math.max(0, -input.dailyPnl);
    const projected = lossSoFar + input.proposedMaximumLoss;
    const ok = projected <= dailyLossLimit;
    add(
      "daily_loss",
      true,
      ok,
      ok
        ? `Loss today ${lossSoFar.toFixed(2)} plus this trade's ${input.proposedMaximumLoss.toFixed(2)} stays within the ${dailyLossLimit.toFixed(2)} daily limit.`
        : `Risk exceeds configured daily limit: ${lossSoFar.toFixed(2)} already lost plus ${input.proposedMaximumLoss.toFixed(2)} at risk against a ${dailyLossLimit.toFixed(2)} limit.`
    );
  }

  // 8. Portfolio exposure --------------------------------------------------
  const currentExposure = input.openPositions.reduce((sum, p) => sum + Math.abs(p.notional), 0);
  const exposureLimit = settings.accountEquity * settings.maxPortfolioExposureFraction;
  const projectedExposure = currentExposure + input.proposedNotional;
  const exposureOk = projectedExposure <= exposureLimit;
  add(
    "max_exposure",
    true,
    exposureOk,
    exposureOk
      ? `Total exposure would be ${projectedExposure.toFixed(2)} against a ${exposureLimit.toFixed(2)} limit.`
      : `Total exposure ${projectedExposure.toFixed(2)} would exceed the ${exposureLimit.toFixed(2)} portfolio limit.`
  );

  // 9. Correlation ---------------------------------------------------------
  if (input.correlationGroup) {
    const groupNotional = input.openPositions
      .filter((p) => p.correlationGroup === input.correlationGroup)
      .reduce((sum, p) => sum + Math.abs(p.notional), 0);
    const projectedGroup = groupNotional + input.proposedNotional;
    const groupLimit = settings.accountEquity * MAX_CORRELATED_GROUP_FRACTION;
    const ok = projectedGroup <= groupLimit;
    add(
      "correlation",
      false,
      ok,
      ok
        ? `Correlated exposure in "${input.correlationGroup}" would be ${projectedGroup.toFixed(2)}.`
        : `HIGH CORRELATION RISK — "${input.correlationGroup}" exposure would reach ${projectedGroup.toFixed(2)}, above the ${groupLimit.toFixed(2)} guideline.`
    );
  } else {
    add("correlation", false, true, "No correlation group assigned to this symbol.");
  }

  // 10. Duplicate orders ---------------------------------------------------
  if (input.clientOrderId && input.recentClientOrderIds?.includes(input.clientOrderId)) {
    add("duplicate_order", true, false, `Order id ${input.clientOrderId} was already submitted.`);
  } else {
    add("duplicate_order", true, true, "No duplicate order detected.");
  }

  // 11. News events --------------------------------------------------------
  const blockAroundEvents = input.blockAroundHighImpactEvents ?? true;
  const windowMinutes = input.eventBlockWindowMinutes ?? 30;
  const imminent = (input.upcomingEvents ?? []).filter(
    (event) =>
      event.importance === "high" &&
      event.scheduledAt >= now &&
      event.scheduledAt - now <= windowMinutes * 60_000
  );
  if (imminent.length === 0) {
    add(
      "news_event",
      false,
      true,
      `No high-importance events in the next ${windowMinutes} minutes.`
    );
  } else {
    const soonest = imminent.reduce((a, b) => (a.scheduledAt < b.scheduledAt ? a : b));
    const minutes = Math.round((soonest.scheduledAt - now) / 60_000);
    add(
      "news_event",
      blockAroundEvents,
      false,
      `${soonest.name} (${soonest.country}) in ${minutes} minute(s) — high-importance event.`
    );
  }

  // 12. Stop loss ----------------------------------------------------------
  if (input.stopPrice === null) {
    add("stop_loss", true, false, "No stop loss defined for this trade.");
  } else {
    add("stop_loss", true, true, `Stop loss set at ${input.stopPrice}.`);
  }

  // 13. Risk / reward ------------------------------------------------------
  if (input.riskRewardRatio === null) {
    add("risk_reward", true, false, "Risk/reward could not be computed.", true);
  } else {
    const ok = input.riskRewardRatio >= settings.minRiskRewardRatio;
    add(
      "risk_reward",
      true,
      ok,
      ok
        ? `Risk/reward 1:${input.riskRewardRatio.toFixed(2)}.`
        : `Risk/reward 1:${input.riskRewardRatio.toFixed(2)} is below the required 1:${settings.minRiskRewardRatio.toFixed(2)}.`
    );
  }

  const blockingReasons = checks.filter((c) => c.critical && !c.passed).map((c) => c.message);
  const warnings = checks.filter((c) => !c.critical && !c.passed).map((c) => c.message);

  const verdict: RiskVerdict =
    blockingReasons.length > 0 ? "BLOCKED" : warnings.length > 0 ? "WARNED" : "ALLOWED";

  return {
    verdict,
    checks,
    blockingReasons,
    warnings,
    summary: renderSummary(verdict, blockingReasons, warnings),
  };
}

function renderSummary(
  verdict: RiskVerdict,
  blockingReasons: readonly string[],
  warnings: readonly string[]
): string {
  if (verdict === "BLOCKED") {
    return ["TRADE BLOCKED", "", "Reason:", ...blockingReasons.map((r) => `- ${r}`)].join("\n");
  }
  if (verdict === "WARNED") {
    return [
      "TRADE PERMITTED WITH WARNINGS",
      "",
      "Warnings:",
      ...warnings.map((w) => `- ${w}`),
    ].join("\n");
  }
  return "ALL RISK CHECKS PASSED";
}

/**
 * Live-order gate (§22). Wraps `assessRisk` with the two conditions that only
 * apply to real execution: the broker must permit trading, and the user must
 * have confirmed this specific order.
 */
export interface LiveOrderGateInput extends RiskEvaluationInput {
  /** False unless the operator explicitly enabled live trading. */
  liveTradingEnabled: boolean;
  /** True only when the user confirmed THIS order (§40 — never silent). */
  userConfirmed: boolean;
}

export function assessLiveOrder(input: LiveOrderGateInput): RiskAssessment {
  const base = assessRisk(input);
  const checks = [...base.checks];
  const blockingReasons = [...base.blockingReasons];

  if (!input.liveTradingEnabled) {
    const message = "ORDER EXECUTION DISABLED — live trading is off for this installation.";
    checks.push({
      id: "account",
      critical: true,
      passed: false,
      indeterminate: false,
      message,
    });
    blockingReasons.push(message);
  }

  if (!input.userConfirmed) {
    const message = "Awaiting explicit user confirmation — orders are never submitted silently.";
    checks.push({
      id: "account",
      critical: true,
      passed: false,
      indeterminate: false,
      message,
    });
    blockingReasons.push(message);
  }

  const verdict: RiskVerdict =
    blockingReasons.length > 0 ? "BLOCKED" : base.warnings.length > 0 ? "WARNED" : "ALLOWED";

  return {
    verdict,
    checks,
    blockingReasons,
    warnings: base.warnings,
    summary: renderSummary(verdict, blockingReasons, base.warnings),
  };
}
