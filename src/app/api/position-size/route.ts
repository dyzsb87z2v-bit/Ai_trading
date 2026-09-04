/**
 * Position sizing. The response always carries the maximum loss INCLUDING fees
 * and slippage, so a client cannot show a size without the true risk attached.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { getRiskSettings } from "@/lib/db/trading";
import { DEFAULT_COST_MODEL, calculatePositionSize } from "@/lib/trading/positionSizing";

const bodySchema = z.object({
  entryPrice: z.number().positive().finite(),
  stopPrice: z.number().positive().finite(),
  side: z.enum(["long", "short"]),
  contractSize: z.number().positive().max(1_000_000).optional(),
  quantityIncrement: z.number().positive().max(1_000_000).optional(),
  riskMultiplier: z.number().min(0).max(1).optional(),
  costs: z
    .object({
      commissionRate: z.number().min(0).max(0.1),
      commissionFlat: z.number().min(0).max(10_000),
      slippageRate: z.number().min(0).max(0.1),
    })
    .optional(),
});

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sizing request" }, { status: 400 });
  }

  const body = parsed.data;
  const stored = getRiskSettings();

  return NextResponse.json({
    sizing: calculatePositionSize({
      entryPrice: body.entryPrice,
      stopPrice: body.stopPrice,
      side: body.side,
      settings: {
        accountEquity: stored.accountEquity,
        riskPerTradeFraction: stored.riskPerTradeFraction,
        maxDailyLossFraction: stored.maxDailyLossFraction,
        maxPositionFraction: stored.maxPositionFraction,
        maxPortfolioExposureFraction: stored.maxPortfolioExposureFraction,
        minRiskRewardRatio: stored.minRiskRewardRatio,
        maxLeverage: stored.maxLeverage,
      },
      costs: body.costs ?? DEFAULT_COST_MODEL,
      contractSize: body.contractSize,
      quantityIncrement: body.quantityIncrement,
      riskMultiplier: body.riskMultiplier,
    }),
  });
}
