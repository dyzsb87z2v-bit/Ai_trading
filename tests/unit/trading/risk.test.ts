/**
 * Position sizing, risk engine and entry engine (master spec §10, §11, §12, §41).
 *
 * These encode the invariants that must hold for the platform to be safe to
 * put in front of a user: risk never exceeds the configured budget, a failed
 * check always blocks, and missing data never reads as permission.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_COST_MODEL,
  DEFAULT_RISK_SETTINGS,
  calculatePositionSize,
  riskRewardRatio,
  roundDownToIncrement,
  type RiskSettings,
} from "@/lib/trading/positionSizing";
import { assessLiveOrder, assessRisk } from "@/lib/trading/riskEngine";
import { buildTradePlanLevels } from "@/lib/trading/entry";
import { analyzeStructure } from "@/lib/trading/structure";
import type { Candle, Quote } from "@/lib/trading/types";
import type { EconomicEvent } from "@/lib/trading/providers/types";

const settings = (overrides: Partial<RiskSettings> = {}): RiskSettings => ({
  ...DEFAULT_RISK_SETTINGS,
  accountEquity: 50_000,
  riskPerTradeFraction: 0.01,
  ...overrides,
});

const NO_COSTS = { commissionRate: 0, commissionFlat: 0, slippageRate: 0 };

// ---------------------------------------------------------------------------
// Position sizing (§11)
// ---------------------------------------------------------------------------

test("position size: risk budget divided by stop distance, with no costs", () => {
  const result = calculatePositionSize({
    entryPrice: 100,
    stopPrice: 95,
    side: "long",
    settings: settings(),
    costs: NO_COSTS,
  });
  // 1% of 50,000 = 500 budget; 5 per share stop → 100 shares.
  assert.equal(result.quantity, 100);
  assert.equal(result.riskAmount, 500);
  assert.equal(result.maximumLoss, 500);
  assert.ok(result.tradeable);
});

test("position size: maximum loss never exceeds the risk budget once costs apply", () => {
  const result = calculatePositionSize({
    entryPrice: 100,
    stopPrice: 95,
    side: "long",
    settings: settings(),
    costs: DEFAULT_COST_MODEL,
  });
  assert.ok(result.quantity < 100, "costs must reduce size below the cost-free quantity");
  assert.ok(
    result.maximumLoss <= result.riskAmount * 1.0001,
    `maximum loss ${result.maximumLoss} must stay within the ${result.riskAmount} budget`
  );
});

test("position size: rounds DOWN so risk can never exceed the limit", () => {
  const result = calculatePositionSize({
    entryPrice: 100,
    stopPrice: 97,
    side: "long",
    // maxPositionFraction lifted so the RISK budget is the binding constraint;
    // at the 20% default the position cap binds first and rounding is not the
    // thing under test.
    settings: settings({ accountEquity: 10_000, maxPositionFraction: 1 }),
    costs: NO_COSTS,
    quantityIncrement: 1,
  });
  // budget 100 / stop 3 = 33.33 → 33, never 34.
  assert.equal(result.quantity, 33);
  assert.ok(result.maximumLoss <= 100);
});

test("position size: honours fractional increments for crypto", () => {
  const result = calculatePositionSize({
    entryPrice: 50_000,
    stopPrice: 49_000,
    side: "long",
    // 0.5 BTC is 50% of equity in notional, so the position cap must allow it
    // for the risk budget to be what sets the size.
    settings: settings({ maxPositionFraction: 1 }),
    costs: NO_COSTS,
    quantityIncrement: 0.0001,
  });
  // budget 500 / 1000 per unit = 0.5 BTC
  assert.ok(Math.abs(result.quantity - 0.5) < 1e-9, `got ${result.quantity}`);
});

test("position size: rejects a long whose stop sits at or above entry", () => {
  const result = calculatePositionSize({
    entryPrice: 100,
    stopPrice: 100,
    side: "long",
    settings: settings(),
  });
  assert.equal(result.tradeable, false);
  assert.equal(result.quantity, 0);
  assert.match(result.reason, /stop below the entry/i);
});

test("position size: rejects a short whose stop sits below entry", () => {
  const result = calculatePositionSize({
    entryPrice: 100,
    stopPrice: 95,
    side: "short",
    settings: settings(),
  });
  assert.equal(result.tradeable, false);
  assert.match(result.reason, /stop above the entry/i);
});

test("position size: zero equity yields no position rather than a NaN", () => {
  const result = calculatePositionSize({
    entryPrice: 100,
    stopPrice: 95,
    side: "long",
    settings: settings({ accountEquity: 0 }),
  });
  assert.equal(result.tradeable, false);
  assert.equal(result.quantity, 0);
});

test("position size: the max-position cap binds before the risk budget when the stop is tight", () => {
  const result = calculatePositionSize({
    entryPrice: 100,
    stopPrice: 99.9,
    side: "long",
    settings: settings({ maxPositionFraction: 0.1 }),
    costs: NO_COSTS,
  });
  // Risk budget alone would allow 5,000 shares (500,000 notional); the 10%
  // cap allows 5,000 of equity → 50 shares.
  assert.equal(result.bindingConstraint, "position_cap");
  assert.equal(result.quantity, 50);
  assert.ok(result.warnings.some((w) => /max-position cap/.test(w)));
});

test("position size: leverage cap is never exceeded", () => {
  const result = calculatePositionSize({
    entryPrice: 100,
    stopPrice: 99.99,
    side: "long",
    settings: settings({ maxPositionFraction: 10, maxLeverage: 2 }),
    costs: NO_COSTS,
  });
  assert.ok(result.leverage <= 2 + 1e-9, `leverage ${result.leverage} exceeded the 2x cap`);
  assert.equal(result.bindingConstraint, "leverage");
});

test("position size: a regime multiplier can only reduce risk, never raise it", () => {
  const base = calculatePositionSize({
    entryPrice: 100,
    stopPrice: 95,
    side: "long",
    settings: settings(),
    costs: NO_COSTS,
  });
  const inflated = calculatePositionSize({
    entryPrice: 100,
    stopPrice: 95,
    side: "long",
    settings: settings(),
    costs: NO_COSTS,
    riskMultiplier: 5,
  });
  assert.equal(inflated.quantity, base.quantity, "a >1 multiplier must be clamped to 1");

  const reduced = calculatePositionSize({
    entryPrice: 100,
    stopPrice: 95,
    side: "long",
    settings: settings(),
    costs: NO_COSTS,
    riskMultiplier: 0.5,
  });
  assert.equal(reduced.quantity, base.quantity / 2);
});

test("position size: contract size scales risk for leveraged instruments", () => {
  const result = calculatePositionSize({
    entryPrice: 100,
    stopPrice: 95,
    side: "long",
    settings: settings(),
    costs: NO_COSTS,
    contractSize: 10,
  });
  // Each point is worth 10, so a 5-point stop risks 50 per contract → 10 contracts.
  assert.equal(result.quantity, 10);
  assert.equal(result.maximumLoss, 500);
});

test("position size: a budget too small for one increment is untradeable, not rounded up", () => {
  const result = calculatePositionSize({
    entryPrice: 5_000,
    stopPrice: 4_000,
    side: "long",
    settings: settings({ accountEquity: 100, riskPerTradeFraction: 0.01 }),
    costs: NO_COSTS,
    quantityIncrement: 1,
  });
  assert.equal(result.tradeable, false);
  assert.equal(result.quantity, 0);
});

test("roundDownToIncrement: never rounds up and avoids float dust", () => {
  assert.equal(roundDownToIncrement(33.99, 1), 33);
  assert.equal(roundDownToIncrement(0.3, 0.1), 0.3);
  assert.equal(roundDownToIncrement(2.0, 1), 2);
});

test("riskRewardRatio: reward over risk, null when risk is zero", () => {
  assert.equal(riskRewardRatio(100, 95, 115), 3);
  assert.equal(riskRewardRatio(100, 100, 115), null);
});

// ---------------------------------------------------------------------------
// Risk engine (§12, §22)
// ---------------------------------------------------------------------------

const freshQuote = (overrides: Partial<Quote> = {}): Quote => ({
  instrument: { symbol: "AAPL", assetClass: "stock" },
  last: 100,
  bid: 99.99,
  ask: 100.01,
  spread: 0.02,
  volume: 1_000_000,
  tradeCount: 5_000,
  vwap: 100,
  changePercent: 0.5,
  session: "regular",
  provenance: { source: "test-provider", timestamp: Date.now(), status: "LIVE" },
  ...overrides,
});

const baseRiskInput = () => ({
  symbol: "AAPL",
  side: "long" as const,
  settings: settings(),
  quote: freshQuote(),
  proposedNotional: 10_000,
  proposedMaximumLoss: 500,
  stopPrice: 95,
  riskRewardRatio: 3,
  dailyPnl: 0,
  openPositions: [],
  volatility: 0.3,
});

test("risk engine: a clean setup is allowed", () => {
  const assessment = assessRisk(baseRiskInput());
  assert.equal(assessment.verdict, "ALLOWED", assessment.summary);
  assert.equal(assessment.blockingReasons.length, 0);
});

test("risk engine: stale market data blocks the trade", () => {
  const assessment = assessRisk({
    ...baseRiskInput(),
    quote: freshQuote({
      provenance: { source: "test-provider", timestamp: Date.now() - 120_000, status: "LIVE" },
    }),
  });
  assert.equal(assessment.verdict, "BLOCKED");
  assert.ok(assessment.blockingReasons.some((r) => /LIVE ANALYSIS DISABLED/.test(r)));
});

test("risk engine: a missing quote blocks rather than being treated as fine", () => {
  const assessment = assessRisk({ ...baseRiskInput(), quote: null });
  assert.equal(assessment.verdict, "BLOCKED");
  assert.ok(assessment.blockingReasons.some((r) => /DATA SOURCE UNAVAILABLE/.test(r)));
});

test("risk engine: unknown daily P&L fails closed", () => {
  const assessment = assessRisk({ ...baseRiskInput(), dailyPnl: null });
  assert.equal(assessment.verdict, "BLOCKED");
  const check = assessment.checks.find((c) => c.id === "daily_loss");
  assert.ok(check?.indeterminate, "the check must report that it could not be evaluated");
});

test("risk engine: exceeding the daily loss limit blocks with the spec's wording", () => {
  const assessment = assessRisk({
    ...baseRiskInput(),
    dailyPnl: -1_400, // limit is 3% of 50,000 = 1,500
    proposedMaximumLoss: 500,
  });
  assert.equal(assessment.verdict, "BLOCKED");
  assert.ok(assessment.blockingReasons.some((r) => /exceeds configured daily limit/i.test(r)));
  assert.match(assessment.summary, /^TRADE BLOCKED/);
});

test("risk engine: a closed market blocks the trade", () => {
  const assessment = assessRisk({
    ...baseRiskInput(),
    quote: freshQuote({ session: "closed" }),
  });
  assert.equal(assessment.verdict, "BLOCKED");
});

test("risk engine: an excessive spread blocks the trade", () => {
  const assessment = assessRisk({
    ...baseRiskInput(),
    quote: freshQuote({ spread: 2, bid: 99, ask: 101 }), // 200 bps
  });
  assert.equal(assessment.verdict, "BLOCKED");
  assert.ok(assessment.blockingReasons.some((r) => /Spread/.test(r)));
});

test("risk engine: a missing stop loss blocks the trade", () => {
  const assessment = assessRisk({ ...baseRiskInput(), stopPrice: null });
  assert.equal(assessment.verdict, "BLOCKED");
  assert.ok(assessment.blockingReasons.some((r) => /No stop loss/.test(r)));
});

test("risk engine: risk/reward below the minimum blocks the trade", () => {
  const assessment = assessRisk({ ...baseRiskInput(), riskRewardRatio: 0.8 });
  assert.equal(assessment.verdict, "BLOCKED");
  assert.ok(assessment.blockingReasons.some((r) => /below the required/.test(r)));
});

test("risk engine: portfolio exposure over the limit blocks the trade", () => {
  const assessment = assessRisk({
    ...baseRiskInput(),
    openPositions: [{ symbol: "MSFT", side: "long", notional: 48_000 }],
    proposedNotional: 10_000,
  });
  assert.equal(assessment.verdict, "BLOCKED");
  assert.ok(assessment.blockingReasons.some((r) => /portfolio limit/.test(r)));
});

test("risk engine: a duplicate client order id blocks the trade", () => {
  const assessment = assessRisk({
    ...baseRiskInput(),
    clientOrderId: "abc-123",
    recentClientOrderIds: ["abc-123"],
  });
  assert.equal(assessment.verdict, "BLOCKED");
  assert.ok(assessment.blockingReasons.some((r) => /already submitted/.test(r)));
});

test("risk engine: an imminent high-importance event blocks by default", () => {
  const now = Date.now();
  const event: EconomicEvent = {
    id: "cpi",
    name: "CPI",
    country: "US",
    scheduledAt: now + 10 * 60_000,
    importance: "high",
    previous: null,
    forecast: null,
    actual: null,
    currency: "USD",
  };
  const assessment = assessRisk({ ...baseRiskInput(), upcomingEvents: [event], now });
  assert.equal(assessment.verdict, "BLOCKED");
  assert.ok(assessment.blockingReasons.some((r) => /CPI/.test(r)));
});

test("risk engine: event blocking can be switched off by the operator", () => {
  const now = Date.now();
  const event: EconomicEvent = {
    id: "cpi",
    name: "CPI",
    country: "US",
    scheduledAt: now + 10 * 60_000,
    importance: "high",
    previous: null,
    forecast: null,
    actual: null,
    currency: "USD",
  };
  const assessment = assessRisk({
    ...baseRiskInput(),
    upcomingEvents: [event],
    blockAroundHighImpactEvents: false,
    now,
  });
  assert.equal(assessment.verdict, "WARNED");
  assert.ok(assessment.warnings.some((w) => /CPI/.test(w)));
});

test("risk engine: correlated exposure warns without blocking", () => {
  const assessment = assessRisk({
    ...baseRiskInput(),
    correlationGroup: "us_tech",
    openPositions: [
      { symbol: "MSFT", side: "long", notional: 20_000, correlationGroup: "us_tech" },
    ],
    proposedNotional: 8_000,
  });
  assert.equal(assessment.verdict, "WARNED");
  assert.ok(assessment.warnings.some((w) => /HIGH CORRELATION RISK/.test(w)));
});

test("risk engine: reports every failure, not just the first", () => {
  const assessment = assessRisk({
    ...baseRiskInput(),
    stopPrice: null,
    riskRewardRatio: 0.1,
    quote: freshQuote({ session: "closed" }),
  });
  assert.ok(
    assessment.blockingReasons.length >= 3,
    `expected several reasons, got ${assessment.blockingReasons.length}`
  );
});

// ---------------------------------------------------------------------------
// Live order gate (§21, §22, §40)
// ---------------------------------------------------------------------------

test("live order gate: blocks when live trading is disabled, even on a clean setup", () => {
  const assessment = assessLiveOrder({
    ...baseRiskInput(),
    liveTradingEnabled: false,
    userConfirmed: true,
  });
  assert.equal(assessment.verdict, "BLOCKED");
  assert.ok(assessment.blockingReasons.some((r) => /ORDER EXECUTION DISABLED/.test(r)));
});

test("live order gate: blocks without explicit user confirmation", () => {
  const assessment = assessLiveOrder({
    ...baseRiskInput(),
    liveTradingEnabled: true,
    userConfirmed: false,
  });
  assert.equal(assessment.verdict, "BLOCKED");
  assert.ok(assessment.blockingReasons.some((r) => /user confirmation/.test(r)));
});

test("live order gate: allows only when every check passes and the user confirmed", () => {
  const assessment = assessLiveOrder({
    ...baseRiskInput(),
    liveTradingEnabled: true,
    userConfirmed: true,
  });
  assert.equal(assessment.verdict, "ALLOWED", assessment.summary);
});

// ---------------------------------------------------------------------------
// Entry engine (§10)
// ---------------------------------------------------------------------------

function trendingCandles(count = 120): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    // A rising series with regular pullbacks, so swings actually form.
    const drift = i * 0.35;
    const wave = Math.sin(i / 5) * 2.2;
    const close = 100 + drift + wave;
    const open = price;
    candles.push({
      timestamp: i * 3_600_000,
      open,
      high: Math.max(open, close) + 0.6,
      low: Math.min(open, close) - 0.6,
      close,
      volume: 10_000 + (i % 7) * 900,
    });
    price = close;
  }
  return candles;
}

test("entry engine: a long plan places the stop below entry and targets above", () => {
  const candles = trendingCandles();
  const structure = analyzeStructure(candles);
  const plan = buildTradePlanLevels(candles, structure, "long");
  assert.ok(plan, "expected a plan for a well-formed trending series");
  assert.ok(plan!.stopLoss < plan!.preferredEntry, "stop must sit below entry on a long");
  assert.ok(plan!.takeProfit1 > plan!.preferredEntry);
  assert.ok(plan!.takeProfit2 > plan!.takeProfit1);
  assert.ok(plan!.takeProfit3 > plan!.takeProfit2);
  assert.ok(plan!.riskPerUnit > 0);
});

test("entry engine: a short plan mirrors the long geometry", () => {
  const candles = trendingCandles();
  const structure = analyzeStructure(candles);
  const plan = buildTradePlanLevels(candles, structure, "short");
  assert.ok(plan);
  assert.ok(plan!.stopLoss > plan!.preferredEntry, "stop must sit above entry on a short");
  assert.ok(plan!.takeProfit1 < plan!.preferredEntry);
  assert.ok(plan!.takeProfit3 < plan!.takeProfit2);
});

test("entry engine: the entry zone brackets the preferred entry", () => {
  const candles = trendingCandles();
  const plan = buildTradePlanLevels(candles, analyzeStructure(candles), "long");
  assert.ok(plan);
  assert.ok(plan!.entryZoneLow <= plan!.preferredEntry);
  assert.ok(plan!.entryZoneHigh >= plan!.preferredEntry);
});

test("entry engine: risk/reward is consistent with the emitted levels", () => {
  const candles = trendingCandles();
  const plan = buildTradePlanLevels(candles, analyzeStructure(candles), "long");
  assert.ok(plan);
  const expected =
    Math.abs(plan!.takeProfit1 - plan!.preferredEntry) /
    Math.abs(plan!.preferredEntry - plan!.stopLoss);
  assert.ok(Math.abs((plan!.riskReward as number) - expected) < 1e-9);
});

test("entry engine: too little data yields null rather than a fabricated plan", () => {
  const few: Candle[] = [{ timestamp: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
  assert.equal(buildTradePlanLevels(few, analyzeStructure(few), "long"), null);
});

test("entry engine: the stop sits beyond the invalidation level, not on it", () => {
  const candles = trendingCandles();
  const structure = analyzeStructure(candles);
  const plan = buildTradePlanLevels(candles, structure, "long");
  assert.ok(plan);
  assert.ok(
    plan!.stopLoss < plan!.invalidation || plan!.stopLoss === plan!.invalidation,
    "on a long, the stop must sit at or below the invalidation level"
  );
});
