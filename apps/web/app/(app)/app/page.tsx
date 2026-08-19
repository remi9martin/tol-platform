import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient, ApiError } from "@/lib/api-client";
import { OrganizationProfileCard } from "@/components/dashboard/OrganizationProfileCard";
import { MembershipList } from "@/components/dashboard/MembershipList";

/**
 * The "authenticated org/profile view calling the API" earlier asks for.
 * Server Component — fetches through apiClient (which itself just
 * forwards to apps/api; no domain logic lives here per the spec).
 */
export default async function DashboardPage() {
  const session = await getServerSession();
  // AppLayout (the parent) already redirects on a null session, so this
  // is unreachable in practice — narrowing for the type checker, and
  // failing loudly rather than silently rendering a broken page if the
  // parent's guarantee is ever weakened.
  if (!session) {
    throw new Error("DashboardPage rendered without a session — AppLayout's guard should prevent this.");
  }

  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  // `!== null` rather than a truthy check — activeOrganizationId is
  // typed string | null (never a number/empty-string edge case in
  // practice, since apps/api only ever populates it from a real
  // Organization row's UUID primary key via an enforced foreign key),
  // but the explicit null check is unambiguous regardless, at zero cost
  // (tightened after review, apps/web this stage).
  let activeOrg = null;
  let orgLoadError: string | null = null;
  if (session.activeOrganizationId !== null) {
    try {
      activeOrg = await apiClient.getOrganization(session.activeOrganizationId, { cookieHeader });
    } catch (err) {
      // A real, if narrow, gap this closes (review, apps/web
      // this stage): this fetch failing (network blip, apps/api briefly
      // down) previously threw uncaught out of a Server Component,
      // handing the visitor Next.js's generic error boundary instead of
      // a page that still renders with a clear, specific message.
      orgLoadError = err instanceof ApiError ? err.problem.message : "Could not load the organization profile.";
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Dashboard</h1>
        <p className="mt-1 text-sm text-ink-2">
          Signed in as <span className="text-ink">{session.user.email}</span>, acting as{" "}
          <span className="text-ink">{session.activeRole ?? "no active role"}</span>.
        </p>
      </div>

      {orgLoadError && (
        <p role="alert" className="field-error">
          {orgLoadError}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <OrganizationProfileCard organization={activeOrg} />
        <MembershipList session={session} />
      </div>
    </div>
  );
}
