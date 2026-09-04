/**
 * Backtesting engine (master spec §18, §19).
 *
 * The design constraint that matters more than any metric: NO LOOK-AHEAD.
 *
 * How that is enforced structurally rather than by convention:
 *  1. A strategy is called with a `BarContext` that exposes only `candles`
 *     0..i. There is no reference to the full series in scope, so a strategy
 *     physically cannot read a future bar.
 *  2. Decisions taken on bar i execute at bar i+1's OPEN. Filling at bar i's
 *     close means acting on a price that was not knowable until the bar ended.
 *  3. Intrabar stop/target fills use the bar's high/low, and when a bar touches
 *     BOTH the stop and the target the STOP is assumed to fill first. The bar
 *     does not say which came first, and assuming the favourable one is the
 *     classic way backtests manufacture profit that does not exist.
 */

import type { Candle, Side, Timeframe } from "./types";
import { roundDownToIncrement, type CostModel, DEFAULT_COST_MODEL } from "./positionSizing";

export interface BarContext {
  /** Bars 0..index inclusive. Never contains a future bar. */
  readonly candles: readonly Candle[];
  /** Index of the bar just closed. */
  readonly index: number;
  readonly position: BacktestPosition | null;
  readonly equity: number;
  readonly cash: number;
}

export type StrategyDecision =
  | { action: "none" }
  | {
      action: "enter";
      side: Side;
      /** Absolute stop price. Required — a backtest without stops is fiction. */
      stopPrice: number;
      takeProfitPrice?: number;
      /** Fraction of equity to risk; falls back to the run's riskPerTrade. */
      riskFraction?: number;
      reason?: string;
    }
  | { action: "exit"; reason?: string };

export type Strategy = (context: BarContext) => StrategyDecision;

export interface BacktestPosition {
  side: Side;
  quantity: number;
  entryPrice: number;
  entryIndex: number;
  entryTimestamp: number;
  stopPrice: number;
  takeProfitPrice: number | null;
  reason: string;
}

export type ExitReason = "stop" | "target" | "signal" | "end_of_data";

export interface BacktestTrade {
  side: Side;
  quantity: number;
  entryTimestamp: number;
  entryPrice: number;
  exitTimestamp: number;
  exitPrice: number;
  exitReason: ExitReason;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  /** Net P&L expressed in units of initial risk (R-multiple). */
  rMultiple: number | null;
  barsHeld: number;
  entryReason: string;
}

export interface BacktestConfig {
  candles: readonly Candle[];
  timeframe: Timeframe;
  strategy: Strategy;
  initialCapital: number;
  /** Fraction of equity risked per trade. */
  riskPerTrade: number;
  costs?: CostModel;
  /** Half the bid/ask, applied against the fill. */
  spreadFraction?: number;
  quantityIncrement?: number;
  contractSize?: number;
  /** Bars required before the strategy is first consulted (indicator warm-up). */
  warmupBars?: number;
}

export interface BacktestMetrics {
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  returnPercent: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  averageWin: number;
  averageLoss: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  totalTrades: number;
  averageTrade: number;
  winningStreak: number;
  losingStreak: number;
  totalFees: number;
  totalSlippage: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  equityCurve: { timestamp: number; equity: number }[];
  metrics: BacktestMetrics;
  finalEquity: number;
  warnings: string[];
}

const BARS_PER_YEAR: Record<Timeframe, number> = {
  "1m": 252 * 390,
  "3m": 252 * 130,
  "5m": 252 * 78,
  "15m": 252 * 26,
  "30m": 252 * 13,
  "1H": 252 * 7,
  "2H": 252 * 3.5,
  "4H": 252 * 1.75,
  "1D": 252,
  "1W": 52,
};

