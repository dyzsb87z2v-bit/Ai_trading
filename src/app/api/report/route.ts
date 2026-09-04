/**
 * Daily AI market report (§28).
 *
 * Assembles the packet from whatever is actually available and returns it. When
 * a Copilot model is configured the narrative is generated too; otherwise the
 * packet is returned on its own — the report's facts do not depend on a model.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { bootstrapProviders } from "@/lib/trading/providers/bootstrap";
import {
  getActiveEconomicCalendarProvider,
  getActiveNewsProvider,
} from "@/lib/trading/providers/registry";
import { buildDailyReportPacket, DAILY_REPORT_SYSTEM_PROMPT } from "@/lib/trading/dailyReport";
import { auditCopilotOutput } from "@/lib/trading/copilot";

const bodySchema = z.object({
  overview: z
    .array(
      z.object({
        symbol: z.string().min(1).max(64),
        changePercent: z.number().finite().nullable(),
        trend: z.string().max(32).nullable(),
        regime: z.string().max(32).nullable(),
        dataStatus: z.string().max(24),
      })
    )
    .max(50)
    .optional(),
  scan: z.unknown().optional(),
  generateNarrative: z.boolean().optional(),
});

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  bootstrapProviders();

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid report request" }, { status: 400 });
  }

  const now = Date.now();
  const newsProvider = getActiveNewsProvider();
  const calendarProvider = getActiveEconomicCalendarProvider();

  const newsResult = newsProvider ? await newsProvider.getNews({ limit: 15 }) : null;
  const eventsResult = calendarProvider
    ? await calendarProvider.getEvents({ from: now, to: now + 2 * 86_400_000 })
    : null;

  const packet = buildDailyReportPacket({
    generatedAt: now,
    overview: parsed.data.overview ?? [],
    scan: (parsed.data.scan as never) ?? null,
    // null means "no provider"; an empty array means "provider returned nothing".
    news: newsResult === null ? null : newsResult.available ? newsResult.data : null,
    events: eventsResult === null ? null : eventsResult.available ? eventsResult.data : null,
    portfolio: null,
    portfolioRisk: null,
    openPositions: [],
  });

  const baseUrl = process.env.COPILOT_BASE_URL?.trim();
  const model = process.env.COPILOT_MODEL?.trim();

  if (!parsed.data.generateNarrative || !baseUrl || !model) {
    return NextResponse.json({
      packet,
      narrative: null,
      narrativeUnavailableReason:
        !baseUrl || !model
          ? "COPILOT UNAVAILABLE — set COPILOT_BASE_URL and COPILOT_MODEL to generate the narrative."
          : null,
    });
  }

  try {
    const upstream = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.COPILOT_API_KEY
          ? { authorization: `Bearer ${process.env.COPILOT_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: DAILY_REPORT_SYSTEM_PROMPT },
          { role: "user", content: packet },
        ],
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!upstream.ok) {
      return NextResponse.json({
        packet,
        narrative: null,
        narrativeUnavailableReason: `COPILOT UNAVAILABLE — model endpoint returned ${upstream.status}.`,
      });
    }

    const payload = (await upstream.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
    } | null;
    const text = payload?.choices?.[0]?.message?.content ?? "";

    return NextResponse.json({
      packet,
      narrative: text || null,
      audit: text ? auditCopilotOutput(text) : null,
      narrativeUnavailableReason: text ? null : "The model returned an empty response.",
    });
  } catch {
    return NextResponse.json({
      packet,
      narrative: null,
      narrativeUnavailableReason: "COPILOT UNAVAILABLE — could not reach the model endpoint.",
    });
  }
}
