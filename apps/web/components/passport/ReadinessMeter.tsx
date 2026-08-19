// apps/web/components/passport/ReadinessMeter.tsx — the spec/p.29:
// "Passport: user can see exactly what blocks readiness and which
// evidence will cure it." Every number/blocker/warning here comes
// directly off the wire response (@tol/contracts' ReadinessResultDTO,
// itself a field-for-field mirror of @tol/evidence's real
// computeReadiness() output) — nothing on this page is computed or
// approximated client-side, same discipline as ClaimScoreBreakdown.tsx.

import type { ReadinessResultDTO } from "@tol/contracts";

const SECTION_LABELS: Record<string, string> = {
  IDENTITY: "Identity",
  RELATIONSHIP_HISTORY: "Relationship history",
  PROCESSING_METRICS: "Processing metrics",
  RISK: "Risk",
  COMMERCIAL: "Commercial",
  TECHNICAL: "Technical",
};

export function ReadinessMeter({ readiness }: { readiness: ReadinessResultDTO | null }) {
  if (!readiness) {
    return (
      <div className="panel p-5">
        <p className="text-sm text-ink-3">No readiness computed yet.</p>
      </div>
    );
  }

  return (
    <div className="panel p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="mono-label">Readiness</h2>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold text-ink">{readiness.score.toFixed(0)}</span>
          <span className="text-xs text-ink-3">%</span>
        </div>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-edge">
        <div
          className={readiness.blockers.length > 0 ? "h-full rounded-full bg-red" : "h-full rounded-full bg-[var(--color-ok)]"}
          style={{ width: `${Math.max(0, Math.min(100, readiness.score))}%` }}
        />
      </div>

      {readiness.blockers.length > 0 ? (
        <div className="mt-5 border-t border-edge pt-4">
          <h3 className="mono-label mb-2 text-red">Blocking readiness ({readiness.blockers.length})</h3>
          <ul className="flex flex-col gap-2">
            {readiness.blockers.map((b, i) => (
              <li key={`${b.fieldKey}-${i}`} className="flex items-start gap-2 text-[12.5px]">
                <span className="chip chip-red shrink-0">{SECTION_LABELS[b.sectionType] ?? b.sectionType}</span>
                <span className="text-ink-2">{b.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-5 border-t border-edge pt-4 text-[12.5px] text-ink-2">
          No blockers — every required fact is present and current.
        </p>
      )}

      {readiness.warnings.length > 0 && (
        <div className="mt-4 border-t border-edge pt-4">
          <h3 className="mono-label mb-2">Warnings ({readiness.warnings.length})</h3>
          <ul className="flex flex-col gap-2">
            {readiness.warnings.map((w, i) => (
              <li key={`${w.fieldKey}-${i}`} className="flex items-start gap-2 text-[12.5px]">
                <span className="chip chip-warn shrink-0">{SECTION_LABELS[w.sectionType] ?? w.sectionType}</span>
                <span className="text-ink-2">{w.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-edge pt-3 text-[11px] text-ink-3">
        <span>algorithm {readiness.algorithmVersion}</span>
        <span>rules {readiness.ruleVersion}</span>
      </div>
    </div>
  );
}
