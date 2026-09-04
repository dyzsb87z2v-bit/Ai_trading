/**
 * Broker account, positions and orders — READ ONLY (§21).
 *
 * There is deliberately no POST here. Submitting an order is a separate,
 * explicitly-gated endpoint so that no ordinary read route can ever become an
 * execution path by accident.
 */

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { bootstrapProviders } from "@/lib/trading/providers/bootstrap";
import { getActiveBrokerProvider, unavailableMessageFor } from "@/lib/trading/providers/registry";

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  bootstrapProviders();

  const provider = getActiveBrokerProvider();
  if (!provider) {
    return NextResponse.json(
      { error: unavailableMessageFor("broker"), account: null, positions: null, orders: null },
      { status: 503 }
    );
  }

  const [account, positions, orders] = await Promise.all([
    provider.getAccount(),
    provider.getPositions(),
    provider.getOrders(),
  ]);

  return NextResponse.json({
    source: provider.descriptor.id,
    // Surfaced so the UI can never present a live account as paper, or vice versa.
    tradingEnabled: provider.tradingEnabled,
    account: account.available ? account.data : null,
    accountError: account.available ? null : account.reason,
    positions: positions.available ? positions.data : null,
    positionsError: positions.available ? null : positions.reason,
    orders: orders.available ? orders.data : null,
    ordersError: orders.available ? null : orders.reason,
  });
}
