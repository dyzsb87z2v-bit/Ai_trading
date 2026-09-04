/**
 * AI Trading Copilot (master spec §9, §28, §34, §40).
 *
 * The Copilot does NOT decide anything. Every number it presents — score,
 * levels, position size, risk verdict — is computed by the deterministic
 * engines in this directory and passed to the model as an evidence packet. The
 * model's only job is to explain that evidence in prose.
 *
 * This split is the whole design. An LLM asked to "analyse the chart" will
 * happily invent a support level; an LLM handed computed levels and told to
 * explain them cannot, because the numbers are already fixed. Anything the
 * model adds beyond the packet is, by construction, commentary rather than data.
 *
 * The model is reached through any OpenAI-compatible endpoint configured via
 * COPILOT_BASE_URL / COPILOT_MODEL. With none configured the Copilot reports
 * itself unavailable; every score and level is computed without it.
 */

import type { RegimeAssessment } from "./regime";
import type { MarketStructure } from "./structure";
import type { MtfAnalysis } from "./mtf";
import type { SignalResult } from "./signal";
import type { TradePlanLevels } from "./entry";
import type { PositionSizeResult } from "./positionSizing";
import type { RiskAssessment } from "./riskEngine";
import type { PortfolioRiskReport, PortfolioSummary } from "./portfolio";
import type { EconomicEvent, Fundamentals, NewsArticle } from "./providers/types";
import type { DataStatus, Instrument, Quote, Timeframe } from "./types";

/**
 * Everything the model is allowed to know. If a field is null the model must
 * say the information is unavailable — it may not fill the gap.
 */
export interface CopilotEvidence {
  instrument: Instrument;
  timeframe: Timeframe;
  generatedAt: number;
  dataStatus: DataStatus;
  dataSource: string;
  quote: Quote | null;
  structure: MarketStructure | null;
  regime: RegimeAssessment | null;
  mtf: MtfAnalysis | null;
  signal: SignalResult | null;
  levels: TradePlanLevels | null;
  sizing: PositionSizeResult | null;
  risk: RiskAssessment | null;
  news: readonly NewsArticle[] | null;
  events: readonly EconomicEvent[] | null;
  fundamentals: Fundamentals | null;
  portfolio: PortfolioSummary | null;
  portfolioRisk: PortfolioRiskReport | null;
}

/**
 * The Copilot's system prompt.
 *
 * The prohibitions are stated as hard constraints rather than preferences
 * because a model that hedges on these produces exactly the output the spec
 * forbids: invented levels, implied guarantees, and pressure to trade.
 */
export const COPILOT_SYSTEM_PROMPT = `You are a trading analysis assistant inside a trading terminal.

You are given a structured EVIDENCE PACKET containing values computed by
deterministic engines: indicators, market structure, multi-timeframe readings,
a signal score, trade levels, position sizing and risk-check results.

ABSOLUTE RULES:
1. Use ONLY the values in the evidence packet. Never state a price, level,
   indicator value, news item or statistic that is not in it.
2. If a field is null or missing, say the information is unavailable. Never
   estimate, infer or fill it in.
3. Never promise, guarantee or imply a profitable outcome. Never state a
   probability of success — the score provided measures factor agreement, not
   win probability.
4. Never tell the user they should trade. Present the evidence and the decision
   the engines reached. NO TRADE and WAIT are complete, legitimate answers.
5. If the risk engine returned BLOCKED, lead with that and explain the blocking
   reasons. Do not suggest ways around them.
6. If the data status is not LIVE or DELAYED, state prominently that live
   analysis is disabled and that nothing below should be acted on.
7. Distinguish LIVE, DELAYED, HISTORICAL, PAPER and SIMULATED data explicitly
   whenever you cite a value.

OUTPUT STRUCTURE — use these headings, omitting any for which no data exists:
MARKET REGIME
TREND
MOMENTUM
KEY LEVELS
BULLISH FACTORS
BEARISH FACTORS
ENTRY ZONE
INVALIDATION LEVEL
STOP LOSS
TAKE PROFIT
RISK/REWARD
POSITION SIZE
WARNINGS
SIGNAL SCORE
FINAL STATE

Be concise and specific. Cite the computed numbers. Explain reasoning from the
evidence, never from general market intuition.`;

