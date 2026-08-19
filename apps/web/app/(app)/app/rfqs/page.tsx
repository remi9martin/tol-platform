import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient } from "@/lib/api-client";
import { StatusChip } from "@/components/shared/StatusChip";
import { formatDate, shortId } from "@/lib/format";

export const metadata: Metadata = { title: "RFQ Workspace — TOL" };

/** the spec: "/app/rfqs/[rfqId] — RFQ Workspace — Disclosure packet, questions, quote, conditions." This is the list surface feeding that detail route. */
export default async function RfqListPage() {
  const session = await getServerSession();
  if (!session) throw new Error("RfqListPage rendered without a session — AppLayout's guard should prevent this.");

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  const { rfqs } = await apiClient.listRfqs({ cookieHeader });

  // Enrich with the underlying Opportunity's requestedService for a
  // legible list — RFQDTO itself only carries opportunityId (see
  // apps/web AGENTS.md-adjacent note in rfqs/[rfqId]/page.tsx for why
  // this stays a web-layer join rather than a contracts-layer change).
  const opportunityIds = Array.from(new Set(rfqs.map((r) => r.opportunityId)));
  const opportunities = await Promise.all(
    opportunityIds.map((id) => apiClient.getOpportunity(id, { cookieHeader }).catch(() => null)),
  );
  const opportunityById = new Map(opportunities.filter(Boolean).map((o) => [o!.id, o!]));

  // the spec/p.4: RFQ creation is operator-assisted this pass
  // (ADR-0008, matrix.ts) — only PLATFORM_OWNER/
  // MARKETPLACE_OPERATOR get the create affordance. The server
  // independently re-enforces via can() regardless of this UI gate.
  const canCreate = session.activeRole === "PLATFORM_OWNER" || session.activeRole === "MARKETPLACE_OPERATOR";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">RFQ Workspace</h1>
          <p className="mt-1 text-sm text-ink-2">Private requests for quote — versioned disclosure, invited providers, quote history.</p>
        </div>
        {canCreate && (
          <Link href="/app/rfqs/new" className="btn btn-go shrink-0">
            + New RFQ
          </Link>
        )}
      </div>

      <div className="panel scrollx">
        {rfqs.length === 0 ? (
          <p className="p-5 text-sm text-ink-3">No RFQs yet.</p>
        ) : (
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-edge text-left">
                <th className="mono-label px-4 py-3 font-normal">Opportunity</th>
                <th className="mono-label px-4 py-3 font-normal">Status</th>
                <th className="mono-label px-4 py-3 font-normal">Due</th>
                <th className="mono-label px-4 py-3 font-normal">Version</th>
                <th className="mono-label px-4 py-3 font-normal" />
              </tr>
            </thead>
            <tbody>
              {rfqs.map((rfq) => {
                const opportunity = opportunityById.get(rfq.opportunityId);
                return (
                  <tr key={rfq.id} className="border-b border-edge last:border-0 hover:bg-[rgba(255,80,80,0.04)]">
                    <td className="px-4 py-3">
                      <div className="text-ink">{opportunity?.requestedService ?? `Opportunity ${shortId(rfq.opportunityId)}`}</div>
                      <div className="mono-label mt-0.5">RFQ {shortId(rfq.id)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusChip status={rfq.status} />
                    </td>
                    <td className="px-4 py-3 text-ink-2">{formatDate(rfq.dueAt)}</td>
                    <td className="px-4 py-3 text-ink-2">v{rfq.currentVersionNumber}</td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/app/rfqs/${rfq.id}`} className="btn btn-ghost">
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
