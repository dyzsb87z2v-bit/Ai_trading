import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE, isAuthConfigured, verifySessionToken } from "@/lib/auth/session";
import { PortfolioClient } from "./PortfolioClient";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  if (!isAuthConfigured()) redirect("/setup");
  if (!(await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value))) redirect("/login");
  return <PortfolioClient />;
}