/**
 * Render the evidence packet as the user message.
 *
 * Deliberately plain text rather than raw JSON: the packet is already a
 * curated projection, and prose-with-numbers keeps the model anchored to the
 * values instead of pattern-matching a schema it might extend.
 */
export function buildCopilotPrompt(evidence: CopilotEvidence): string {
  const lines: string[] = [];
  const push = (label: string, value: string | number | null | undefined) => {
    lines.push(`${label}: ${value === null || value === undefined ? "UNAVAILABLE" : value}`);
  };

  lines.push("=== EVIDENCE PACKET ===");
  push("Symbol", evidence.instrument.symbol);
  push("Asset class", evidence.instrument.assetClass);
  push("Timeframe", evidence.timeframe);
  push("Data status", evidence.dataStatus);
  push("Data source", evidence.dataSource);
  push("Generated at", new Date(evidence.generatedAt).toISOString());

  if (evidence.dataStatus !== "LIVE" && evidence.dataStatus !== "DELAYED") {
    lines.push(
      "",
      `!! LIVE ANALYSIS DISABLED — data status is ${evidence.dataStatus}. Say so prominently. !!`
    );
  }

  lines.push("", "--- QUOTE ---");
  if (evidence.quote) {
    push("Last", evidence.quote.last);
    push("Bid", evidence.quote.bid);
    push("Ask", evidence.quote.ask);
    push("Spread", evidence.quote.spread);
    push("Volume", evidence.quote.volume);
    push("VWAP (provider)", evidence.quote.vwap);
    push("Change %", evidence.quote.changePercent);
    push("Session", evidence.quote.session);
    push("Quote timestamp", new Date(evidence.quote.provenance.timestamp).toISOString());
  } else {
    lines.push("DATA SOURCE UNAVAILABLE — no quote.");
  }

  lines.push("", "--- MARKET REGIME ---");
  if (evidence.regime) {
    push("Regime", evidence.regime.regime);
    push("Confidence", evidence.regime.confidence.toFixed(2));
    push("Risk multiplier", evidence.regime.riskMultiplier);
    evidence.regime.evidence.forEach((e) => lines.push(`  - ${e}`));
  } else {
    lines.push("UNAVAILABLE");
  }

  lines.push("", "--- MARKET STRUCTURE ---");
  if (evidence.structure) {
    push("Trend", evidence.structure.trend);
    push("Trend strength", evidence.structure.trendStrength.toFixed(2));
    push("Volatility regime", evidence.structure.volatility);
    push(
      "ATR % of price",
      evidence.structure.atrPercent === null
        ? null
        : (evidence.structure.atrPercent * 100).toFixed(2) + "%"
    );
    lines.push("Support levels:");
    evidence.structure.support.forEach((l) =>
      lines.push(`  - ${l.price.toFixed(4)} (${l.touches} touch(es))`)
    );
    lines.push("Resistance levels:");
    evidence.structure.resistance.forEach((l) =>
      lines.push(`  - ${l.price.toFixed(4)} (${l.touches} touch(es))`)
    );
    evidence.structure.rationale.forEach((r) => lines.push(`  - ${r}`));
  } else {
    lines.push("UNAVAILABLE");
  }

  lines.push("", "--- MULTI-TIMEFRAME ---");
  if (evidence.mtf) {
    push("Alignment", evidence.mtf.alignment);
    push("Aggregate bias", evidence.mtf.aggregateBias.toFixed(2));
    push("Narrative", evidence.mtf.narrative);
    evidence.mtf.views.forEach((v) => lines.push(`  - ${v.timeframe}: ${v.trend} — ${v.evidence}`));
    evidence.mtf.conflicts.forEach((c) => lines.push(`  ! CONFLICT: ${c}`));
  } else {
    lines.push("UNAVAILABLE");
  }

  lines.push("", "--- SIGNAL ---");
  if (evidence.signal) {
    push("Score (0-100)", evidence.signal.score.toFixed(0));
    push("State", evidence.signal.state);
    push("Grade", evidence.signal.grade);
    push("Factor agreement (NOT a win probability)", evidence.signal.agreement.toFixed(2));
    push("Tradeable", String(evidence.signal.tradeable));
    lines.push("Factors:");
    evidence.signal.factors.forEach((f) =>
      lines.push(
        `  - ${f.label} [${f.id}] value ${f.value.toFixed(2)} weight ${f.weight.toFixed(2)}: ${f.evidence}`
      )
    );
    lines.push("Warnings:");
    evidence.signal.warnings.forEach((w) => lines.push(`  - [${w.severity}] ${w.message}`));
  } else {
    lines.push("UNAVAILABLE");
  }

  lines.push("", "--- TRADE LEVELS ---");
  if (evidence.levels) {
    const l = evidence.levels;
    push("Side", l.side);
    push("Entry zone", `${l.entryZoneLow.toFixed(4)} – ${l.entryZoneHigh.toFixed(4)}`);
    push("Preferred entry", l.preferredEntry.toFixed(4));
    push("Invalidation", l.invalidation.toFixed(4));
    push("Stop loss", l.stopLoss.toFixed(4));
    push("TP1", l.takeProfit1.toFixed(4));
    push("TP2", l.takeProfit2.toFixed(4));
    push("TP3", l.takeProfit3.toFixed(4));
    push("Risk/reward to TP1", l.riskReward === null ? null : `1:${l.riskReward.toFixed(2)}`);
    l.rationale.forEach((r) => lines.push(`  - ${r}`));
  } else {
    lines.push("UNAVAILABLE — no coherent trade plan could be derived.");
  }

  lines.push("", "--- POSITION SIZE ---");
  if (evidence.sizing) {
    const s = evidence.sizing;
    push("Tradeable", String(s.tradeable));
    push("Quantity", s.quantity);
    push("Notional", s.notional.toFixed(2));
    push("Risk budget", s.riskAmount.toFixed(2));
    push("Maximum loss (incl. fees + slippage)", s.maximumLoss.toFixed(2));
    push("Estimated fees", s.estimatedFees.toFixed(2));
    push("Estimated slippage", s.estimatedSlippage.toFixed(2));
    push("Leverage", s.leverage.toFixed(2));
    push("Binding constraint", s.bindingConstraint);
    push("Reason", s.reason);
    s.warnings.forEach((w) => lines.push(`  ! ${w}`));
  } else {
    lines.push("UNAVAILABLE");
  }

  lines.push("", "--- RISK CHECKS ---");
  if (evidence.risk) {
    push("Verdict", evidence.risk.verdict);
    evidence.risk.checks.forEach((c) =>
      lines.push(
        `  - [${c.passed ? "PASS" : c.indeterminate ? "UNKNOWN" : "FAIL"}]${c.critical ? " (critical)" : ""} ${c.id}: ${c.message}`
      )
    );
  } else {
    lines.push("UNAVAILABLE");
  }

  lines.push("", "--- NEWS ---");
  if (evidence.news === null) {
    lines.push("NEWS DATA UNAVAILABLE — no news provider is configured.");
  } else if (evidence.news.length === 0) {
    lines.push("No articles returned for this symbol in the requested window.");
  } else {
    evidence.news
      .slice(0, 10)
      .forEach((a) =>
        lines.push(
          `  - [${new Date(a.publishedAt).toISOString()}] ${a.source}: ${a.headline} ` +
            `(sentiment: ${a.sentiment ?? "not scored"}, impact: ${a.impact ?? "not scored"})`
        )
      );
  }

  lines.push("", "--- ECONOMIC EVENTS ---");
  if (evidence.events === null) {
    lines.push("ECONOMIC CALENDAR UNAVAILABLE — no calendar provider is configured.");
  } else if (evidence.events.length === 0) {
    lines.push("No scheduled events in the requested window.");
  } else {
    evidence.events
      .slice(0, 10)
      .forEach((e) =>
        lines.push(
          `  - ${new Date(e.scheduledAt).toISOString()} ${e.country} ${e.name} ` +
            `(importance: ${e.importance}, previous: ${e.previous ?? "n/a"}, forecast: ${e.forecast ?? "n/a"}, actual: ${e.actual ?? "n/a"})`
        )
      );
  }

  lines.push("", "--- FUNDAMENTALS ---");
  if (evidence.fundamentals === null) {
    lines.push("FUNDAMENTAL DATA UNAVAILABLE — no fundamentals provider is configured.");
  } else {
    for (const [key, value] of Object.entries(evidence.fundamentals)) {
      if (key === "symbol" || key === "asOf") continue;
      lines.push(`  - ${key}: ${value === null ? "UNAVAILABLE" : value}`);
    }
  }

  lines.push("", "--- PORTFOLIO ---");
  if (evidence.portfolio) {
    push("Total equity", evidence.portfolio.totalEquity.toFixed(2));
    push("Cash", evidence.portfolio.cash.toFixed(2));
    push("Unrealised P&L", evidence.portfolio.unrealizedPnl.toFixed(2));
    push("Realised P&L", evidence.portfolio.realizedPnl.toFixed(2));
    push("Gross exposure", (evidence.portfolio.grossExposure * 100).toFixed(0) + "%");
    push("Net exposure", (evidence.portfolio.netExposure * 100).toFixed(0) + "%");
    push("Open positions", evidence.portfolio.positions);
    if (evidence.portfolio.unpricedSymbols.length > 0) {
      lines.push(
        `  ! Unpriced (excluded from valuation): ${evidence.portfolio.unpricedSymbols.join(", ")}`
      );
    }
  } else {
    lines.push("UNAVAILABLE");
  }

  if (evidence.portfolioRisk) {
    lines.push("", "--- PORTFOLIO RISK ---");
    evidence.portfolioRisk.warnings.forEach((w) => lines.push(`  ! ${w}`));
    if (evidence.portfolioRisk.warnings.length === 0) {
      lines.push("No portfolio-level concentration or correlation flags.");
    }
  }

  lines.push("", "=== END OF EVIDENCE PACKET ===");
  lines.push(
    "",
    "Explain this evidence following the required output structure. Do not add any value that is not above."
  );

  return lines.join("\n");
}

