/**
 * Portfolio risk, journal analytics and the AI Copilot evidence packet
 * (master spec §9, §17, §23, §24, §41).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  assessPortfolioRisk,
  computeJournalStatistics,
  correlation,
  summarizePortfolio,
  toReturns,
  type PortfolioPosition,
} from "@/lib/trading/portfolio";
import {
  auditCopilotOutput,
  buildCopilotMessages,
  buildCopilotPrompt,
  COPILOT_SYSTEM_PROMPT,
  type CopilotEvidence,
} from "@/lib/trading/copilot";

// ---------------------------------------------------------------------------
// Correlation (§17)
// ---------------------------------------------------------------------------

test("correlation: identical series correlate at exactly 1", () => {
  const series = [0.01, -0.02, 0.03, 0.005, -0.01];
  const rho = correlation(series, series);
  assert.ok(rho !== null && Math.abs(rho - 1) < 1e-12, `got ${rho}`);
});

test("correlation: mirrored series correlate at exactly -1", () => {
  const series = [0.01, -0.02, 0.03, 0.005, -0.01];
  const rho = correlation(
    series,
    series.map((r) => -r)
  );
  assert.ok(rho !== null && Math.abs(rho + 1) < 1e-12, `got ${rho}`);
});

test("correlation: a constant series yields null, not zero", () => {
  assert.equal(correlation([1, 2, 3, 4], [5, 5, 5, 5]), null);
});

test("correlation: too few points yields null", () => {
  assert.equal(correlation([1, 2], [3, 4]), null);
});

test("toReturns: converts closes to simple returns", () => {
  const returns = toReturns([100, 110, 99]);
  assert.ok(Math.abs(returns[0] - 0.1) < 1e-12);
  assert.ok(Math.abs(returns[1] + 0.1) < 1e-12);
});

// ---------------------------------------------------------------------------
// Portfolio summary (§24)
// ---------------------------------------------------------------------------

const position = (overrides: Partial<PortfolioPosition>): PortfolioPosition => ({
  symbol: "AAPL",
  side: "long",
  quantity: 100,
  averageEntryPrice: 100,
  markPrice: 110,
  ...overrides,
});

test("portfolio: equity is cash plus unrealised P&L", () => {
  const summary = summarizePortfolio([position({})], 50_000, 1_000);
  assert.equal(summary.unrealizedPnl, 1_000);
  assert.equal(summary.totalEquity, 51_000);
  assert.equal(summary.invested, 11_000);
});

test("portfolio: an unpriced position is reported, never valued at cost", () => {
  const summary = summarizePortfolio([position({ symbol: "XYZ", markPrice: null })], 50_000, 0);
  assert.deepEqual(summary.unpricedSymbols, ["XYZ"]);
  assert.equal(summary.unrealizedPnl, 0);
  assert.equal(summary.invested, 0, "an unpriced position must not be counted as invested");
});

test("portfolio: a short position reduces net exposure but adds to gross", () => {
  const summary = summarizePortfolio(
    [position({ symbol: "A" }), position({ symbol: "B", side: "short" })],
    50_000,
    0
  );
  assert.ok(summary.grossExposure > 0);
  assert.ok(Math.abs(summary.netExposure) < 1e-9, "equal long and short should net to flat");
});

// ---------------------------------------------------------------------------
// Portfolio risk (§17)
// ---------------------------------------------------------------------------

test("portfolio risk: flags positions that are effectively the same bet", () => {
  const base = [0.01, 0.02, -0.01, 0.03, -0.02, 0.015];
  const report = assessPortfolioRisk(
    [position({ symbol: "A" }), position({ symbol: "B" })],
    { A: base, B: base.map((r) => r * 1.02) },
    100_000
  );
  assert.equal(report.highlyCorrelatedPairs.length, 1);
  assert.ok(report.highlyCorrelatedPairs[0].correlation > 0.9);
  assert.ok(report.warnings.some((w) => /HIGH CORRELATION RISK/.test(w)));
});

test("portfolio risk: opposite sides in correlated names are a hedge, not a flag", () => {
  const base = [0.01, 0.02, -0.01, 0.03, -0.02, 0.015];
  const report = assessPortfolioRisk(
    [position({ symbol: "A", side: "long" }), position({ symbol: "B", side: "short" })],
    { A: base, B: base },
    100_000
  );
  assert.equal(
    report.highlyCorrelatedPairs.length,
    0,
    "a long and a short in correlated names offset rather than concentrate"
  );
});

test("portfolio risk: names without history are named, not silently assumed uncorrelated", () => {
  const report = assessPortfolioRisk(
    [position({ symbol: "A" }), position({ symbol: "NOHIST" })],
    { A: [0.01, 0.02, -0.01, 0.03] },
    100_000
  );
  assert.deepEqual(report.symbolsWithoutHistory, ["NOHIST"]);
  assert.ok(report.warnings.some((w) => /incomplete/.test(w)));
});

test("portfolio risk: sector concentration is flagged above the threshold", () => {
  const report = assessPortfolioRisk(
    [
      position({ symbol: "A", sector: "tech", markPrice: 300 }),
      position({ symbol: "B", sector: "tech", markPrice: 300 }),
    ],
    {},
    100_000
  );
  // 2 × 100 × 300 = 60,000 of 100,000 equity = 60%.
  assert.ok(report.sectorConcentration[0].exposure > 0.5);
  assert.ok(report.warnings.some((w) => /Sector concentration/.test(w)));
});

// ---------------------------------------------------------------------------
// Journal (§23)
// ---------------------------------------------------------------------------

const day = 86_400_000;

test("journal: computes win rate, profit factor and expectancy", () => {
  const stats = computeJournalStatistics([
    { closedAt: day, netPnl: 200, riskAmount: 100 },
    { closedAt: 2 * day, netPnl: -100, riskAmount: 100 },
    { closedAt: 3 * day, netPnl: 300, riskAmount: 100 },
    { closedAt: 4 * day, netPnl: -100, riskAmount: 100 },
  ]);
  assert.equal(stats.totalTrades, 4);
  assert.equal(stats.winRate, 0.5);
  assert.equal(stats.profitFactor, 500 / 200);
  assert.equal(stats.netPnl, 300);
  // 0.5 × 250 − 0.5 × 100 = 75
  assert.ok(Math.abs(stats.expectancy - 75) < 1e-9);
});

test("journal: average R uses only trades that recorded their risk", () => {
  const stats = computeJournalStatistics([
    { closedAt: day, netPnl: 200, riskAmount: 100 }, // +2R
    { closedAt: 2 * day, netPnl: -100, riskAmount: 100 }, // −1R
    { closedAt: 3 * day, netPnl: 500, riskAmount: null }, // excluded
  ]);
  assert.ok(stats.averageR !== null && Math.abs(stats.averageR - 0.5) < 1e-9);
});

test("journal: average R is null when no trade recorded its risk", () => {
  const stats = computeJournalStatistics([{ closedAt: day, netPnl: 200, riskAmount: null }]);
  assert.equal(stats.averageR, null);
});

test("journal: max drawdown is measured on the cumulative P&L curve", () => {
  const stats = computeJournalStatistics([
    { closedAt: day, netPnl: 1_000, riskAmount: null },
    { closedAt: 2 * day, netPnl: -400, riskAmount: null },
    { closedAt: 3 * day, netPnl: -200, riskAmount: null },
    { closedAt: 4 * day, netPnl: 100, riskAmount: null },
  ]);
  assert.equal(stats.maxDrawdown, 600);
});

test("journal: groups P&L by day, ISO week and month", () => {
  const stats = computeJournalStatistics([
    { closedAt: Date.UTC(2026, 0, 5), netPnl: 100, riskAmount: null },
    { closedAt: Date.UTC(2026, 0, 6), netPnl: 50, riskAmount: null },
    { closedAt: Date.UTC(2026, 1, 10), netPnl: -25, riskAmount: null },
  ]);
  assert.equal(stats.byPeriod.daily.length, 3);
  assert.equal(stats.byPeriod.monthly.length, 2);
  assert.equal(stats.byPeriod.monthly[0].period, "2026-01");
  assert.equal(stats.byPeriod.monthly[0].netPnl, 150);
  // 5 and 6 Jan 2026 are Monday and Tuesday of the same ISO week.
  assert.equal(stats.byPeriod.weekly.length, 2);
});

test("journal: an empty journal yields zeros rather than NaN", () => {
  const stats = computeJournalStatistics([]);
  assert.equal(stats.totalTrades, 0);
  assert.equal(stats.winRate, 0);
  assert.equal(stats.expectancy, 0);
  assert.equal(stats.profitFactor, null);
});

// ---------------------------------------------------------------------------
// Copilot (§9, §34, §40)
// ---------------------------------------------------------------------------

const emptyEvidence = (overrides: Partial<CopilotEvidence> = {}): CopilotEvidence => ({
  instrument: { symbol: "AAPL", assetClass: "stock" },
  timeframe: "1H",
  generatedAt: Date.UTC(2026, 8, 4),
  dataStatus: "LIVE",
  dataSource: "test-provider",
  quote: null,
  structure: null,
  regime: null,
  mtf: null,
  signal: null,
  levels: null,
  sizing: null,
  risk: null,
  news: null,
  events: null,
  fundamentals: null,
  portfolio: null,
  portfolioRisk: null,
  ...overrides,
});

test("copilot: the system prompt forbids inventing data and promising profit", () => {
  assert.match(COPILOT_SYSTEM_PROMPT, /Use ONLY the values in the evidence packet/);
  assert.match(COPILOT_SYSTEM_PROMPT, /Never promise, guarantee or imply a profitable outcome/);
  assert.match(COPILOT_SYSTEM_PROMPT, /NO TRADE and WAIT are complete, legitimate answers/);
  assert.match(COPILOT_SYSTEM_PROMPT, /not\s+win\s+probability/);
});

test("copilot: missing sections are marked UNAVAILABLE rather than omitted silently", () => {
  const prompt = buildCopilotPrompt(emptyEvidence());
  assert.match(prompt, /DATA SOURCE UNAVAILABLE — no quote/);
  assert.match(prompt, /NEWS DATA UNAVAILABLE/);
  assert.match(prompt, /ECONOMIC CALENDAR UNAVAILABLE/);
  assert.match(prompt, /FUNDAMENTAL DATA UNAVAILABLE/);
});

test("copilot: a non-live data status is flagged prominently in the packet", () => {
  const prompt = buildCopilotPrompt(emptyEvidence({ dataStatus: "STALE" }));
  assert.match(prompt, /LIVE ANALYSIS DISABLED/);
});

test("copilot: DELAYED data does not raise the stale banner but is still labelled", () => {
  const prompt = buildCopilotPrompt(emptyEvidence({ dataStatus: "DELAYED" }));
  assert.doesNotMatch(prompt, /!! LIVE ANALYSIS DISABLED/);
  assert.match(prompt, /Data status: DELAYED/);
});

test("copilot: an empty news array is distinguished from no news provider", () => {
  const configured = buildCopilotPrompt(emptyEvidence({ news: [] }));
  assert.match(configured, /No articles returned/);
  assert.doesNotMatch(configured, /NEWS DATA UNAVAILABLE/);
});

test("copilot: messages are a system prompt followed by the evidence packet", () => {
  const messages = buildCopilotMessages(emptyEvidence());
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.match(messages[1].content, /=== EVIDENCE PACKET ===/);
});

test("copilot audit: flags guaranteed-profit and risk-free claims", () => {
  assert.equal(auditCopilotOutput("This setup offers a guaranteed profit.").clean, false);
  assert.equal(auditCopilotOutput("A risk-free entry here.").clean, false);
  assert.equal(auditCopilotOutput("You can't lose on this one.").clean, false);
  assert.equal(
    auditCopilotOutput("There is a 95% probability of profit.").clean,
    false,
    "a fabricated win probability must be flagged"
  );
});

test("copilot audit: legitimate cautious analysis passes clean", () => {
  const text =
    "MARKET REGIME: trending. The signal score is 74/100 with factor agreement 0.68. " +
    "Risk/reward to TP1 is 1:2.30. WARNINGS: elevated volatility. FINAL STATE: WAIT.";
  const audit = auditCopilotOutput(text);
  assert.equal(audit.clean, true, `unexpected violations: ${audit.violations.join(", ")}`);
});
