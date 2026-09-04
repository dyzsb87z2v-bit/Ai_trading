import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, isAuthConfigured, verifySessionToken } from "@/lib/auth/session";

export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return NextResponse.json({
    configured: isAuthConfigured(),
    authenticated: await verifySessionToken(token),
  });
}