export function runBacktest(config: BacktestConfig): BacktestResult {
  const {
    candles,
    timeframe,
    strategy,
    initialCapital,
    riskPerTrade,
    costs = DEFAULT_COST_MODEL,
    spreadFraction = 0,
    quantityIncrement = 1,
    contractSize = 1,
    warmupBars = 0,
  } = config;

  const warnings: string[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: { timestamp: number; equity: number }[] = [];

  if (initialCapital <= 0) {
    warnings.push("Initial capital must be positive; the backtest did not run.");
    return emptyResult(warnings, initialCapital);
  }
  if (candles.length < warmupBars + 2) {
    warnings.push(
      `Only ${candles.length} bars supplied; at least ${warmupBars + 2} are needed to trade.`
    );
    return emptyResult(warnings, initialCapital);
  }

  let cash = initialCapital;
  let equity = initialCapital;
  let position: BacktestPosition | null = null;
  let pendingEntry: Extract<StrategyDecision, { action: "enter" }> | null = null;
  let pendingExit = false;
  let riskAtEntry = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // --- 1. Execute what was decided on the PREVIOUS bar, at this bar's open.
    if (pendingExit && position) {
      const fill = applySlippage(
        candle.open,
        position.side === "long" ? "sell" : "buy",
        spreadFraction,
        costs
      );
      trades.push(
        closePosition(position, fill, candle, i, "signal", costs, contractSize, riskAtEntry)
      );
      cash += trades[trades.length - 1].netPnl;
      position = null;
      pendingExit = false;
    }

    if (pendingEntry && !position) {
      const entryFill = applySlippage(
        candle.open,
        pendingEntry.side === "long" ? "buy" : "sell",
        spreadFraction,
        costs
      );
      const stopDistance = Math.abs(entryFill - pendingEntry.stopPrice);
      if (stopDistance > 0) {
        const riskBudget = equity * (pendingEntry.riskFraction ?? riskPerTrade);
        const rawQuantity = riskBudget / (stopDistance * contractSize);
        const quantity = roundDownToIncrement(rawQuantity, quantityIncrement);
        if (quantity > 0) {
          position = {
            side: pendingEntry.side,
            quantity,
            entryPrice: entryFill,
            entryIndex: i,
            entryTimestamp: candle.timestamp,
            stopPrice: pendingEntry.stopPrice,
            takeProfitPrice: pendingEntry.takeProfitPrice ?? null,
            reason: pendingEntry.reason ?? "",
          };
          riskAtEntry = quantity * stopDistance * contractSize;
        }
      }
      pendingEntry = null;
    }

    // --- 2. Intrabar stop / target. Stop wins on an ambiguous bar (see header).
    if (position) {
      const hitStop =
        position.side === "long"
          ? candle.low <= position.stopPrice
          : candle.high >= position.stopPrice;
      const hitTarget =
        position.takeProfitPrice !== null &&
        (position.side === "long"
          ? candle.high >= position.takeProfitPrice
          : candle.low <= position.takeProfitPrice);

      if (hitStop) {
        const fill = applySlippage(
          position.stopPrice,
          position.side === "long" ? "sell" : "buy",
          spreadFraction,
          costs
        );
        trades.push(
          closePosition(position, fill, candle, i, "stop", costs, contractSize, riskAtEntry)
        );
        cash += trades[trades.length - 1].netPnl;
        position = null;
      } else if (hitTarget && position.takeProfitPrice !== null) {
        const fill = applySlippage(
          position.takeProfitPrice,
          position.side === "long" ? "sell" : "buy",
          spreadFraction,
          costs
        );
        trades.push(
          closePosition(position, fill, candle, i, "target", costs, contractSize, riskAtEntry)
        );
        cash += trades[trades.length - 1].netPnl;
        position = null;
      }
    }

    // --- 3. Mark to market.
    equity = cash + unrealizedPnl(position, candle.close, contractSize);
    equityCurve.push({ timestamp: candle.timestamp, equity });

    // --- 4. Consult the strategy with PAST-ONLY data; act on the next bar.
    if (i >= warmupBars && i < candles.length - 1) {
      const decision = strategy({
        // slice(0, i + 1) is the guarantee: no future bar is reachable.
        candles: candles.slice(0, i + 1),
        index: i,
        position,
        equity,
        cash,
      });

      if (decision.action === "enter" && !position) {
        if (!Number.isFinite(decision.stopPrice)) {
          warnings.push(`Bar ${i}: entry rejected — a finite stop price is required.`);
        } else if (
          (decision.side === "long" && decision.stopPrice >= candle.close) ||
          (decision.side === "short" && decision.stopPrice <= candle.close)
        ) {
          warnings.push(`Bar ${i}: entry rejected — the stop is on the wrong side of price.`);
        } else {
          pendingEntry = decision;
        }
      } else if (decision.action === "exit" && position) {
        pendingExit = true;
      }
    }
  }

  // Close anything still open at the final close.
  if (position) {
    const last = candles[candles.length - 1];
    const fill = applySlippage(
      last.close,
      position.side === "long" ? "sell" : "buy",
      spreadFraction,
      costs
    );
    trades.push(
      closePosition(
        position,
        fill,
        last,
        candles.length - 1,
        "end_of_data",
        costs,
        contractSize,
        riskAtEntry
      )
    );
    cash += trades[trades.length - 1].netPnl;
    equity = cash;
    equityCurve[equityCurve.length - 1] = { timestamp: last.timestamp, equity };
  }

  return {
    trades,
    equityCurve,
    metrics: computeMetrics(trades, equityCurve, initialCapital, timeframe),
    finalEquity: equity,
    warnings,
  };
}

function applySlippage(
  price: number,
  direction: "buy" | "sell",
  spreadFraction: number,
  costs: CostModel
): number {
  // Slippage and half-spread always work AGAINST the trade.
  const adverse = price * (costs.slippageRate + spreadFraction);
  return direction === "buy" ? price + adverse : price - adverse;
}

function unrealizedPnl(
  position: BacktestPosition | null,
  price: number,
  contractSize: number
): number {
  if (!position) return 0;
  const direction = position.side === "long" ? 1 : -1;
  return (price - position.entryPrice) * direction * position.quantity * contractSize;
}

