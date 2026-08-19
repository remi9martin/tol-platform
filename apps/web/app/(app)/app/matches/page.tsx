import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient } from "@/lib/api-client";
import { StatusChip } from "@/components/shared/StatusChip";
import { shortId } from "@/lib/format";

export const metadata: Metadata = { title: "Matches — TOL" };

/**
 * the spec names only the detail route (`/app/matches/[opportunityId]`)
 * — there is no dedicated list route in the scope, and no `/app/
 * opportunities` index exists anywhere in this codebase (Opportunity has
 * been a real earlier backend entity without its own apps/web page through
 * earlier). A sidebar nav entry still needs somewhere to land, so this
 * list page reuses the EXISTING listOpportunities() call (already used
 * by rfqs/new/page.tsx's own opportunity picker) as a lightweight
 * opportunity picker, each row linking into the real P11/P12 detail
 * route the scope does name — the same two-tier list-then-detail shape
 * every other promoted nav item (Claims, Lockbox, RFQ) already has.
 * apps/api's own listOpportunities service already scopes the returned
 * set correctly per persona — this page renders whatever comes back
 * without re-deriving that split client-side (same discipline as
 * claims/page.tsx).
 */
export default async function MatchesListPage() {
  const session = await getServerSession();
  if (!session) throw new Error("MatchesListPage rendered without a session — AppLayout's guard should prevent this.");

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  const { opportunities } = await apiClient.listOpportunities({ cookieHeader });

  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="mono-label mb-2">P11 / P12 · Matching</div>
        <h1 className="text-2xl font-semibold text-ink">Matches</h1>
        <p className="mt-1 max-w-[62ch] text-sm text-ink-2">
          Deterministic eligibility (P11) and explainable ranking (P12) for each opportunity, evaluated
          against every active candidate capacity. Pick an opportunity to run or review its matches.
        </p>
      </div>

      <div className="panel scrollx">
        {opportunities.length === 0 ? (
          <p className="p-5 text-sm text-ink-3">No opportunities yet.</p>
        ) : (
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-edge text-left">
                <th className="mono-label px-4 py-3 font-normal">Opportunity</th>
                <th className="mono-label px-4 py-3 font-normal">Type</th>
                <th className="mono-label px-4 py-3 font-normal">Status</th>
                <th className="mono-label px-4 py-3 font-normal">Jurisdictions</th>
                <th className="mono-label px-4 py-3 font-normal">MCCs</th>
                <th className="mono-label px-4 py-3 font-normal" />
              </tr>
            </thead>
            <tbody>
              {opportunities.map((opp) => (
                <tr key={opp.id} className="border-b border-edge last:border-0 hover:bg-[rgba(255,80,80,0.04)]">
                  <td className="px-4 py-3">
                    <div className="text-ink">{opp.requestedService}</div>
                    <div className="mono-label mt-0.5">Opportunity {shortId(opp.id)}</div>
                  </td>
                  <td className="px-4 py-3 text-ink-2">{opp.opportunityType}</td>
                  <td className="px-4 py-3">
                    <StatusChip status={opp.status} />
                  </td>
                  <td className="px-4 py-3 text-ink-2">{opp.jurisdictions.join(", ") || "—"}</td>
                  <td className="px-4 py-3 text-ink-2">{opp.mccs.join(", ") || "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/app/matches/${opp.id}`} className="btn btn-ghost">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
