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
import {
  closeJournalEntry,
  createJournalEntry,
  getJournalEntries,
  getJournalEntry,
  getRiskSettings,
} from "@/lib/db/trading";
import { PaperTradingEngine } from "@/lib/trading/paperTrading";
import { computeJournalStatistics } from "@/lib/trading/portfolio";
import type { Quote, Side } from "@/lib/trading/types";

const PAPER_ACCOUNT = "paper-1";

const closeSchema = z.object({
  action: z.literal("close"),
  entryId: z.string().min(1).max(64),
  /** Price the closing order fills against. Required — never guessed. */
  price: z.number().positive(),
});

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

  const raw = await request.json().catch(() => null);

  // A close carries `action: "close"`; anything else is an opening order, so
  // the existing open-order body stays valid unchanged.
  if (raw && typeof raw === "object" && (raw as { action?: unknown }).action === "close") {
    const closeParsed = closeSchema.safeParse(raw);
    if (!closeParsed.success) {
      return NextResponse.json({ error: "Invalid close request" }, { status: 400 });
    }
    return closePosition(closeParsed.data);
  }

  const parsed = orderSchema.safeParse(raw);
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

/**
 * Close an open paper position at a given price.
 *
 * The exit leg runs through the engine rather than a second copy of the cost
 * model: the position is seeded at its stored entry price and an opposite
 * market order is submitted, so the exit crosses the spread and pays commission
 * exactly as a real exit would. The entry leg's fees were already charged when
 * the position was opened, so the round-trip total adds them back in once.
 */
async function closePosition(input: { entryId: string; price: number }): Promise<Response> {
  const entry = getJournalEntry(input.entryId);
  if (!entry || entry.accountId !== PAPER_ACCOUNT) {
    return NextResponse.json({ error: "Position not found." }, { status: 404 });
  }
  if (entry.closedAt !== null) {
    return NextResponse.json({ error: "That position is already closed." }, { status: 409 });
  }

  const settings = getRiskSettings();
  const initialCapital = settings.accountEquity > 0 ? settings.accountEquity : 100_000;
  const engine = new PaperTradingEngine({ initialCapital });

  const side: Side = entry.side === "short" ? "short" : "long";
  engine.seedPosition({
    symbol: entry.symbol,
    side,
    quantity: entry.quantity,
    averageEntryPrice: entry.entryPrice,
    openedAt: entry.openedAt,
  });

  const price = input.price;
  const quote: Quote = {
    instrument: { symbol: entry.symbol, assetClass: "stock" },
    last: price,
    bid: price,
    ask: price,
    spread: 0,
    volume: null,
    tradeCount: null,
    vwap: null,
    changePercent: null,
    session: "regular",
    provenance: { source: "paper", timestamp: Date.now(), status: "PAPER" },
  };

  const order = engine.submitOrder(
    {
      symbol: entry.symbol,
      side: side === "long" ? "sell" : "buy",
      type: "market",
      quantity: entry.quantity,
    },
    quote
  );

  if (order.status !== "filled" || order.averageFillPrice === null) {
    return NextResponse.json(
      { order, error: order.rejectReason ?? "The closing order did not fill." },
      { status: 400 }
    );
  }

  const state = engine.getState();
  const roundTripFees = entry.fees + order.fees;
  // realizedPnl is gross of fees; both legs' costs come off here.
  const netPnl = state.realizedPnl - roundTripFees;

  // R is measured against the risk actually taken. With neither a recorded risk
  // amount nor a stop there is no R to report — null, never a stand-in number.
  const riskPerUnit = entry.stopPrice !== null ? Math.abs(entry.entryPrice - entry.stopPrice) : 0;
  const riskAmount =
    entry.riskAmount !== null && entry.riskAmount > 0
      ? entry.riskAmount
      : riskPerUnit > 0
        ? riskPerUnit * entry.quantity
        : 0;
  const rMultiple = riskAmount > 0 ? netPnl / riskAmount : null;

  const closed = closeJournalEntry(entry.id, {
    closedAt: Date.now(),
    exitPrice: order.averageFillPrice,
    netPnl,
    rMultiple,
    fees: roundTripFees,
  });

  if (!closed) {
    // Lost the race with a concurrent close. Say so rather than reporting a
    // second P&L for the same position.
    return NextResponse.json({ error: "That position is already closed." }, { status: 409 });
  }

  return NextResponse.json({ order, entry: closed });
}
