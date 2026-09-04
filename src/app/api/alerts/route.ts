/**
 * Alert rules (§26). GET lists, POST creates, DELETE removes.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { createAlert, deleteAlert, listAlerts, setAlertEnabled } from "@/lib/db/trading";
import { ALERT_KIND_LABELS } from "@/lib/trading/alerts";

const KINDS = Object.keys(ALERT_KIND_LABELS) as [string, ...string[]];

const createSchema = z.object({
  symbol: z.string().min(1).max(64),
  kind: z.enum(KINDS),
  value: z.number().finite().nullable().optional(),
  channels: z
    .array(z.enum(["browser", "email", "telegram", "push"]))
    .min(1)
    .max(4)
    .optional(),
  cooldownMs: z.number().int().min(0).max(86_400_000).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const symbol = new URL(request.url).searchParams.get("symbol") ?? undefined;
  return NextResponse.json({ alerts: listAlerts(symbol), kinds: ALERT_KIND_LABELS });
}

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid alert" }, { status: 400 });
  }
  return NextResponse.json({ alert: createAlert(parsed.data) }, { status: 201 });
}

export async function PATCH(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = z
    .object({ id: z.string().min(1).max(64), enabled: z.boolean() })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  setAlertEnabled(parsed.data.id, parsed.data.enabled);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  deleteAlert(id);
  return NextResponse.json({ ok: true });
}
