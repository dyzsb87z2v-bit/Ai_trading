/**
 * Which data providers are configured.
 *
 * The UI calls this before rendering anything market-dependent, so it can show
 * "DATA SOURCE UNAVAILABLE" instead of an empty chart that looks like a bug.
 */

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { summarizeProviders } from "@/lib/trading/providers/registry";

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const providers = summarizeProviders().map((provider) => ({
    ...provider,
    available: provider.configured > 0,
  }));

  return NextResponse.json({
    providers,
    // Live execution requires a configured broker AND an explicit opt-in.
    liveTradingEnabled: false,
    copilotConfigured: Boolean(process.env.COPILOT_BASE_URL && process.env.COPILOT_MODEL),
  });
}
