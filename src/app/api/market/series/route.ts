/**
 * Market series.
 *
 * With a market-data adapter registered this returns real bars. With none — the
 * default — it returns a synthetic series whose provenance is stamped
 * `SIMULATED` SERVER-SIDE, so a client can never present it as live.
 *
 * Because `SIMULATED` is not a tradeable status, the freshness gate disables
 * live analysis and the risk engine refuses a tradeable verdict. The demo path
 * exercises the safety property rather than bypassing it.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { getActiveMarketDataProvider } from "@/lib/trading/providers/registry";
import { bootstrapProviders } from "@/lib/trading/providers/bootstrap";
import {
  SIMULATED_DATA_NOTICE,
  generateSimulatedCandles,
  generateSimulatedQuote,
} from "@/lib/trading/simulatedMarket";
import { ALL_TIMEFRAMES, TIMEFRAME_MS, type Timeframe } from "@/lib/trading/types";

const querySchema = z.object({
  symbol: z
    .string()
    .min(1)
    .max(16)
    .regex(/^[A-Za-z0-9._-]+$/, "Symbol contains unsupported characters"),
  timeframe: z.enum(ALL_TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]]),
  count: z.coerce.number().int().min(50).max(1500),
  assetClass: z.enum(["stock", "etf", "index", "forex", "crypto"]),
});

export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  bootstrapProviders();

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    symbol: url.searchParams.get("symbol") ?? "DEMO",
    timeframe: url.searchParams.get("timeframe") ?? "1H",
    count: url.searchParams.get("count") ?? "300",
    assetClass: url.searchParams.get("assetClass") ?? "stock",
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid series parameters" }, { status: 400 });
  }

  const { symbol, timeframe, count, assetClass } = parsed.data;
  const instrument = { symbol: symbol.toUpperCase(), assetClass };
  const provider = getActiveMarketDataProvider();

  if (provider) {
    const to = Date.now();
    const from = to - TIMEFRAME_MS[timeframe] * count;
    const [candles, quote] = await Promise.all([
      provider.getCandles({ instrument, timeframe, from, to, limit: count }),
      provider.getQuote(instrument),
    ]);

    if (!candles.available) {
      return NextResponse.json(
        { error: `DATA SOURCE UNAVAILABLE — ${candles.reason}`, code: candles.code },
        { status: 503 }
      );
    }

    return NextResponse.json({
      notice: null,
      simulated: false,
      instrument,
      timeframe,
      candles: candles.data.candles,
      quote: quote.available ? quote.data : null,
      provenance: candles.data.provenance,
    });
  }

  const candles = generateSimulatedCandles({ symbol: instrument.symbol, timeframe, count });
  return NextResponse.json({
    notice: SIMULATED_DATA_NOTICE,
    simulated: true,
    instrument,
    timeframe,
    candles,
    quote: generateSimulatedQuote(instrument, candles),
    provenance: {
      source: "simulated-generator",
      timestamp: candles[candles.length - 1]?.timestamp ?? Date.now(),
      // Stamped here. The client cannot ask for a different status.
      status: "SIMULATED" as const,
    },
  });
}
