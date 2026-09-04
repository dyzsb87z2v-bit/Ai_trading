/**
 * Full analysis pipeline for one instrument.
 *
 * Candles arrive in the request rather than being fetched here, so the endpoint
 * works with any provider (or the simulated generator) without knowing which.
 * The risk engine runs last inside `analyzeInstrument` and produces the verdict
 * itself — a caller cannot assemble a TRADEABLE result.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { getRiskSettings } from "@/lib/db/trading";
import { analyzeInstrument } from "@/lib/trading/analysisService";
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

const timeframeSchema = z.enum(ALL_TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]]);

const dataStatusSchema = z.enum([
  "LIVE",
  "DELAYED",
  "HISTORICAL",
  "PAPER",
  "SIMULATED",
  "STALE",
  "UNAVAILABLE",
]);

const provenanceSchema = z.object({
  source: z.string().min(1).max(64),
  timestamp: z.number().int().finite(),
  status: dataStatusSchema,
});

const bodySchema = z.object({
  instrument: z.object({
    symbol: z.string().min(1).max(64),
    assetClass: z.enum(["stock", "etf", "index", "forex", "crypto"]),
    exchange: z.string().max(32).optional(),
    currency: z.string().max(8).optional(),
    contractSize: z.number().positive().max(1_000_000).optional(),
  }),
  timeframe: timeframeSchema,
  candles: z.array(candleSchema).min(1).max(20_000),
  provenance: provenanceSchema,
  additionalSeries: z
    .array(
      z.object({ timeframe: timeframeSchema, candles: z.array(candleSchema).min(1).max(20_000) })
    )
    .max(6)
    .optional(),
  quote: z
    .object({
      last: z.number().finite().nullable(),
      bid: z.number().finite().nullable(),
      ask: z.number().finite().nullable(),
      volume: z.number().finite().nullable(),
      vwap: z.number().finite().nullable(),
      changePercent: z.number().finite().nullable(),
      session: z.enum(["pre", "regular", "post", "closed", "unknown"]),
      provenance: provenanceSchema,
    })
    .nullable()
    .optional(),
  side: z.enum(["long", "short"]).optional(),
  dailyPnl: z.number().finite().nullable().optional(),
  openPositions: z
    .array(
      z.object({
        symbol: z.string().min(1).max(64),
        side: z.enum(["long", "short"]),
        notional: z.number().finite(),
        correlationGroup: z.string().max(64).optional(),
      })
    )
    .max(500)
    .optional(),
  correlationGroup: z.string().max(64).optional(),
});

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid analysis request", details: parsed.error.issues.slice(0, 5) },
      { status: 400 }
    );
  }

  const body = parsed.data;
  const stored = getRiskSettings();
  const instrument = body.instrument;

  // Normalise first: a provider series can arrive out of order or with
  // duplicate bars, and indicator maths on such a series is meaningless.
  const candles = normalizeCandles(body.candles);

  const result = analyzeInstrument({
    series: { instrument, timeframe: body.timeframe, candles, provenance: body.provenance },
    additionalSeries: body.additionalSeries?.map((entry) => ({
      timeframe: entry.timeframe,
      candles: normalizeCandles(entry.candles),
    })),
    quote: body.quote
      ? {
          instrument,
          last: body.quote.last,
          bid: body.quote.bid,
          ask: body.quote.ask,
          spread:
            body.quote.bid !== null && body.quote.ask !== null
              ? body.quote.ask - body.quote.bid
              : null,
          volume: body.quote.volume,
          tradeCount: null,
          vwap: body.quote.vwap,
          changePercent: body.quote.changePercent,
          session: body.quote.session,
          provenance: body.quote.provenance,
        }
      : null,
    settings: {
      accountEquity: stored.accountEquity,
      riskPerTradeFraction: stored.riskPerTradeFraction,
      maxDailyLossFraction: stored.maxDailyLossFraction,
      maxPositionFraction: stored.maxPositionFraction,
      maxPortfolioExposureFraction: stored.maxPortfolioExposureFraction,
      minRiskRewardRatio: stored.minRiskRewardRatio,
      maxLeverage: stored.maxLeverage,
    },
    side: body.side,
    dailyPnl: body.dailyPnl ?? null,
    openPositions: body.openPositions,
    correlationGroup: body.correlationGroup,
  });

  // The Copilot packet is large and only needed when the client is about to
  // call a model, so it is returned under its own key rather than inlined.
  const { copilotMessages, ...analysis } = result;
  return NextResponse.json({ analysis, copilotMessages });
}
