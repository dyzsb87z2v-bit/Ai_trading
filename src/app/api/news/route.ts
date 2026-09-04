/**
 * News (§13). Reports NEWS DATA UNAVAILABLE when no provider is configured,
 * rather than returning an empty list that reads as "no news today".
 */

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { bootstrapProviders } from "@/lib/trading/providers/bootstrap";
import { getActiveNewsProvider, unavailableMessageFor } from "@/lib/trading/providers/registry";

export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  bootstrapProviders();

  const provider = getActiveNewsProvider();
  if (!provider) {
    return NextResponse.json(
      { error: unavailableMessageFor("news"), articles: null },
      { status: 503 }
    );
  }

  const url = new URL(request.url);
  const symbolsParam = url.searchParams.get("symbols");
  const symbols = symbolsParam
    ? symbolsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20)
    : undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

  const result = await provider.getNews({ symbols, limit });
  if (!result.available) {
    return NextResponse.json(
      { error: result.reason, code: result.code, articles: null },
      { status: 503 }
    );
  }
  return NextResponse.json({ articles: result.data, source: provider.descriptor.id });
}
