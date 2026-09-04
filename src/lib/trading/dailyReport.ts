/**
 * Daily AI market report (master spec §28).
 *
 * Assembles an evidence packet from values the engines already computed, in the
 * same shape and with the same discipline as the Copilot packet: a section with
 * no data says so, and the model is told it may not fill the gap.
 */

import type { ScanResult } from "./scanner";
import type { PositionMonitorResult } from "./positionMonitor";
import type { PortfolioRiskReport, PortfolioSummary } from "./portfolio";
import type { EconomicEvent, NewsArticle } from "./providers/types";

export interface DailyReportInput {
  generatedAt: number;
  /** Broad-market instruments (indices/majors) already analysed. */
  overview: {
    symbol: string;
    changePercent: number | null;
    trend: string | null;
    regime: string | null;
    dataStatus: string;
  }[];
  scan: ScanResult | null;
  news: readonly NewsArticle[] | null;
  events: readonly EconomicEvent[] | null;
  portfolio: PortfolioSummary | null;
  portfolioRisk: PortfolioRiskReport | null;
  openPositions: readonly PositionMonitorResult[];
}

export const DAILY_REPORT_SYSTEM_PROMPT = `You are writing a daily market report inside a trading terminal.

You are given a REPORT PACKET of values computed by deterministic engines.

ABSOLUTE RULES:
1. Use ONLY the packet. Never state a price, level, statistic or news item that
   is not in it.
2. A section marked UNAVAILABLE stays unavailable — say so and move on. Never
   estimate or fill it in.
3. Never promise, guarantee or imply a profitable outcome, and never state a
   probability of success.
4. Never tell the reader to trade. Report what the engines found. "No tradeable
   setups today" is a complete and useful report.
5. Flag any instrument whose data status is not LIVE or DELAYED as not
   actionable.

STRUCTURE — omit any heading with no data:
MARKET OVERVIEW
MAJOR INDICES
BEST SETUPS
WORST SETUPS
HIGH RISK ASSETS
IMPORTANT NEWS
ECONOMIC EVENTS
PORTFOLIO RISK
OPEN TRADE ANALYSIS

Be concise. Cite the computed numbers.`;