export interface CopilotMessage {
  role: "system" | "user";
  content: string;
}

/** Build the exact messages array for a chat-completions call. */
export function buildCopilotMessages(evidence: CopilotEvidence): CopilotMessage[] {
  return [
    { role: "system", content: COPILOT_SYSTEM_PROMPT },
    { role: "user", content: buildCopilotPrompt(evidence) },
  ];
}

/**
 * Guard against the one failure mode this design cannot prevent structurally:
 * a model that emits a forbidden claim anyway.
 *
 * This is a DETECTOR, not a sanitiser — it flags output for the UI to mark,
 * and deliberately does not rewrite the model's words.
 */
export interface CopilotOutputAudit {
  clean: boolean;
  violations: string[];
}

const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /guarantee(d|s)?\s+(profit|return|gain|win)/i, label: "guaranteed-profit claim" },
  { pattern: /\brisk[- ]free\b/i, label: "risk-free claim" },
  { pattern: /\bcan'?t lose\b|\bcannot lose\b/i, label: "cannot-lose claim" },
  { pattern: /\bsure thing\b|\bguaranteed win\b/i, label: "certainty claim" },
  {
    pattern: /\b\d{2,3}%\s+(chance|probability)\s+of\s+(profit|success|winning)/i,
    label: "fabricated win probability",
  },
];

export function auditCopilotOutput(text: string): CopilotOutputAudit {
  const violations: string[] = [];
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) violations.push(label);
  }
  return { clean: violations.length === 0, violations };
}
