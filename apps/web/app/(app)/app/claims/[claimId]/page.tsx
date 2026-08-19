import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient, ApiError } from "@/lib/api-client";
import { StatusChip } from "@/components/shared/StatusChip";
import { ClaimScoreBreakdown } from "@/components/claims/ClaimScoreBreakdown";
import { ClaimActions } from "@/components/claims/ClaimActions";
import { formatDateTime, shortId } from "@/lib/format";

// Next.js 16: dynamic-route `params` is a Promise — see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md
interface Props {
  params: Promise<{ claimId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { claimId } = await params;
  return { title: `Claim ${shortId(claimId)} — TOL` };
}

const DECIDER_ROLES = new Set(["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "PARTNERSHIP_LEAD", "COMPLIANCE_REVIEWER"]);
const CLAIMANT_ROLES = new Set(["CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER", "ACQUIRER_PROVIDER_USER", "PLATFORM_OWNER"]);
const DISPUTABLE_FROM = new Set(["SCORED", "VERIFIED", "PARTIAL"]);
const DECIDABLE_FROM = new Set(["SCORED", "DISPUTED"]);

/** the spec: "/app/claims/[claimId]" is not a named scope route (only the list `/app/claims` is), but every other earlier phases list screen in this codebase has a matching detail route — same pattern applied here. P10 gate exit condition: "Claim scoring + dispute path." */
export default async function ClaimDetailPage({ params }: Props) {
  const { claimId } = await params;
  const session = await getServerSession();
  if (!session) throw new Error("ClaimDetailPage rendered without a session — AppLayout's guard should prevent this.");

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  let detail;
  try {
    detail = await apiClient.getClaim(claimId, { cookieHeader });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      return (
        <div className="panel p-6">
          <p className="field-error">{err.problem.message}</p>
        </div>
      );
    }
    throw err;
  }

  const { claim, evidence, decisions, disputes, rank } = detail;
  const isOwnClaim = session.activeOrganizationId !== null && session.activeOrganizationId === claim.claimantOrgId;
  const hasOpenDispute = disputes.some((d) => d.status === "OPEN");

  // Mirrors packages/authz's matrix.ts + apps/api's service-layer
  // self-certification guard — apps/api re-enforces both regardless of
  // what renders here (same "server decides, UI reflects" discipline as
  // every other earlier phases detail page).
  const canDispute =
    !isOwnClaim &&
    CLAIMANT_ROLES.has(session.activeRole ?? "") &&
    DISPUTABLE_FROM.has(claim.status) &&
    !hasOpenDispute;
  const canDecide = !isOwnClaim && DECIDER_ROLES.has(session.activeRole ?? "") && DECIDABLE_FROM.has(claim.status);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mono-label mb-2">Claim {shortId(claim.id)}</div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-ink">{claim.relationshipType}</h1>
          <StatusChip status={claim.status} />
          <span className="chip chip-neutral">{claim.directnessTier}</span>
        </div>
        <p className="mt-1 text-sm text-ink-2">
          Subject: {shortId(claim.subjectOrgId)} · Claimant: {shortId(claim.claimantOrgId)} · Filed {formatDateTime(claim.createdAt)}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {claim.scoreBreakdown ? (
            <ClaimScoreBreakdown breakdown={claim.scoreBreakdown} />
          ) : (
            <div className="panel p-5">
              <p className="text-sm text-ink-3">Not yet scored.</p>
            </div>
          )}

          <div className="panel p-5">
            <h2 className="mono-label mb-3">Evidence ({evidence.length})</h2>
            {evidence.length === 0 ? (
              <p className="text-sm text-ink-3">No evidence submitted with this claim.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {evidence.map((item) => (
                  <li key={item.id} className="rounded-md border border-edge px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="chip chip-neutral">{item.evidenceType}</span>
                      <span className="mono-label">{item.verificationState}</span>
                    </div>
                    <p className="mt-1.5 text-ink-2">{item.assertedFact}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel p-5">
            <h2 className="mono-label mb-3">Decision timeline ({decisions.length})</h2>
            {decisions.length === 0 ? (
              <p className="text-sm text-ink-3">No decision recorded yet.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {decisions.map((d) => (
                  <li key={d.id} className="rounded-md border border-edge px-3 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <StatusChip status={d.decision} />
                      <span className="mono-label">{formatDateTime(d.createdAt)}</span>
                    </div>
                    <p className="mt-1.5 text-ink-2">{d.reason}</p>
                    <p className="mt-1 text-[11px] text-ink-3">
                      Reviewer org {shortId(d.reviewerOrgId)} · rule {d.ruleVersion}
                      {d.disputeId && " · resolves a dispute"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {disputes.length > 0 && (
            <div className="panel p-5">
              <h2 className="mono-label mb-3">Disputes ({disputes.length})</h2>
              <ul className="flex flex-col gap-3">
                {disputes.map((d) => (
                  <li key={d.id} className="rounded-md border border-edge px-3 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <StatusChip status={d.status} />
                      {d.resolution && <span className="chip chip-neutral">{d.resolution}</span>}
                    </div>
                    <p className="mt-1.5 text-ink-2">{d.basis}</p>
                    <p className="mt-1 text-[11px] text-ink-3">Challenger org {shortId(d.challengerOrgId)}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-6">
          {rank && (
            <div className="panel p-5">
              <h2 className="mono-label mb-3">Ranking (reviewer view)</h2>
              <p className="text-sm text-ink">
                Rank #{rank.rank}
                {rank.tiedWith.length > 0 && <span className="text-ink-3"> (tied with {rank.tiedWith.length} other claim(s))</span>}
              </p>
              <p className="mt-1 text-[11px] text-ink-3">
                Scoring ranks competing claims for operator review; it does not automatically rewrite
                pre-existing legal rights (the spec).
              </p>
            </div>
          )}

          <div className="panel p-5">
            <h2 className="mono-label mb-3">Scope</h2>
            <dl className="divide-y divide-edge text-sm">
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-ink-3">Prior history</dt>
                <dd className="text-right text-ink">{claim.priorCommercialHistoryMonths} mo</dd>
              </div>
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-ink-3">Submission lag</dt>
                <dd className="text-right text-ink">{claim.submissionLagDays} d</dd>
              </div>
              {claim.opportunityId && (
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-ink-3">Opportunity</dt>
                  <dd className="text-right text-ink">{shortId(claim.opportunityId)}</dd>
                </div>
              )}
              {claim.claimScope.geography && (
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-ink-3">Geography</dt>
                  <dd className="text-right text-ink">{claim.claimScope.geography}</dd>
                </div>
              )}
              {claim.provisionalExpiresAt && (
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-ink-3">Provisional until</dt>
                  <dd className="text-right text-ink">{formatDateTime(claim.provisionalExpiresAt)}</dd>
                </div>
              )}
            </dl>
          </div>

          <ClaimActions claimId={claim.id} canDispute={canDispute} canDecide={canDecide} hasOpenDispute={hasOpenDispute} />
        </div>
      </div>
    </div>
  );
}
