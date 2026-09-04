/**
 * Session auth for the single local operator.
 *
 * Deliberately small: this app is a personal terminal, not a multi-tenant
 * service. There is one password, one signed cookie, and no user table.
 *
 * The security properties that still matter and are implemented:
 *  - The password is never stored; only compared, in constant time.
 *  - The session is a signed JWT (HS256) in an httpOnly, sameSite=lax cookie,
 *    so page scripts cannot read it and it does not ride cross-site requests.
 *  - Without AUTH_SECRET the app refuses to issue sessions rather than falling
 *    back to a default key.
 */

import { timingSafeEqual, createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "att_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

export class AuthNotConfiguredError extends Error {
  readonly code = "AUTH_NOT_CONFIGURED";
}

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 16) {
    throw new AuthNotConfiguredError(
      "AUTH_SECRET is unset or too short. Generate one with: openssl rand -base64 48"
    );
  }
  return new TextEncoder().encode(secret);
}

/**
 * Constant-time password comparison.
 *
 * Both sides are hashed to a fixed 32 bytes first: timingSafeEqual throws on
 * length mismatch, and that throw would itself leak the password's length.
 */
export function passwordMatches(candidate: string): boolean {
  const expected = process.env.APP_PASSWORD ?? "";
  if (expected.length === 0) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ sub: "operator" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, secretKey());
    return true;
  } catch {
    // Expired, tampered, or signed with a rotated secret — all mean "no session".
    return false;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    // Only over TLS in production; localhost dev is plain HTTP.
    secure: process.env.NODE_ENV === "production",
  };
}

export function isAuthConfigured(): boolean {
  const secret = process.env.AUTH_SECRET?.trim();
  return Boolean(secret && secret.length >= 16 && (process.env.APP_PASSWORD ?? "").length > 0);
}
