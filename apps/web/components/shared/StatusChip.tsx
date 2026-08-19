import { statusLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * One status vocabulary spans Opportunity/RFQ/Quote/DealRoom/
 * DealCondition — this maps every value this repo's earlier state
 * machines produce (@tol/domain) onto the theme's existing chip classes
 * (globals.css: chip-ok/chip-warn/chip-red/chip-neutral — ported from
 * the prototype, earlier). No new colors invented; "final/good" states use
 * chip-ok, "blocked/negative" states use chip-red, "in motion" states
 * use chip-warn, everything else (early/neutral) uses chip-neutral.
 */
// earlier: SEALED/OPENED join GOOD (a successfully sealed or successfully,
// authorizedly released Lockbox — both intended, positive end states of
// their respective sub-flows, same reasoning as SELECTED/APPROVED
// already being GOOD). COMMITTED/FROZEN join IN_MOTION (intermediate
// release-cascade hops, same category as CONDITIONS/PENDING/OPEN).
// DISPUTED joins BAD (matches REJECTED/DECLINED's "needs attention"
// framing). WITHDRAWN was already BAD from earlier/the Quote/RFQ
// usage — the same value, same meaning, for Lockbox too.
// earlier: PARTIAL joins GOOD — the spec's "shared attribution is
// allowed... do not force a false single winner" makes PARTIAL a
// legitimate, intended outcome, not a lesser/failed one (same reasoning
// SATISFIED/APPROVED already got). FILED/SCORED join IN_MOTION — a claim
// awaiting its scoring hop or awaiting a reviewer's decision, same
// category as PENDING/OPEN's "in progress, no verdict yet" framing.
// earlier: VERIFIED already covers Passport's own terminal-good state
// (reused, same value both earlier phases use). READY joins IN_MOTION — no
// blockers left, but still awaiting reviewer verification, same
// "ball's in someone else's court" framing as QUOTED/SENT. INCOMPLETE
// and STALE join BAD — both mean "needs attention before this can
// progress," same category as READINESS_BLOCKED/DISPUTED. SUSPENDED
// joins BAD too — an active compliance hold, same "needs attention"
// framing as REJECTED/DECLINED (not a permanent-failure state the way
// those are, but visually the same "stop and look at this" signal).
// DRAFT is deliberately in NEITHER set — falls through to chip-neutral,
// matching every other "just started, nothing to flag yet" state.
// earlier: SUPERSEDED and RETIRED join DRAFT in neither set — both are
// normal, deliberate, expected parts of a CommissionSchedule's own
// version lifecycle (a superseded schedule isn't a failure, it's the
// documented, correct effect of "changing a schedule creates a new
// version," the spec), not a positive OR negative signal to flag.
const GOOD = new Set(["SELECTED", "LIVE", "APPROVED", "SATISFIED", "ACTIVE", "VERIFIED", "SEALED", "OPENED", "PARTIAL", "PAID"]);
const BAD = new Set(["DECLINED", "REJECTED", "EXPIRED", "WITHDRAWN", "CLOSED", "READINESS_BLOCKED", "DISPUTED", "INCOMPLETE", "STALE", "SUSPENDED", "REVERSED"]);
const IN_MOTION = new Set([
  "QUOTED",
  "SENT",
  "INVITED",
  "ACKNOWLEDGED",
  "QUESTIONS",
  "CONDITIONS",
  "PENDING",
  "ACTIVATING",
  "OPEN",
  "COMMITTED",
  "FROZEN",
  "FILED",
  "SCORED",
  "READY",
  // earlier: an accrual awaiting further resolution — same "in progress,
  // no verdict yet" framing as PENDING/OPEN.
  "ACCRUED",
  "ADJUSTED",
  "PARTIALLY_PAID",
]);

export function StatusChip({ status, className }: { status: string; className?: string }) {
  const variant = GOOD.has(status) ? "chip-ok" : BAD.has(status) ? "chip-red" : IN_MOTION.has(status) ? "chip-warn" : "chip-neutral";
  return <span className={cn("chip", variant, className)}>{statusLabel(status)}</span>;
}
