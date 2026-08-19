import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient } from "@/lib/api-client";
import { StatusChip } from "@/components/shared/StatusChip";
import { shortId } from "@/lib/format";

export const metadata: Metadata = { title: "Economics — TOL" };

/**
 * the spec: "/app/economics — Economics Ledger — Schedules, commissions,
 * earned/accrued/paid status." No dynamic segment is named for the list
 * route itself (same shape as Matches, p.6's own `/app/matches/
 * [opportunityId]` names only the detail route) — this list page reuses
 * the EXISTING listDeals() call as a picker, each row linking into the
 * real per-deal economics view, the same two-tier list-then-detail shape
 * every other promoted nav item already has (see Sidebar.tsx's own
 * comment, and matches/page.tsx's identical precedent).
 */
export default async function EconomicsListPage() {
  const session = await getServerSession();
  if (!session) throw new Error("EconomicsListPage rendered without a session — AppLayout's guard should prevent this.");

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  const { deals } = await apiClient.listDeals({ cookieHeader });

  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="mono-label mb-2">P15 · Economics</div>
        <h1 className="text-2xl font-semibold text-ink">Economics</h1>
        <p className="mt-1 max-w-[62ch] text-sm text-ink-2">
          The traceable schedule/accrual ledger for each deal — the commission split, real revenue events, and every
          ledger entry&apos;s provenance back to the schedule version and attribution claim that justify it. Pick a
          deal to view or engage its economics.
        </p>
      </div>

      <div className="panel scrollx">
        {deals.length === 0 ? (
          <p className="p-5 text-sm text-ink-3">No deal rooms yet.</p>
        ) : (
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-edge text-left">
                <th className="mono-label px-4 py-3 font-normal">Deal room</th>
                <th className="mono-label px-4 py-3 font-normal">Status</th>
                <th className="mono-label px-4 py-3 font-normal" />
              </tr>
            </thead>
            <tbody>
              {deals.map((d) => (
                <tr key={d.id} className="border-b border-edge last:border-0 hover:bg-[rgba(255,80,80,0.04)]">
                  <td className="px-4 py-3">
                    <div className="text-ink">
                      {shortId(d.merchantOrgId)} <span className="text-ink-3">×</span> {shortId(d.providerOrgId)}
                    </div>
                    <div className="mono-label mt-0.5">Deal {shortId(d.id)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusChip status={d.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/app/economics/${d.id}`} className="btn btn-ghost">
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
