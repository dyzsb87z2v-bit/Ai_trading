import { z } from "zod";
import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  createSessionToken,
  isAuthConfigured,
  passwordMatches,
  sessionCookieOptions,
} from "@/lib/auth/session";

const bodySchema = z.object({ password: z.string().min(1).max(512) });

export async function POST(request: Request) {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      { error: "AUTH NOT CONFIGURED — set AUTH_SECRET and APP_PASSWORD in .env." },
      { status: 503 }
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A password is required." }, { status: 400 });
  }

  // One generic message for a wrong password: never reveal whether the account
  // or the password was the problem.
  if (!passwordMatches(parsed.data.password)) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(), sessionCookieOptions());
  return response;
}
