import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE, isAuthConfigured, verifySessionToken } from "@/lib/auth/session";
import { TerminalClient } from "./TerminalClient";

export const dynamic = "force-dynamic";

export default async function TerminalPage() {
  // Gate on the server so an unauthenticated visitor never receives the page
  // shell at all, rather than briefly rendering it before a client redirect.
  if (!isAuthConfigured()) redirect("/setup");
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token))) redirect("/login");
  return <TerminalClient />;
}
