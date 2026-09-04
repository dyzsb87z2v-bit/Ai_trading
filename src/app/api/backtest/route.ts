/**
 * Backtesting over a supplied series.
 *
 * Strategies are chosen from a fixed, named set rather than accepted as code:
 * an endpoint that eval'd a user-supplied strategy string would be remote code
 * execution. Adding a strategy means adding it here.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { recordBacktest } from "@/lib/db/trading";
import { runBacktest, type Strategy } from "@/lib/trading/backtest";
import { normalizeCandles } from "@/lib/trading/freshness";
import { computeIndicatorSet, latest } from "@/lib/trading/indicators";
import { atr } from "@/lib/trading/indicators/volatility";
import { ALL_TIMEFRAMES, type Timeframe } from "@/lib/trading/types";

const candleSchema = z.object({
  timestamp: z.number().int().finite(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().min(0).finite(),
});

const bodySchema = z.object({
  symbol: z.string().min(1).max(64),
  timeframe: z.enum(ALL_TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]]),
  candles: z.array(candleSchema).min(60).max(20_000),
  strategy: z.enum(["ema-cross", "rsi-reversal", "breakout"]),
  initialCapital: z.number().positive().max(1_000_000_000),
  riskPerTrade: z.number().min(0.0001).max(0.1),
  commissionRate: z.number().min(0).max(0.1).default(0.0005),
  slippageRate: z.number().min(0).max(0.1).default(0.0005),
  persist: z.boolean().default(false),
});

/**
 * Built-in strategies.
 *
 * Each reads only `context.candles` (bars 0..i), so none can see the future.
 * Stops are ATR-based rather than a fixed percentage, so they scale with the
 * instrument's own volatility.
 */
function buildStrategy(name: "ema-cross" | "rsi-reversal" | "breakout"): Strategy {
  return (context) => {
    const candles = context.candles;
    if (candles.length < 60) return { action: "none" };

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const price = closes[closes.length - 1];
    const atrValue = latest(atr(highs, lows, closes, 14));
    if (atrValue === null || atrValue <= 0) return { action: "none" };

    const indicators = computeIndicatorSet(candles);
    const stop = price - atrValue * 2;
    const target = price + atrValue * 4;

    if (name === "ema-cross") {
      const fast = latest(indicators.ema20);
      const slow = latest(indicators.ema50);
      if (fast === null || slow === null) return { action: "none" };
      if (!context.position && fast > slow) {
        return {
          action: "enter",
          side: "long",
          stopPrice: stop,
          takeProfitPrice: target,
          reason: `EMA20 ${fast.toFixed(2)} above EMA50 ${slow.toFixed(2)}`,
        };
      }
      if (context.position && fast < slow) return { action: "exit", reason: "EMA cross down" };
      return { action: "none" };
    }

    if (name === "rsi-reversal") {
      const rsiValue = latest(indicators.rsi);
      if (rsiValue === null) return { action: "none" };
      if (!context.position && rsiValue < 30) {
        return {
          action: "enter",
          side: "long",
          stopPrice: stop,
          takeProfitPrice: target,
          reason: `RSI ${rsiValue.toFixed(1)} oversold`,
        };
      }
      if (context.position && rsiValue > 60) return { action: "exit", reason: "RSI recovered" };
      return { action: "none" };
    }

    // breakout: close above the highest high of the prior 20 bars (excluding
    // the current one, so the bar cannot break out of its own range).
    const window = highs.slice(-21, -1);
    const highest = Math.max(...window);
    if (!context.position && price > highest) {
      return {
        action: "enter",
        side: "long",
        stopPrice: stop,
        takeProfitPrice: target,
        reason: `Close ${price.toFixed(2)} broke the 20-bar high ${highest.toFixed(2)}`,
      };
    }
    return { action: "none" };
  };
}

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid backtest request", details: parsed.error.issues.slice(0, 5) },
      { status: 400 }
    );
  }

  const body = parsed.data;
  const candles = normalizeCandles(body.candles);

  const result = runBacktest({
    candles,
    timeframe: body.timeframe,
    strategy: buildStrategy(body.strategy),
    initialCapital: body.initialCapital,
    riskPerTrade: body.riskPerTrade,
    costs: {
      commissionRate: body.commissionRate,
      commissionFlat: 0,
      slippageRate: body.slippageRate,
    },
    // Indicators need warm-up before the strategy may be consulted.
    warmupBars: 60,
  });

  let id: string | null = null;
  if (body.persist && candles.length > 0) {
    id = recordBacktest({
      symbol: body.symbol,
      timeframe: body.timeframe,
      fromTs: candles[0].timestamp,
      toTs: candles[candles.length - 1].timestamp,
      initialCapital: body.initialCapital,
      riskPerTrade: body.riskPerTrade,
      commissionRate: body.commissionRate,
      slippageRate: body.slippageRate,
      metrics: result.metrics,
      trades: result.trades,
      warnings: result.warnings,
    });
  }

  return NextResponse.json({
    id,
    metrics: result.metrics,
    trades: result.trades.slice(0, 500),
    equityCurve: result.equityCurve,
    warnings: result.warnings,
    finalEquity: result.finalEquity,
  });
}