export function buildDailyReportPacket(input: DailyReportInput): string {
  const lines: string[] = [];
  const push = (label: string, value: string | number | null | undefined) =>
    lines.push(`${label}: ${value === null || value === undefined ? "UNAVAILABLE" : value}`);

  lines.push("=== REPORT PACKET ===");
  push("Generated at", new Date(input.generatedAt).toISOString());

  lines.push("", "--- MARKET OVERVIEW ---");
  if (input.overview.length === 0) {
    lines.push("UNAVAILABLE — no broad-market instruments were analysed.");
  } else {
    for (const item of input.overview) {
      lines.push(
        `  - ${item.symbol}: ${item.changePercent === null ? "change UNAVAILABLE" : `${item.changePercent >= 0 ? "+" : ""}${item.changePercent.toFixed(2)}%`}` +
          `, trend ${item.trend ?? "UNAVAILABLE"}, regime ${item.regime ?? "UNAVAILABLE"}` +
          ` [data: ${item.dataStatus}]`
      );
    }
  }

  lines.push("", "--- SCAN RESULTS ---");
  if (!input.scan) {
    lines.push("UNAVAILABLE — no scan was run.");
  } else {
    push("Symbols scanned", input.scan.scanned);
    const tradeable = input.scan.hits.filter((h) => h.tradeable);
    push("Tradeable setups", tradeable.length);

    lines.push("Best setups:");
    if (tradeable.length === 0) {
      lines.push("  (none — no setup cleared the risk engine today)");
    } else {
      for (const hit of tradeable.slice(0, 5)) {
        lines.push(
          `  - ${hit.symbol} ${hit.side.toUpperCase()} ${hit.state} ${hit.score.toFixed(0)}/100 (grade ${hit.grade})` +
            `${hit.riskReward !== null ? `, R:R 1:${hit.riskReward.toFixed(2)}` : ""}` +
            `${hit.entry !== null ? `, entry ${hit.entry.toFixed(4)}` : ""}` +
            `${hit.stop !== null ? `, stop ${hit.stop.toFixed(4)}` : ""} [${hit.kinds.join(", ") || "no pattern"}]`
        );
      }
    }

    const blocked = input.scan.hits.filter((h) => !h.tradeable).slice(0, 5);
    if (blocked.length > 0) {
      lines.push("Blocked or low-quality:");
      for (const hit of blocked) {
        lines.push(`  - ${hit.symbol}: ${hit.verdict} — ${hit.reasons[0] ?? "no reason recorded"}`);
      }
    }

    if (input.scan.failures.length > 0) {
      lines.push("Could not be analysed:");
      for (const failure of input.scan.failures) {
        lines.push(`  ! ${failure.symbol}: ${failure.reason}`);
      }
    }

    const risky = input.scan.hits.filter(
      (h) =>
        h.kinds.includes("high_volatility") || h.warnings.some((w) => /volatility|panic/i.test(w))
    );
    lines.push("High-risk assets:");
    if (risky.length === 0) lines.push("  (none flagged)");
    else
      for (const hit of risky.slice(0, 5))
        lines.push(`  - ${hit.symbol}: ${hit.warnings[0] ?? "elevated volatility"}`);
  }

  lines.push("", "--- NEWS ---");
  if (input.news === null) {
    lines.push("NEWS DATA UNAVAILABLE — no news provider is configured.");
  } else if (input.news.length === 0) {
    lines.push("No articles in the requested window.");
  } else {
    for (const article of input.news.slice(0, 10)) {
      lines.push(
        `  - [${new Date(article.publishedAt).toISOString()}] ${article.source}: ${article.headline}` +
          ` (sentiment: ${article.sentiment ?? "not scored"}, impact: ${article.impact ?? "not scored"})`
      );
    }
  }

  lines.push("", "--- ECONOMIC EVENTS ---");
  if (input.events === null) {
    lines.push("ECONOMIC CALENDAR UNAVAILABLE — no calendar provider is configured.");
  } else if (input.events.length === 0) {
    lines.push("No scheduled events in the requested window.");
  } else {
    for (const event of input.events.slice(0, 10)) {
      lines.push(
        `  - ${new Date(event.scheduledAt).toISOString()} ${event.country} ${event.name}` +
          ` (importance ${event.importance}, previous ${event.previous ?? "n/a"}, forecast ${event.forecast ?? "n/a"}, actual ${event.actual ?? "n/a"})`
      );
    }
  }

  lines.push("", "--- PORTFOLIO ---");
  if (!input.portfolio) {
    lines.push("UNAVAILABLE");
  } else {
    push("Total equity", input.portfolio.totalEquity.toFixed(2));
    push("Unrealised P&L", input.portfolio.unrealizedPnl.toFixed(2));
    push("Realised P&L", input.portfolio.realizedPnl.toFixed(2));
    push("Gross exposure", `${(input.portfolio.grossExposure * 100).toFixed(0)}%`);
    push("Net exposure", `${(input.portfolio.netExposure * 100).toFixed(0)}%`);
    push("Open positions", input.portfolio.positions);
    if (input.portfolio.unpricedSymbols.length > 0) {
      lines.push(
        `  ! Unpriced, excluded from valuation: ${input.portfolio.unpricedSymbols.join(", ")}`
      );
    }
  }

  lines.push("", "--- PORTFOLIO RISK ---");
  if (!input.portfolioRisk) {
    lines.push("UNAVAILABLE");
  } else if (input.portfolioRisk.warnings.length === 0) {
    lines.push("No concentration or correlation flags.");
  } else {
    for (const warning of input.portfolioRisk.warnings) lines.push(`  ! ${warning}`);
  }

  lines.push("", "--- OPEN TRADES ---");
  if (input.openPositions.length === 0) {
    lines.push("No open positions.");
  } else {
    for (const position of input.openPositions) {
      lines.push(
        `  - ${position.symbol} ${position.side.toUpperCase()}: ` +
          `${position.unrealizedPercent === null ? "P&L UNAVAILABLE" : `${position.unrealizedPercent >= 0 ? "+" : ""}${position.unrealizedPercent.toFixed(2)}%`}` +
          `${position.rMultiple !== null ? `, ${position.rMultiple.toFixed(2)}R` : ""}` +
          `, trend ${position.trend}, recommendation ${position.recommendation}`
      );
      lines.push(`      ${position.recommendationReason}`);
    }
  }

  lines.push("", "=== END OF REPORT PACKET ===");
  lines.push("", "Write the report using the required structure. Add nothing that is not above.");
  return lines.join("\n");
}

export function buildDailyReportMessages(
  input: DailyReportInput
): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: DAILY_REPORT_SYSTEM_PROMPT },
    { role: "user", content: buildDailyReportPacket(input) },
  ];
}
