import type { RuleResultDTO } from "@tol/contracts";
import { cn } from "@/lib/utils";

// apps/web/components/matching/MatchRuleTrace.tsx — the spec (P11
// Eligibility). Renders the FULL per-rule trace's blocking/non-blocking
// subsets (`blockers`/`warnings` — mapper-derived from @tol/matching's
// real `results` array, never re-derived client-side) as explainable
// rows: which of the ten rule families fired, its status, and why — same
// "show exactly what blocks it" discipline as ReadinessMeter.tsx, just
// keyed to the matching engine's own RuleResult shape rather than
// ReadinessResult's fieldKey/sectionType shape.

const RULE_FAMILY_LABELS: Record<string, string> = {
  ROLE: "Role",
  JURISDICTION: "Jurisdiction",
  MCC_PRODUCT: "MCC / product",
  VOLUME_TICKET: "Volume / ticket",
  EVIDENCE_LICENSE: "Evidence & license",
  RISK: "Risk",
  SETTLEMENT: "Settlement",
  TECHNICAL: "Technical",
  FRESHNESS: "Freshness",
  COMPLIANCE_HOLD: "Compliance hold",
};

const STATUS_TONE: Record<string, string> = {
  PASS: "chip-ok",
  INELIGIBLE: "chip-red",
  BLOCKED: "chip-red",
  REFRESH_REQUIRED: "chip-warn",
  UNKNOWN: "chip-neutral",
};

function RuleRow({ result }: { result: RuleResultDTO }) {
  return (
    <li className="flex items-start gap-2 text-[12.5px]">
      <span className={cn("chip shrink-0", STATUS_TONE[result.status] ?? "chip-neutral")}>
        {RULE_FAMILY_LABELS[result.rule] ?? result.rule}
      </span>
      <span className="flex-1 text-ink-2">
        {result.message}
        {result.overridable && <span className="ml-1.5 text-ink-3">(overridable)</span>}
      </span>
    </li>
  );
}

export function MatchRuleTrace({ blockers, warnings }: { blockers: RuleResultDTO[]; warnings: RuleResultDTO[] }) {
  if (blockers.length === 0 && warnings.length === 0) {
    return <p className="text-[12.5px] text-ink-3">No blockers or warnings — every rule passed cleanly.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {blockers.length > 0 && (
        <div>
          <h3 className="mono-label mb-2 text-red">Blocking ({blockers.length})</h3>
          <ul className="flex flex-col gap-2">
            {blockers.map((r, i) => (
              <RuleRow key={`${r.rule}-${r.code}-${i}`} result={r} />
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className={blockers.length > 0 ? "border-t border-edge pt-3" : undefined}>
          <h3 className="mono-label mb-2">Warnings ({warnings.length})</h3>
          <ul className="flex flex-col gap-2">
            {warnings.map((r, i) => (
              <RuleRow key={`${r.rule}-${r.code}-${i}`} result={r} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
