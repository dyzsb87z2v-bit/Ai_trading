/**
 * Evaluate a symbol's alert rules against a fresh analysis (§26).
 *
 * State updates are persisted before events are returned, because the engine is
 * edge-triggered: forgetting to write `lastValue` back would make every level
 * rule fire on every evaluation.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import {
  applyAlertStateUpdates,
  getRiskSettings,
  listAlerts,
  recordAlertEvents,
} from "@/lib/db/trading";
import { evaluateAlerts, type AlertRule } from "@/lib/trading/alerts";
import { analyzeInstrument } from "@/lib/trading/analysisService";
import { computeIndicatorSet } from "@/lib/trading/indicators";
import { normalizeCandles } from "@/lib/trading/freshness";
import { ALL_TIMEFRAMES, type Timeframe } from "@/lib/trading/types";

const candleSchema = z.object({
  timestamp: z.number().int().finite(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().min(0).finite(),
});

const provenanceSchema = z.object({
  source: z.string().min(1).max(64),
  timestamp: z.number().int().finite(),
  status: z.enum(["LIVE", "DELAYED", "HISTORICAL", "PAPER", "SIMULATED", "STALE", "UNAVAILABLE"]),
});

const bodySchema = z.object({
  symbol: z.string().min(1).max(64),
  assetClass: z.enum(["stock", "etf", "index", "forex", "crypto"]),
  timeframe: z.enum(ALL_TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]]),
  candles: z.array(candleSchema).min(1).max(20_000),
  provenance: provenanceSchema,
  position: z
    .object({
      side: z.enum(["long", "short"]),
      stopPrice: z.number().finite().nullable(),
      takeProfitPrice: z.number().finite().nullable(),
    })
    .nullable()
    .optional(),
});

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid evaluation request" }, { status: 400 });
  }
  const body = parsed.data;
  const stored = getRiskSettings();
  const instrument = { symbol: body.symbol, assetClass: body.assetClass };
  const candles = normalizeCandles(body.candles);

  const analysis = analyzeInstrument({
    series: { instrument, timeframe: body.timeframe, candles, provenance: body.provenance },
    quote: null,
    settings: {
      accountEquity: stored.accountEquity,
      riskPerTradeFraction: stored.riskPerTradeFraction,
      maxDailyLossFraction: stored.maxDailyLossFraction,
      maxPositionFraction: stored.maxPositionFraction,
      maxPortfolioExposureFraction: stored.maxPortfolioExposureFraction,
      minRiskRewardRatio: stored.minRiskRewardRatio,
      maxLeverage: stored.maxLeverage,
    },
    dailyPnl: null,
    openPositions: [],
  });

  const rules: AlertRule[] = listAlerts(body.symbol).map((row) => ({
    id: row.id,
    symbol: row.symbol,
    kind: row.kind as AlertRule["kind"],
    value: row.value ?? undefined,
    previousState: row.previousState ?? undefined,
    enabled: row.enabled,
    channels: row.channels as AlertRule["channels"],
    cooldownMs: row.cooldownMs ?? undefined,
    lastTriggeredAt: row.lastTriggeredAt,
    lastValue: row.lastValue,
    note: row.note ?? undefined,
  }));

  const evaluation = evaluateAlerts(rules, {
    analysis,
    indicators: candles.length > 0 ? computeIndicatorSet(candles) : null,
    position: body.position ?? null,
  });

  // Persist BEFORE returning: the engine is edge-triggered and stateless.
  applyAlertStateUpdates(evaluation.stateUpdates);
  recordAlertEvents(
    evaluation.fired.map((event) => ({
      ruleId: event.ruleId,
      symbol: event.symbol,
      kind: event.kind,
      message: event.message,
      observed: event.observed,
      threshold: event.threshold,
      severity: event.severity,
      triggeredAt: event.triggeredAt,
    }))
  );

  return NextResponse.json({
    fired: evaluation.fired,
    skipped: evaluation.skipped,
    evaluated: rules.filter((r) => r.enabled).length,
  });
}
