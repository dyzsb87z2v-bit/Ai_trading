/**
 * Risk limits. Bounds are enforced here as well as in the engine, so a UI bug
 * can never persist a 50% per-trade risk.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { getRiskSettings, updateRiskSettings } from "@/lib/db/trading";

const updateSchema = z.object({
  accountEquity: z.number().min(0).max(1_000_000_000).optional(),
  // Capped at 10%: above that is not risk management.
  riskPerTradeFraction: z.number().min(0).max(0.1).optional(),
  maxDailyLossFraction: z.number().min(0).max(0.5).optional(),
  maxPositionFraction: z.number().min(0).max(1).optional(),
  maxPortfolioExposureFraction: z.number().min(0).max(10).optional(),
  minRiskRewardRatio: z.number().min(0).max(100).optional(),
  maxLeverage: z.number().min(0).max(50).optional(),
  blockAroundHighImpactEvents: z.boolean().optional(),
  eventBlockWindowMinutes: z.number().int().min(0).max(1440).optional(),
});

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  return NextResponse.json({ settings: getRiskSettings() });
}

export async function PUT(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid risk settings", details: parsed.error.issues.map((i) => i.message) },
      { status: 400 }
    );
  }
  return NextResponse.json({ settings: updateRiskSettings(parsed.data) });
}
