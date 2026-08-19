import type { ClaimScoreBreakdown as ClaimScoreBreakdownType } from "@tol/contracts";

/**
 * the spec's four scoring factors, rendered as explainable bars — the
 * earlier brief's own words: "see the explainable score breakdown (the
 * factor bars/values)". Every number here comes directly off the wire
 * response (packages/contracts' ClaimScoreBreakdownSchema, itself a
 * field-for-field mirror of @tol/attribution's real output) — nothing on
 * this page is computed or approximated client-side.
 */
const FACTORS: { key: "history" | "proximity" | "evidence" | "time"; label: string; weight: string; note: string }[] = [
  { key: "history", label: "History", weight: "40%", note: "Prior commercial history" },
  { key: "proximity", label: "Proximity", weight: "30%", note: "Decision-maker directness (D0–D5)" },
  { key: "evidence", label: "Evidence", weight: "20%", note: "Quality-weighted evidence sum" },
  { key: "time", label: "Time", weight: "10%", note: "Submission promptness — deliberately the lightest factor" },
];

const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  CONTRACT: "Contract",
  COUNTERPARTY_ACKNOWLEDGMENT: "Counterparty acknowledgment",
  EMAIL_THREAD: "Email / thread",
  CRM_RECORD: "CRM record",
  OTHER: "Other",
};
const VERIFICATION_LABELS: Record<string, string> = {
  SELF_REPORTED: "Self-reported",
  DOCUMENT_EXTRACTED: "Document-extracted",
  API_VERIFIED: "API-verified",
  COUNTERPARTY_CONFIRMED: "Counterparty-confirmed",
  OPERATOR_VERIFIED: "Operator-verified",
};

export function ClaimScoreBreakdown({ breakdown }: { breakdown: ClaimScoreBreakdownType }) {
  return (
    <div className="panel p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="mono-label">Score breakdown</h2>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold text-ink">{breakdown.total.toFixed(1)}</span>
          <span className="text-xs text-ink-3">/ 100</span>
        </div>
      </div>

      {breakdown.cappedFrom !== undefined && (
        <p className="mb-4 rounded-md border border-[rgba(255,36,54,0.35)] bg-[rgba(255,36,54,0.06)] px-3 py-2 text-[12.5px] leading-relaxed text-ink-2">
          Capped from {breakdown.cappedFrom.toFixed(1)} — a D0 (&ldquo;public knowledge only&rdquo;) directness tier
          creates no attribution, regardless of the other three factors (the spec/p.18 anti-squatting rule).
        </p>
      )}

      <div className="flex flex-col gap-3">
        {FACTORS.map((f) => {
          const value = breakdown[f.key];
          return (
            <div key={f.key}>
              <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
                <span className="text-ink">
                  {f.label} <span className="text-ink-3">({f.weight})</span>
                </span>
                <span className="text-ink-2">{value.toFixed(1)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-edge">
                <div className="h-full rounded-full bg-red" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
              </div>
              <p className="mt-1 text-[11px] text-ink-3">{f.note}</p>
            </div>
          );
        })}
      </div>

      {breakdown.evidenceRawTotal !== undefined && (
        <p className="mt-3 text-[11px] text-ink-3">
          Evidence factor capped at 100 (raw sum {breakdown.evidenceRawTotal.toFixed(1)}).
        </p>
      )}

      {breakdown.evidenceBreakdown.length > 0 && (
        <div className="mt-5 border-t border-edge pt-4">
          <h3 className="mono-label mb-2">Evidence contributions</h3>
          <ul className="flex flex-col gap-1.5">
            {breakdown.evidenceBreakdown.map((item) => (
              <li key={item.index} className="flex items-center justify-between gap-3 text-[12.5px]">
                <span className="text-ink-2">
                  {EVIDENCE_TYPE_LABELS[item.evidenceType] ?? item.evidenceType}
                  <span className="text-ink-3"> · {VERIFICATION_LABELS[item.verificationState] ?? item.verificationState}</span>
                </span>
                <span className="text-ink">
                  {item.basePoints} × {item.multiplier.toFixed(1)} = {item.contribution.toFixed(1)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-edge pt-3 text-[11px] text-ink-3">
        <span>algorithm {breakdown.algorithmVersion}</span>
        {breakdown.inputVersions.length > 0 && <span>inputs {breakdown.inputVersions.join(", ")}</span>}
      </div>
    </div>
  );
}
