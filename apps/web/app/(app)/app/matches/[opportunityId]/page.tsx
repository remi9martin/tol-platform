import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient, ApiError } from "@/lib/api-client";
import { StatusChip } from "@/components/shared/StatusChip";
import { MatchFactorBreakdown } from "@/components/matching/MatchFactorBreakdown";
import { MatchRuleTrace } from "@/components/matching/MatchRuleTrace";
import { EvaluateMatchesButton } from "@/components/matching/EvaluateMatchesButton";
import { formatDateTime, shortId } from "@/lib/format";

// Next.js 16: dynamic-route `params` is a Promise — see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md
interface Props {
  params: Promise<{ opportunityId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { opportunityId } = await params;
  return { title: `Matches for ${shortId(opportunityId)} — TOL` };
}

/** Mirrors packages/authz's matrix.ts matching.evaluate grant exactly — PLATFORM_OWNER + MARKETPLACE_OPERATOR only ("operator triggers, merchant/provider views" per that file's own comments on every other role's omission). apps/api's can() re-enforces this regardless of what renders here. */
const EVALUATE_ROLES = new Set(["PLATFORM_OWNER", "MARKETPLACE_OPERATOR"]);

/**
 * the spec: "/app/matches/[opportunityId]" verbatim. P11/P12 gate exit
 * condition: eligibility runs first (blockers/warnings, full per-rule
 * trace), ranking only over the eligible subset (9-factor explainable
 * breakdown) — see @tol/matching's own rankMatches()/evaluateEligibility()
 * and this same "eligibility gates ranking" invariant enforced
 * structurally all the way down (packages/matching's pure engine order,
 * matchResultRepository.create's bidirectional guard, and here: eligible
 * rows render MatchFactorBreakdown, ineligible rows render
 * MatchRuleTrace's blockers — never both, never neither).
 */
export default async function MatchesDetailPage({ params }: Props) {
  const { opportunityId } = await params;
  const session = await getServerSession();
  if (!session) throw new Error("MatchesDetailPage rendered without a session — AppLayout's guard should prevent this.");

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  let opportunity;
  let matches;
  try {
    const [opp, matchList] = await Promise.all([
      apiClient.getOpportunity(opportunityId, { cookieHeader }),
      apiClient.listMatches(opportunityId, { cookieHeader }),
    ]);
    opportunity = opp;
    matches = matchList.matches;
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

  const eligible = [...matches.filter((m) => m.eligible)].sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
  const ineligible = matches.filter((m) => !m.eligible);
  const canEvaluate = EVALUATE_ROLES.has(session.activeRole ?? "");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mono-label mb-2">P11 / P12 · Matches for opportunity {shortId(opportunity.id)}</div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-ink">{opportunity.requestedService}</h1>
          <StatusChip status={opportunity.status} />
          <span className="chip chip-neutral">{opportunity.opportunityType}</span>
        </div>
        <p className="mt-1 text-sm text-ink-2">
          {opportunity.jurisdictions.join(", ") || "—"} · {opportunity.mccs.join(", ") || "—"} · {opportunity.currency}
        </p>
      </div>

      {canEvaluate && <EvaluateMatchesButton opportunityId={opportunity.id} />}

      {matches.length === 0 ? (
        <div className="panel p-6">
          <p className="text-sm text-ink-3">
            No matching run yet for this opportunity.{" "}
            {canEvaluate
              ? "Run matching above to evaluate every active candidate capacity."
              : "An operator has not run matching for this opportunity yet."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div>
            <h2 className="mono-label mb-3">Eligible, ranked ({eligible.length})</h2>
            {eligible.length === 0 ? (
              <div className="panel p-5">
                <p className="text-sm text-ink-3">No eligible candidates in the latest run.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {eligible.map((m) => (
                  <div key={m.id} className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="chip chip-ok">#{m.rank}</span>
                        <span className="mono-label">Capacity {shortId(m.capacityId)}</span>
                        {m.warnings.length > 0 && <span className="chip chip-warn">{m.warnings.length} warning(s)</span>}
                      </div>
                      <span className="text-[11px] text-ink-3">evaluated {formatDateTime(m.evaluatedAt)}</span>
                    </div>
                    {m.rankingBreakdown && <MatchFactorBreakdown breakdown={m.rankingBreakdown} />}
                    {m.warnings.length > 0 && (
                      <div className="panel p-5">
                        <h3 className="mono-label mb-2">Warnings</h3>
                        <MatchRuleTrace blockers={[]} warnings={m.warnings} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h2 className="mono-label mb-3">Ineligible ({ineligible.length})</h2>
            {ineligible.length === 0 ? (
              <div className="panel p-5">
                <p className="text-sm text-ink-3">No ineligible candidates in the latest run.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {ineligible.map((m) => (
                  <div key={m.id} className="panel p-5">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                      <span className="mono-label">Capacity {shortId(m.capacityId)}</span>
                      <span className="text-[11px] text-ink-3">evaluated {formatDateTime(m.evaluatedAt)}</span>
                    </div>
                    <MatchRuleTrace blockers={m.blockers} warnings={m.warnings} />
                    <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-edge pt-3 text-[11px] text-ink-3">
                      <span>rules {m.ruleVersion}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
