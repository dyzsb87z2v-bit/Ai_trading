/**
 * Fundamentals (§15). Missing metrics stay null — never derived or defaulted.
 */

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { bootstrapProviders } from "@/lib/trading/providers/bootstrap";
import {
  getActiveFundamentalProvider,
  unavailableMessageFor,
} from "@/lib/trading/providers/registry";

export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  bootstrapProviders();

  const provider = getActiveFundamentalProvider();
  if (!provider) {
    return NextResponse.json(
      { error: unavailableMessageFor("fundamentals"), fundamentals: null },
      { status: 503 }
    );
  }

  const symbol = new URL(request.url).searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol is required" }, { status: 400 });

  const result = await provider.getFundamentals(symbol);
  if (!result.available) {
    return NextResponse.json(
      { error: result.reason, code: result.code, fundamentals: null },
      { status: 503 }
    );
  }
  return NextResponse.json({ fundamentals: result.data, source: provider.descriptor.id });
}
