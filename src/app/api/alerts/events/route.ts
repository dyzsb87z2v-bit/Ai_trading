/**
 * Fired alert events (§26). The browser channel is delivery-by-polling: the UI
 * reads undelivered events here and acknowledges them.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { acknowledgeAlertEvents, listAlertEvents } from "@/lib/db/trading";

export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const url = new URL(request.url);
  const unacknowledgedOnly = url.searchParams.get("unacknowledged") === "true";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
  return NextResponse.json({ events: listAlertEvents(limit, unacknowledgedOnly) });
}

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = z
    .object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "ids are required" }, { status: 400 });

  acknowledgeAlertEvents(parsed.data.ids);
  return NextResponse.json({ ok: true });
}
