/**
 * Trading journal (§23). Records closed trades and returns the statistics the
 * spec asks for: win rate, profit factor, expectancy, average R, and P&L by
 * day, ISO week and month.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { createJournalEntry, getJournalEntries } from "@/lib/db/trading";
import { computeJournalStatistics } from "@/lib/trading/portfolio";

const ACCOUNT = "paper-1";

const entrySchema = z.object({
  symbol: z.string().min(1).max(64),
  side: z.enum(["long", "short"]),
  openedAt: z.number().int().finite(),
  closedAt: z.number().int().finite().nullable(),
  entryPrice: z.number().positive(),
  exitPrice: z.number().positive().nullable(),
  stopPrice: z.number().positive().nullable().optional(),
  targetPrices: z.array(z.number().positive()).max(10).optional(),
  quantity: z.number().positive(),
  riskAmount: z.number().min(0).nullable().optional(),
  fees: z.number().min(0).optional(),
  netPnl: z.number().finite().nullable().optional(),
  strategy: z.string().max(120).nullable().optional(),
  marketRegime: z.string().max(32).nullable().optional(),
  signalScore: z.number().min(0).max(100).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const entries = getJournalEntries(ACCOUNT, 1000);
  const closed = entries.filter((e) => e.closedAt !== null && e.netPnl !== null);

  return NextResponse.json({
    entries,
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

  const parsed = entrySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid journal entry" }, { status: 400 });
  }
  const body = parsed.data;

  // R-multiple is derived only when the risk was actually recorded; deriving it
  // from a guessed risk would make the statistic meaningless (§23).
  const rMultiple =
    body.netPnl !== null && body.netPnl !== undefined && body.riskAmount
      ? body.netPnl / body.riskAmount
      : null;

  return NextResponse.json({
    entry: createJournalEntry({
      accountId: ACCOUNT,
      symbol: body.symbol,
      side: body.side,
      openedAt: body.openedAt,
      closedAt: body.closedAt,
      entryPrice: body.entryPrice,
      exitPrice: body.exitPrice,
      stopPrice: body.stopPrice ?? null,
      targetPrices: body.targetPrices ?? [],
      quantity: body.quantity,
      riskAmount: body.riskAmount ?? null,
      netPnl: body.netPnl ?? null,
      rMultiple,
      fees: body.fees ?? 0,
      strategy: body.strategy ?? null,
      marketRegime: body.marketRegime ?? null,
      signalScore: body.signalScore ?? null,
      notes: body.notes ?? null,
      executionMode: "PAPER",
    }),
  });
}
