import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session";
import { AppShell } from "@/components/shell/AppShell";

/**
 * The auth gate for every (app) route. Calls apps/api's GET /auth/session
 * server-side (lib/session.ts) — a null return means "no valid session",
 * and this is the ONLY place that decides to redirect. This is a UX
 * convenience layer, not the security boundary: even if this check were
 * removed entirely, every apps/api route independently re-checks
 * request.actor and authz.can() (apps/api/src/plugins/auth.ts) — a
 * client that skipped this redirect and called the API directly would
 * still get 401/403 from the API itself. middleware.ts adds a third,
 * even-earlier layer (presence-only cookie check) purely to avoid an
 * unnecessary server round trip for the obviously-signed-out case.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) {
    redirect("/sign-in");
  }

  return <AppShell session={session}>{children}</AppShell>;
}
