/**
 * Route guard. Every API route that touches data calls `requireSession` first.
 *
 * Returns a Response to send back on failure, or null when the caller may
 * proceed — the same shape used across the API layer so the check is one line
 * at the top of each handler and impossible to half-apply.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, isAuthConfigured, verifySessionToken } from "./session";

export async function requireSession(): Promise<NextResponse | null> {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      {
        error:
          "AUTH NOT CONFIGURED — set AUTH_SECRET and APP_PASSWORD in .env before using the app.",
      },
      { status: 503 }
    );
  }

  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token))) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  return null;
}
