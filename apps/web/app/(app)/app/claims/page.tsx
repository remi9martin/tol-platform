import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient } from "@/lib/api-client";
import { StatusChip } from "@/components/shared/StatusChip";
import { formatDate, shortId } from "@/lib/format";

export const metadata: Metadata = { title: "Attribution Claims — TOL" };

/**
 * the spec: "/app/claims — Attribution Claims — Relationship provenance,
 * verification, disputes." P10 gate exit condition: "Claim scoring +
 * dispute path." apps/api's own service already scopes the returned list
 * correctly per persona (own claims for claimant-side roles, every claim
 * for reviewer-tier roles) — this page renders whatever comes back
 * without re-deriving that split client-side.
 */
export default async function ClaimsListPage() {
  const session = await getServerSession();
  if (!session) throw new Error("ClaimsListPage rendered without a session — AppLayout's guard should prevent this.");

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  const { claims } = await apiClient.listClaims({ cookieHeader });

  // the spec Journey A ("Contributor creates a RelationshipClaim") +
  // the spec anti-squatting rule (Platform can seed its own claims) —
  // matches packages/authz's matrix.ts claim.create grant exactly.
  const canCreate =
    session.activeRole === "CONTRIBUTOR_AGENT" ||
    session.activeRole === "MERCHANT_PSP_USER" ||
    session.activeRole === "ACQUIRER_PROVIDER_USER" ||
    session.activeRole === "PLATFORM_OWNER";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="mono-label mb-2">P10 · Attribution</div>
          <h1 className="text-2xl font-semibold text-ink">Attribution Claims</h1>
          <p className="mt-1 max-w-[62ch] text-sm text-ink-2">
            Relationship provenance, scored on HISTORY, PROXIMITY, EVIDENCE and TIME — never
            &ldquo;first to type a public company name.&rdquo; Scoring ranks competing claims for
            operator review; it does not automatically rewrite pre-existing legal rights.
          </p>
        </div>
        {canCreate && (
          <Link href="/app/claims/new" className="btn btn-go shrink-0">
            + File a claim
          </Link>
        )}
      </div>

      <div className="panel scrollx">
        {claims.length === 0 ? (
          <p className="p-5 text-sm text-ink-3">No claims yet.</p>
        ) : (
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-edge text-left">
                <th className="mono-label px-4 py-3 font-normal">Subject org</th>
                <th className="mono-label px-4 py-3 font-normal">Relationship</th>
                <th className="mono-label px-4 py-3 font-normal">Directness</th>
                <th className="mono-label px-4 py-3 font-normal">Status</th>
                <th className="mono-label px-4 py-3 font-normal">Score</th>
                <th className="mono-label px-4 py-3 font-normal">Filed</th>
                <th className="mono-label px-4 py-3 font-normal" />
              </tr>
            </thead>
            <tbody>
              {claims.map((claim) => (
                <tr key={claim.id} className="border-b border-edge last:border-0 hover:bg-[rgba(255,80,80,0.04)]">
                  <td className="px-4 py-3">
                    <div className="text-ink">{shortId(claim.subjectOrgId)}</div>
                    <div className="mono-label mt-0.5">Claim {shortId(claim.id)}</div>
                  </td>
                  <td className="px-4 py-3 text-ink-2">{claim.relationshipType}</td>
                  <td className="px-4 py-3">
                    <span className="chip chip-neutral">{claim.directnessTier}</span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusChip status={claim.status} />
                  </td>
                  <td className="px-4 py-3 text-ink-2">{claim.scoreTotal !== null ? claim.scoreTotal.toFixed(1) : "—"}</td>
                  <td className="px-4 py-3 text-ink-2">{formatDate(claim.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/app/claims/${claim.id}`} className="btn btn-ghost">
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
