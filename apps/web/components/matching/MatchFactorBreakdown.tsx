import type { MatchRankingBreakdownDTO } from "@tol/contracts";

// apps/web/components/matching/MatchFactorBreakdown.tsx — the spec (P12
// Ranking). Nine factors, rendered as explainable bars — same
// explainability discipline as ClaimScoreBreakdown.tsx, but DATA-DRIVEN
// over `breakdown.factors` rather than a hardcoded 4-entry array: the
// factor list itself is wire data (packages/contracts' own
// RankingFactorContributionDTOSchema), not markup, so a config/weight
// change on the server (packages/matching's MATCHING_CONFIG) never
// requires a matching edit here. FACTOR_LABELS only supplies a display
// label; every number (score/weight/contribution/note) comes straight
// off the wire response, itself a field-for-field mirror of
// @tol/matching's real scoreMatch() output — nothing here is computed or
// approximated client-side.

const FACTOR_LABELS: Record<string, string> = {
  mccProductFit: "MCC / product fit",
  geographyLicensingFit: "Geography / licensing fit",
  volumeTicketFit: "Volume & ticket fit",
  riskHistoryFit: "Risk history fit",
  settlementCurrencyFit: "Settlement currency fit",
  commercialUtility: "Commercial utility",
  technicalLaunchFit: "Technical launch fit",
  providerReliabilityFreshness: "Provider reliability / freshness",
  outcomeCalibratedLikelihood: "Outcome-calibrated likelihood",
};

export function MatchFactorBreakdown({ breakdown }: { breakdown: MatchRankingBreakdownDTO }) {
  return (
    <div className="panel p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="mono-label">Ranking breakdown</h2>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold text-ink">{breakdown.total.toFixed(1)}</span>
          <span className="text-xs text-ink-3">/ 100</span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {breakdown.factors.map((f) => (
          <div key={f.factor}>
            <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
              <span className="text-ink">
                {FACTOR_LABELS[f.factor] ?? f.factor} <span className="text-ink-3">({(f.weight * 100).toFixed(0)}%)</span>
              </span>
              <span className="text-ink-2">{f.score.toFixed(1)}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-edge">
              <div className="h-full rounded-full bg-red" style={{ width: `${Math.max(0, Math.min(100, f.score))}%` }} />
            </div>
            <p className="mt-1 text-[11px] text-ink-3">
              {f.note} <span className="text-ink-3">· contributes {f.contribution.toFixed(1)}</span>
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-edge pt-3 text-[11px] text-ink-3">
        <span>algorithm {breakdown.algorithmVersion}</span>
        {breakdown.inputVersions.length > 0 && <span>inputs {breakdown.inputVersions.join(", ")}</span>}
      </div>
    </div>
  );
}
