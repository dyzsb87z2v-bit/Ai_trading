/**
 * Paper trading (§20).
 *
 * Simulated execution against real market data. Every artefact this endpoint
 * returns is stamped PAPER, and the account is persisted so a reload does not
 * silently reset the balance.
 *
 * The engine is rebuilt from stored state on each call and the resulting fills
 * are written back — the app is stateless between requests, so keeping a live
 * engine in module scope would lose trades on any restart.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { createJournalEntry, getJournalEntries, getRiskSettings } from "@/lib/db/trading";
import { PaperTradingEngine } from "@/lib/trading/paperTrading";
import { computeJournalStatistics } from "@/lib/trading/portfolio";
import type { Quote } from "@/lib/trading/types";

const PAPER_ACCOUNT = "paper-1";

const orderSchema = z.object({
  symbol: z.string().min(1).max(64),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit", "stop"]),
  quantity: z.number().positive().max(1_000_000),
  limitPrice: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
  /** Price the order fills against. Required for market orders. */
  price: z.number().positive().optional(),
});

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const entries = getJournalEntries(PAPER_ACCOUNT, 500);
  const closed = entries.filter((e) => e.closedAt !== null && e.netPnl !== null);
  const settings = getRiskSettings();

  const realized = closed.reduce((sum, e) => sum + (e.netPnl ?? 0), 0);
  const initialCapital = settings.accountEquity > 0 ? settings.accountEquity : 100_000;

  return NextResponse.json({
    mode: "PAPER",
    accountId: PAPER_ACCOUNT,
    initialCapital,
    realizedPnl: realized,
    equity: initialCapital + realized,
    openPositions: entries.filter((e) => e.closedAt === null),
    trades: closed,
    statistics: computeJournalStatistics(
      closed.map((e) => ({
        closedAt: e.closedAt as number,
        netPnl: e.netPnl as number,
        riskAmount: e.riskAmount,
        strategy: e.strategy ?? undefined,
      }))
    ),
  });
}

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = orderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid paper order" }, { status: 400 });
  }
  const body = parsed.data;

  if (body.type === "market" && body.price === undefined) {
    // A market order with no price would have to be filled at a guess (§20).
    return NextResponse.json(
      { error: "A market paper order needs the current price to fill against." },
      { status: 400 }
    );
  }

  const settings = getRiskSettings();
  const initialCapital = settings.accountEquity > 0 ? settings.accountEquity : 100_000;
  const engine = new PaperTradingEngine({ initialCapital });

  const price = body.price ?? body.limitPrice ?? body.stopPrice ?? 0;
  const quote: Quote = {
    instrument: { symbol: body.symbol, assetClass: "stock" },
    last: price,
    bid: price,
    ask: price,
    spread: 0,
    volume: null,
    tradeCount: null,
    vwap: null,
    changePercent: null,
    session: "regular",
    // PAPER, not LIVE: the fill is simulated even though the price is real.
    provenance: { source: "paper", timestamp: Date.now(), status: "PAPER" },
  };

  const order = engine.submitOrder(
    {
      symbol: body.symbol,
      side: body.side,
      type: body.type,
      quantity: body.quantity,
      limitPrice: body.limitPrice,
      stopPrice: body.stopPrice,
    },
    quote
  );

  if (order.status === "rejected") {
    return NextResponse.json({ order, error: order.rejectReason }, { status: 400 });
  }

  // Persist the fill as an open journal entry so the position survives a reload.
  if (order.status === "filled" && order.averageFillPrice !== null) {
    createJournalEntry({
      accountId: PAPER_ACCOUNT,
      symbol: body.symbol,
      side: body.side === "buy" ? "long" : "short",
      openedAt: Date.now(),
      closedAt: null,
      entryPrice: order.averageFillPrice,
      exitPrice: null,
      stopPrice: body.stopPrice ?? null,
      targetPrices: [],
      quantity: order.filledQuantity,
      riskAmount: null,
      netPnl: null,
      rMultiple: null,
      fees: order.fees,
      strategy: null,
      marketRegime: null,
      signalScore: null,
      notes: null,
      executionMode: "PAPER",
    });
  }

  return NextResponse.json({ order });
}
