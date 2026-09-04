/**
 * Economic calendar (§14).
 *
 * Also computes the §14 proximity warnings (30 min / 10 min / now) so the UI
 * and the risk engine read the same countdown.
 */

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { bootstrapProviders } from "@/lib/trading/providers/bootstrap";
import {
  getActiveEconomicCalendarProvider,
  unavailableMessageFor,
} from "@/lib/trading/providers/registry";

export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  bootstrapProviders();

  const provider = getActiveEconomicCalendarProvider();
  if (!provider) {
    return NextResponse.json(
      { error: unavailableMessageFor("economic-calendar"), events: null },
      { status: 503 }
    );
  }

  const url = new URL(request.url);
  const now = Date.now();
  const from = Number(url.searchParams.get("from") ?? now - 86_400_000);
  const to = Number(url.searchParams.get("to") ?? now + 7 * 86_400_000);
  const countriesParam = url.searchParams.get("countries");
  const countries = countriesParam
    ? countriesParam
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
    : undefined;

  const result = await provider.getEvents({ from, to, countries });
  if (!result.available) {
    return NextResponse.json(
      { error: result.reason, code: result.code, events: null },
      { status: 503 }
    );
  }

  // §14: the countdown warnings, computed once so the UI and the risk engine
  // never disagree about how close an event is.
  const warnings = result.data
    .filter((event) => event.importance === "high" && event.scheduledAt >= now)
    .map((event) => {
      const minutes = Math.round((event.scheduledAt - now) / 60_000);
      if (minutes <= 0)
        return { event: event.name, country: event.country, level: "now" as const, minutes: 0 };
      if (minutes <= 10)
        return { event: event.name, country: event.country, level: "imminent" as const, minutes };
      if (minutes <= 30)
        return { event: event.name, country: event.country, level: "soon" as const, minutes };
      return null;
    })
    .filter((w): w is NonNullable<typeof w> => w !== null);

  return NextResponse.json({ events: result.data, warnings, source: provider.descriptor.id });
}
