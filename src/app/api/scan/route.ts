/**
 * Market scanner (§27).
 *
 * Candles arrive in the request, one entry per symbol, so the endpoint works
 * with any provider. Bounded at 100 symbols per call: the pipeline runs in full
 * for each one, and an unbounded body would be a trivial denial of service.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { getRiskSettings } from "@/lib/db/trading";
import { scanMarkets, type ScanInput } from "@/lib/trading/scanner";
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
  timeframe: z.enum(ALL_TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]]),
  symbols: z
    .array(
      z.object({
        symbol: z.string().min(1).max(64),
        assetClass: z.enum(["stock", "etf", "index", "forex", "crypto"]),
        candles: z.array(candleSchema).min(1).max(2000),
        provenance: provenanceSchema,
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
      })
    )
    .min(1)
    .max(100),
  minScore: z.number().min(0).max(100).optional(),
  tradeableOnly: z.boolean().optional(),
  kinds: z.array(z.string().max(32)).max(10).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid scan request", details: parsed.error.issues.slice(0, 5) },
      { status: 400 }
    );
  }

  const body = parsed.data;
  const stored = getRiskSettings();

  const inputs: ScanInput[] = body.symbols.map((entry) => {
    const instrument = { symbol: entry.symbol, assetClass: entry.assetClass };
    return {
      instrument,
      timeframe: body.timeframe,
      series: {
        instrument,
        timeframe: body.timeframe,
        candles: normalizeCandles(entry.candles),
        provenance: entry.provenance,
      },
      quote: entry.quote
        ? {
            instrument,
            last: entry.quote.last,
            bid: entry.quote.bid,
            ask: entry.quote.ask,
            spread:
              entry.quote.bid !== null && entry.quote.ask !== null
                ? entry.quote.ask - entry.quote.bid
                : null,
            volume: entry.quote.volume,
            tradeCount: null,
            vwap: entry.quote.vwap,
            changePercent: entry.quote.changePercent,
            session: entry.quote.session,
            provenance: entry.quote.provenance,
          }
        : null,
    };
  });

  const result = scanMarkets(inputs, {
    settings: {
      accountEquity: stored.accountEquity,
      riskPerTradeFraction: stored.riskPerTradeFraction,
      maxDailyLossFraction: stored.maxDailyLossFraction,
      maxPositionFraction: stored.maxPositionFraction,
      maxPortfolioExposureFraction: stored.maxPortfolioExposureFraction,
      minRiskRewardRatio: stored.minRiskRewardRatio,
      maxLeverage: stored.maxLeverage,
    },
    minScore: body.minScore,
    tradeableOnly: body.tradeableOnly,
    kinds: body.kinds as never,
    limit: body.limit,
  });

  return NextResponse.json(result);
}
