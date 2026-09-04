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
import { runBacktest } from "@/lib/trading/backtest";
import { normalizeCandles } from "@/lib/trading/freshness";
import {
  STRATEGY_PRESETS,
  compileStrategy,
  validateStrategyDefinition,
  type StrategyDefinition,
} from "@/lib/trading/strategyLab";
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
  // Either a shipped preset by id, or a full rule tree. Never code.
  preset: z.enum(Object.keys(STRATEGY_PRESETS) as [string, ...string[]]).optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  initialCapital: z.number().positive().max(1_000_000_000),
  riskPerTrade: z.number().min(0.0001).max(0.1),
  commissionRate: z.number().min(0).max(0.1).default(0.0005),
  slippageRate: z.number().min(0).max(0.1).default(0.0005),
  persist: z.boolean().default(false),
});

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

  // Resolve the strategy: a preset id, or an inline rule tree that is validated
  // before compiling so a broken definition fails loudly here rather than
  // silently producing a strategy that never triggers.
  const definition: StrategyDefinition | null = body.definition
    ? (body.definition as unknown as StrategyDefinition)
    : body.preset
      ? STRATEGY_PRESETS[body.preset]
      : null;

  if (!definition) {
    return NextResponse.json(
      { error: "Provide either a preset id or a strategy definition." },
      { status: 400 }
    );
  }
  const issues = validateStrategyDefinition(definition);
  if (issues.length > 0) {
    return NextResponse.json({ error: "Invalid strategy definition", issues }, { status: 400 });
  }

  const result = runBacktest({
    candles,
    timeframe: body.timeframe,
    strategy: compileStrategy(definition),
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
