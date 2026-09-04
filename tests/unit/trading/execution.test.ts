/**
 * Backtesting and paper trading (master spec §18, §20, §41).
 *
 * The critical assertions here are the anti-fiction ones: a strategy cannot see
 * the future, an ambiguous bar resolves against the trade, costs are actually
 * deducted, and paper results are never presented as live.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runBacktest, type Strategy } from "@/lib/trading/backtest";
import { PaperTradingEngine } from "@/lib/trading/paperTrading";
import type { Candle, Quote } from "@/lib/trading/types";

const NO_COSTS = { commissionRate: 0, commissionFlat: 0, slippageRate: 0 };

function flatCandles(count: number, price = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: i * 86_400_000,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 1_000,
  }));
}

// ---------------------------------------------------------------------------
// Look-ahead prevention (§18) — the whole point of the engine
// ---------------------------------------------------------------------------

test("backtest: the strategy can never see a bar beyond the current index", () => {
  const candles = flatCandles(50);
  let maxIndexSeen = -1;
  let sawFuture = false;

  const strategy: Strategy = (context) => {
    if (context.candles.length !== context.index + 1) sawFuture = true;
    const lastVisible = context.candles[context.candles.length - 1];
    if (lastVisible.timestamp !== candles[context.index].timestamp) sawFuture = true;
    maxIndexSeen = Math.max(maxIndexSeen, context.candles.length - 1);
    return { action: "none" };
  };

  runBacktest({
    candles,
    timeframe: "1D",
    strategy,
    initialCapital: 10_000,
    riskPerTrade: 0.01,
    costs: NO_COSTS,
  });

  assert.equal(sawFuture, false, "the strategy was handed a bar it could not have known");
  assert.equal(maxIndexSeen, candles.length - 2, "the final bar is never a decision bar");
});

test("backtest: an entry decided on bar i fills at bar i+1's open, not bar i's close", () => {
  // Bar 10 closes at 100; bar 11 opens at 130. A fill at 100 would be look-ahead.
  const candles = flatCandles(30);
  candles[11] = { ...candles[11], open: 130, high: 131, low: 129, close: 130 };

  const strategy: Strategy = (context) =>
    context.index === 10 && !context.position
      ? { action: "enter", side: "long", stopPrice: 90 }
      : { action: "none" };

  const result = runBacktest({
    candles,
    timeframe: "1D",
    strategy,
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    costs: NO_COSTS,
  });

  assert.equal(result.trades.length, 1);
  assert.equal(
    result.trades[0].entryPrice,
    130,
    "entry must fill at the next bar's open, never at the signal bar's close"
  );
});

test("backtest: a bar touching both stop and target resolves as a STOP", () => {
  const candles = flatCandles(20);
  // Bar 11 spans both levels. The bar cannot say which came first.
  candles[11] = { ...candles[11], open: 100, high: 120, low: 80, close: 100 };

  const strategy: Strategy = (context) =>
    context.index === 10 && !context.position
      ? { action: "enter", side: "long", stopPrice: 90, takeProfitPrice: 110 }
      : { action: "none" };

  const result = runBacktest({
    candles,
    timeframe: "1D",
    strategy,
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    costs: NO_COSTS,
  });

  assert.equal(result.trades.length, 1);
  assert.equal(
    result.trades[0].exitReason,
    "stop",
    "an ambiguous bar must resolve against the trade, never in its favour"
  );
  assert.ok(result.trades[0].netPnl < 0);
});

test("backtest: an entry whose stop is on the wrong side of price is rejected", () => {
  const candles = flatCandles(20);
  const strategy: Strategy = (context) =>
    context.index === 10 ? { action: "enter", side: "long", stopPrice: 200 } : { action: "none" };

  const result = runBacktest({
    candles,
    timeframe: "1D",
    strategy,
    initialCapital: 10_000,
    riskPerTrade: 0.01,
  });

  assert.equal(result.trades.length, 0);
  assert.ok(result.warnings.some((w) => /wrong side of price/.test(w)));
});

test("backtest: costs and slippage reduce net profit below gross", () => {
  const candles = flatCandles(30);
  // Entry fills at bar 11's open (100); the move comes afterwards.
  for (let i = 12; i < 30; i++) {
    candles[i] = { ...candles[i], open: 110, high: 111, low: 109, close: 110 };
  }
  const strategy: Strategy = (context) =>
    context.index === 10 && !context.position
      ? { action: "enter", side: "long", stopPrice: 95 }
      : { action: "none" };

  const withCosts = runBacktest({
    candles,
    timeframe: "1D",
    strategy,
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    costs: { commissionRate: 0.001, commissionFlat: 1, slippageRate: 0.001 },
    spreadFraction: 0.0005,
  });

  assert.equal(withCosts.trades.length, 1);
  const trade = withCosts.trades[0];
  assert.ok(trade.fees > 0, "fees must be charged");
  assert.ok(trade.netPnl < trade.grossPnl, "net must be below gross once fees apply");
});

test("backtest: a flat market with a stop below produces a losing or flat result, never profit", () => {
  const candles = flatCandles(40);
  const strategy: Strategy = (context) =>
    context.index === 5 && !context.position
      ? { action: "enter", side: "long", stopPrice: 95 }
      : { action: "none" };

  const result = runBacktest({
    candles,
    timeframe: "1D",
    strategy,
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    costs: { commissionRate: 0.001, commissionFlat: 0, slippageRate: 0.001 },
  });

  assert.ok(
    result.metrics.netProfit <= 0,
    `a flat market must not produce profit, got ${result.metrics.netProfit}`
  );
});

test("backtest: an open position is closed at the final bar and reported", () => {
  const candles = flatCandles(20);
  const strategy: Strategy = (context) =>
    context.index === 5 && !context.position
      ? { action: "enter", side: "long", stopPrice: 95 }
      : { action: "none" };

  const result = runBacktest({
    candles,
    timeframe: "1D",
    strategy,
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    costs: NO_COSTS,
  });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, "end_of_data");
});

test("backtest: too little data produces a warning rather than a phantom result", () => {
  const result = runBacktest({
    candles: flatCandles(1),
    timeframe: "1D",
    strategy: () => ({ action: "none" }),
    initialCapital: 10_000,
    riskPerTrade: 0.01,
  });
  assert.equal(result.trades.length, 0);
  assert.ok(result.warnings.length > 0);
});

test("backtest: profit factor is null (not Infinity) when nothing was lost", () => {
  const candles = flatCandles(30);
  // Bar 11 must still open at 100 — that is where the entry fills. The rally
  // starts at bar 12, so the trade actually has a gain to measure.
  for (let i = 12; i < 30; i++) {
    candles[i] = { ...candles[i], open: 130, high: 131, low: 129, close: 130 };
  }
  const strategy: Strategy = (context) =>
    context.index === 10 && !context.position
      ? { action: "enter", side: "long", stopPrice: 95 }
      : { action: "none" };

  const result = runBacktest({
    candles,
    timeframe: "1D",
    strategy,
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    costs: NO_COSTS,
  });
  assert.ok(result.metrics.netProfit > 0);
  assert.equal(
    result.metrics.profitFactor,
    null,
    "no losing trades means the profit factor is unmeasurable, not infinite"
  );
});

test("backtest: max drawdown is measured from the running equity peak", () => {
  const candles = flatCandles(40);
  for (let i = 11; i < 20; i++) {
    candles[i] = { ...candles[i], open: 120, high: 121, low: 119, close: 120 };
  }
  for (let i = 20; i < 40; i++) {
    candles[i] = { ...candles[i], open: 105, high: 106, low: 104, close: 105 };
  }
  const strategy: Strategy = (context) =>
    context.index === 10 && !context.position
      ? { action: "enter", side: "long", stopPrice: 90 }
      : { action: "none" };

  const result = runBacktest({
    candles,
    timeframe: "1D",
    strategy,
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    costs: NO_COSTS,
  });
  assert.ok(result.metrics.maxDrawdown > 0, "a give-back from the peak must register");
});

test("backtest: R-multiple is reported relative to the risk taken at entry", () => {
  const candles = flatCandles(30);
  for (let i = 11; i < 30; i++) {
    candles[i] = { ...candles[i], open: 100, high: 121, low: 99, close: 120 };
  }
  const strategy: Strategy = (context) =>
    context.index === 10 && !context.position
      ? { action: "enter", side: "long", stopPrice: 90, takeProfitPrice: 120 }
      : { action: "none" };

  const result = runBacktest({
    candles,
    timeframe: "1D",
    strategy,
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    costs: NO_COSTS,
  });
  assert.equal(result.trades.length, 1);
  const r = result.trades[0].rMultiple;
  assert.ok(r !== null && r > 1.5, `expected roughly +2R, got ${r}`);
});

// ---------------------------------------------------------------------------
// Paper trading (§20)
// ---------------------------------------------------------------------------

const clock = 1_000_000;
const quoteFor = (symbol: string, bid: number, ask: number, last: number): Quote => ({
  instrument: { symbol, assetClass: "stock" },
  last,
  bid,
  ask,
  spread: ask - bid,
  volume: 1_000,
  tradeCount: 10,
  vwap: last,
  changePercent: 0,
  session: "regular",
  provenance: { source: "test", timestamp: clock, status: "LIVE" },
});

const engine = () =>
  new PaperTradingEngine({
    initialCapital: 100_000,
    costs: NO_COSTS,
    now: () => clock,
    idFactory: (() => {
      let n = 0;
      return () => `o${++n}`;
    })(),
  });

test("paper: every artefact is labelled PAPER, never live", () => {
  const paper = engine();
  const order = paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 10 },
    quoteFor("AAPL", 99.9, 100.1, 100)
  );
  assert.equal(order.mode, "PAPER");
  const state = paper.getState();
  assert.equal(state.mode, "PAPER");
  assert.equal(state.positions[0].mode, "PAPER");
});

test("paper: a market buy crosses the spread and fills at the ask", () => {
  const paper = engine();
  const order = paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 10 },
    quoteFor("AAPL", 99.9, 100.1, 100)
  );
  assert.equal(order.status, "filled");
  assert.equal(order.averageFillPrice, 100.1, "a buy must pay the ask, not the mid");
});

test("paper: a market sell fills at the bid", () => {
  const paper = engine();
  paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 10 },
    quoteFor("AAPL", 99.9, 100.1, 100)
  );
  const sell = paper.submitOrder(
    { symbol: "AAPL", side: "sell", type: "market", quantity: 10 },
    quoteFor("AAPL", 99.9, 100.1, 100)
  );
  assert.equal(sell.averageFillPrice, 99.9);
});

test("paper: a market order with no quote is rejected, never filled at a guess", () => {
  const paper = engine();
  const order = paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 10 },
    null
  );
  assert.equal(order.status, "rejected");
  assert.match(order.rejectReason ?? "", /DATA SOURCE UNAVAILABLE/);
});

test("paper: realised P&L is booked only on the closed portion", () => {
  const paper = engine();
  paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 100 },
    quoteFor("AAPL", 100, 100, 100)
  );
  paper.submitOrder(
    { symbol: "AAPL", side: "sell", type: "market", quantity: 40 },
    quoteFor("AAPL", 110, 110, 110)
  );
  const state = paper.getState();
  // 40 shares × 10 profit = 400 realised; 60 still open.
  assert.equal(state.realizedPnl, 400);
  assert.equal(state.positions[0].quantity, 60);
  assert.equal(state.positions[0].averageEntryPrice, 100);
});

test("paper: averaging into a position updates the average entry price", () => {
  const paper = engine();
  paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 100 },
    quoteFor("AAPL", 100, 100, 100)
  );
  paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 100 },
    quoteFor("AAPL", 120, 120, 120)
  );
  assert.equal(paper.getState().positions[0].averageEntryPrice, 110);
});

test("paper: selling through flat reverses the position at the new price", () => {
  const paper = engine();
  paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 100 },
    quoteFor("AAPL", 100, 100, 100)
  );
  paper.submitOrder(
    { symbol: "AAPL", side: "sell", type: "market", quantity: 150 },
    quoteFor("AAPL", 110, 110, 110)
  );
  const state = paper.getState();
  assert.equal(state.realizedPnl, 1_000, "only the 100 closed shares realise P&L");
  assert.equal(state.positions[0].side, "short");
  assert.equal(state.positions[0].quantity, 50);
  assert.equal(state.positions[0].averageEntryPrice, 110);
});

test("paper: a closing trade removes the position entirely", () => {
  const paper = engine();
  paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 100 },
    quoteFor("AAPL", 100, 100, 100)
  );
  paper.submitOrder(
    { symbol: "AAPL", side: "sell", type: "market", quantity: 100 },
    quoteFor("AAPL", 105, 105, 105)
  );
  const state = paper.getState();
  assert.equal(state.positions.length, 0);
  assert.equal(state.realizedPnl, 500);
  assert.equal(state.equity, 100_500);
});

test("paper: a resting buy limit fills only once price trades down to it", () => {
  const paper = engine();
  const order = paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "limit", quantity: 10, limitPrice: 95 },
    quoteFor("AAPL", 99.9, 100.1, 100)
  );
  assert.equal(order.status, "pending", "the limit is below the market — it must rest");

  paper.processQuote(quoteFor("AAPL", 94.9, 95.1, 94));
  assert.equal(paper.getState().orders[0].status, "filled");
  assert.equal(paper.getState().orders[0].averageFillPrice, 95);
});

test("paper: a buy stop triggers above the market and pays the spread", () => {
  const paper = engine();
  const order = paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "stop", quantity: 10, stopPrice: 110 },
    quoteFor("AAPL", 99.9, 100.1, 100)
  );
  assert.equal(order.status, "pending");

  paper.processQuote(quoteFor("AAPL", 110.9, 111.1, 111));
  const filled = paper.getState().orders[0];
  assert.equal(filled.status, "filled");
  assert.equal(filled.averageFillPrice, 111.1, "a triggered stop becomes a market order");
});

test("paper: unrealised P&L marks to the latest quote", () => {
  const paper = engine();
  paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 100 },
    quoteFor("AAPL", 100, 100, 100)
  );
  paper.processQuote(quoteFor("AAPL", 109.9, 110.1, 110));
  const state = paper.getState();
  assert.equal(state.unrealizedPnl, 1_000);
  assert.equal(state.equity, 101_000);
});

test("paper: fees reduce cash and are tracked", () => {
  const paper = new PaperTradingEngine({
    initialCapital: 100_000,
    costs: { commissionRate: 0.001, commissionFlat: 0, slippageRate: 0 },
    now: () => clock,
  });
  paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 100 },
    quoteFor("AAPL", 100, 100, 100)
  );
  const state = paper.getState();
  assert.equal(state.totalFees, 10); // 10,000 notional × 0.001
  assert.equal(state.cash, 99_990);
});

test("paper: an invalid order is rejected rather than silently dropped", () => {
  const paper = engine();
  const zero = paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 0 },
    quoteFor("AAPL", 100, 100, 100)
  );
  assert.equal(zero.status, "rejected");

  const noLimit = paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "limit", quantity: 5 },
    quoteFor("AAPL", 100, 100, 100)
  );
  assert.equal(noLimit.status, "rejected");
  assert.match(noLimit.rejectReason ?? "", /limit price/);
});

test("paper: max drawdown tracks the equity peak", () => {
  const paper = engine();
  paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "market", quantity: 100 },
    quoteFor("AAPL", 100, 100, 100)
  );
  paper.processQuote(quoteFor("AAPL", 120, 120, 120));
  paper.processQuote(quoteFor("AAPL", 90, 90, 90));
  const state = paper.getState();
  assert.ok(state.peakEquity >= 102_000);
  assert.ok(state.maxDrawdown >= 3_000, `drawdown ${state.maxDrawdown}`);
});

test("paper: a cancelled order never fills", () => {
  const paper = engine();
  const order = paper.submitOrder(
    { symbol: "AAPL", side: "buy", type: "limit", quantity: 10, limitPrice: 95 },
    quoteFor("AAPL", 99.9, 100.1, 100)
  );
  paper.cancelOrder(order.id);
  paper.processQuote(quoteFor("AAPL", 94.9, 95.1, 94));
  assert.equal(paper.getState().orders[0].status, "cancelled");
});
