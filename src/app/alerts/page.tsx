import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE, isAuthConfigured, verifySessionToken } from "@/lib/auth/session";
import { AlertsClient } from "./AlertsClient";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  if (!isAuthConfigured()) redirect("/setup");
  if (!(await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value))) redirect("/login");
  return <AlertsClient />;
}