function closePosition(
  position: BacktestPosition,
  exitPrice: number,
  candle: Candle,
  index: number,
  exitReason: ExitReason,
  costs: CostModel,
  contractSize: number,
  riskAtEntry: number
): BacktestTrade {
  const direction = position.side === "long" ? 1 : -1;
  const grossPnl = (exitPrice - position.entryPrice) * direction * position.quantity * contractSize;

  const notionalIn = position.entryPrice * position.quantity * contractSize;
  const notionalOut = exitPrice * position.quantity * contractSize;
  const fees = (notionalIn + notionalOut) * costs.commissionRate + costs.commissionFlat * 2;
  // Slippage is already embedded in the fill prices; reported for transparency.
  const slippage = (notionalIn + notionalOut) * costs.slippageRate;

  const netPnl = grossPnl - fees;

  return {
    side: position.side,
    quantity: position.quantity,
    entryTimestamp: position.entryTimestamp,
    entryPrice: position.entryPrice,
    exitTimestamp: candle.timestamp,
    exitPrice,
    exitReason,
    grossPnl,
    fees,
    slippage,
    netPnl,
    rMultiple: riskAtEntry > 0 ? netPnl / riskAtEntry : null,
    barsHeld: index - position.entryIndex,
    entryReason: position.reason,
  };
}

export function computeMetrics(
  trades: readonly BacktestTrade[],
  equityCurve: readonly { timestamp: number; equity: number }[],
  initialCapital: number,
  timeframe: Timeframe
): BacktestMetrics {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);

  const grossProfit = wins.reduce((sum, t) => sum + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.netPnl, 0));
  const netProfit = trades.reduce((sum, t) => sum + t.netPnl, 0);

  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const drawdown = peak - point.equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPercent = peak === 0 ? 0 : drawdown / peak;
    }
  }

  let winningStreak = 0;
  let losingStreak = 0;
  let currentWin = 0;
  let currentLoss = 0;
  for (const trade of trades) {
    if (trade.netPnl > 0) {
      currentWin++;
      currentLoss = 0;
      if (currentWin > winningStreak) winningStreak = currentWin;
    } else if (trade.netPnl < 0) {
      currentLoss++;
      currentWin = 0;
      if (currentLoss > losingStreak) losingStreak = currentLoss;
    }
  }

  const winRate = trades.length === 0 ? 0 : wins.length / trades.length;
  const averageWin = wins.length === 0 ? 0 : grossProfit / wins.length;
  const averageLoss = losses.length === 0 ? 0 : grossLoss / losses.length;

  const { sharpe, sortino } = riskAdjustedReturns(equityCurve, timeframe);

  return {
    netProfit,
    grossProfit,
    grossLoss,
    returnPercent: initialCapital === 0 ? 0 : netProfit / initialCapital,
    winRate,
    // Undefined rather than Infinity when nothing was lost — a strategy with no
    // losing trades has no measurable profit factor, and Infinity reads as a
    // spectacular result rather than as "not enough data".
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    expectancy: winRate * averageWin - (1 - winRate) * averageLoss,
    averageWin,
    averageLoss,
    maxDrawdown,
    maxDrawdownPercent,
    sharpeRatio: sharpe,
    sortinoRatio: sortino,
    totalTrades: trades.length,
    averageTrade: trades.length === 0 ? 0 : netProfit / trades.length,
    winningStreak,
    losingStreak,
    totalFees: trades.reduce((sum, t) => sum + t.fees, 0),
    totalSlippage: trades.reduce((sum, t) => sum + t.slippage, 0),
  };
}

/**
 * Sharpe and Sortino from per-bar equity returns, annualised by the timeframe.
 * Sortino divides by DOWNSIDE deviation only, which is the whole point of the
 * ratio — using total deviation just reproduces Sharpe.
 */
function riskAdjustedReturns(
  equityCurve: readonly { timestamp: number; equity: number }[],
  timeframe: Timeframe
): { sharpe: number | null; sortino: number | null } {
  if (equityCurve.length < 3) return { sharpe: null, sortino: null };

  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const previous = equityCurve[i - 1].equity;
    if (previous <= 0) continue;
    returns.push((equityCurve[i].equity - previous) / previous);
  }
  if (returns.length < 2) return { sharpe: null, sortino: null };

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((acc, r) => acc + (r - mean) * (r - mean), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  const downside = returns.filter((r) => r < 0);
  const downsideDeviation =
    downside.length === 0
      ? 0
      : Math.sqrt(downside.reduce((acc, r) => acc + r * r, 0) / downside.length);

  const annualisation = Math.sqrt(BARS_PER_YEAR[timeframe]);

  return {
    sharpe: stdDev === 0 ? null : (mean / stdDev) * annualisation,
    sortino: downsideDeviation === 0 ? null : (mean / downsideDeviation) * annualisation,
  };
}

function emptyResult(warnings: string[], initialCapital: number): BacktestResult {
  return {
    trades: [],
    equityCurve: [],
    metrics: computeMetrics([], [], initialCapital, "1D"),
    finalEquity: initialCapital,
    warnings,
  };
}
