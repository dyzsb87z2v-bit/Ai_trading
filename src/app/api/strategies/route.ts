/**
 * Strategy Lab definitions (§19).
 *
 * Definitions are validated by the rule engine before they are stored, so a
 * broken tree is rejected at write time rather than failing silently in a
 * backtest later. Definitions are DATA — never executable code.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { deleteStrategy, listStrategies, saveStrategy } from "@/lib/db/trading";
import {
  listStrategyPresets,
  validateStrategyDefinition,
  type StrategyDefinition,
} from "@/lib/trading/strategyLab";

const saveSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  // Shape is checked by the rule engine's own validator below, which produces
  // field-level messages a form can render.
  definition: z.record(z.string(), z.unknown()),
});

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  return NextResponse.json({ strategies: listStrategies(), presets: listStrategyPresets() });
}

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = saveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid strategy payload" }, { status: 400 });
  }

  const definition = parsed.data.definition as unknown as StrategyDefinition;
  const issues = validateStrategyDefinition(definition);
  if (issues.length > 0) {
    return NextResponse.json({ error: "Invalid strategy definition", issues }, { status: 400 });
  }

  return NextResponse.json({
    strategy: saveStrategy({
      id: parsed.data.id,
      name: parsed.data.name,
      description: parsed.data.description,
      definition,
    }),
  });
}

export async function DELETE(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  deleteStrategy(id);
  return NextResponse.json({ ok: true });
}
