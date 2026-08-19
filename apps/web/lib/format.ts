// apps/web/lib/format.ts — the spec names this file explicitly.
//
// Display-only helpers. p.12: money is integer minor units + ISO
// currency on the wire (never a float) — these functions convert THAT
// representation into a human string; they never do money ARITHMETIC
// (no rounding/summing here) — that discipline stays server-side.

/**
 * `minorUnits` arrives as a numeric STRING (opportunity/capacity's
 * BigInt-backed fields) or a plain number (JSON-embedded quote-term
 * amounts) — see packages/contracts/src/opportunity.ts's file header for
 * why the wire shape differs by field. Uses `BigInt(100)`, never a `100n`
 * literal — apps/web's tsconfig targets ES2017 (Next.js default), and
 * BigInt literal syntax requires ES2020+; the BigInt VALUE type itself
 * works fine at ES2017, only the `123n` literal SYNTAX is gated.
 */
export function formatMoneyMinor(minorUnits: string | number, currency: string): string {
  const oneHundred = BigInt(100);
  const asBigInt = typeof minorUnits === "string" ? BigInt(minorUnits) : BigInt(Math.trunc(minorUnits));
  const negative = asBigInt < BigInt(0);
  const abs = negative ? -asBigInt : asBigInt;
  const whole = abs / oneHundred;
  const cents = abs % oneHundred;
  const wholeStr = whole.toLocaleString("en-US");
  const sign = negative ? "-" : "";
  return `${sign}${currency} ${wholeStr}.${cents.toString().padStart(2, "0")}`;
}

/** Integer basis points -> a "2.85%" style string. 1 bps = 0.01%, so bps/100 = percent. */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Short, human-scannable id — the trailing segment of a UUIDv7, which is the random (not time-ordered) portion, so it stays visually distinct across rows created moments apart. */
export function shortId(id: string): string {
  return id.split("-").at(-1) ?? id;
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  READINESS_BLOCKED: "Readiness blocked",
  MATCH_READY: "Match ready",
  INVITED: "Invited",
  QUOTED: "Quoted",
  SELECTED: "Selected",
  ACTIVATING: "Activating",
  LIVE: "Live",
  CLOSED: "Closed",
  SENT: "Sent",
  ACKNOWLEDGED: "Acknowledged",
  QUESTIONS: "Questions",
  EXPIRED: "Expired",
  DECLINED: "Declined",
  SUBMITTED: "Submitted",
  WITHDRAWN: "Withdrawn",
  REJECTED: "Rejected",
  OPEN: "Open",
  CONDITIONS: "Conditions",
  APPROVED: "Approved",
  ACTIVATION: "Activation",
  ARCHIVED: "Archived",
  PENDING: "Pending",
  SATISFIED: "Satisfied",
  WAIVED: "Waived",
  // ---- earlier: Lockbox ----
  SEALED: "Sealed",
  COMMITTED: "Committed",
  FROZEN: "Frozen",
  OPENED: "Opened",
  MATCH_ELIGIBLE: "Match-eligible",
  DISPUTED: "Disputed",
  // ---- earlier: Attribution ----
  FILED: "Filed",
  SCORED: "Scored",
  PARTIAL: "Shared attribution",
  VERIFIED: "Verified",
  // ---- earlier: Passport (P6) ----
  INCOMPLETE: "Incomplete",
  READY: "Ready",
  STALE: "Stale",
  SUSPENDED: "Suspended",
  // ---- earlier: Capacity freshness (P8) — reuses the same chip vocabulary FreshnessBadge renders with dedicated tones, but also needs a plain label wherever it appears as ordinary text. ----
  FRESH: "Fresh",
  AGING: "Aging",
  UNKNOWN: "Unknown",
  // ---- earlier: Economics (P15) ----
  ACTIVE: "Active",
  SUPERSEDED: "Superseded",
  RETIRED: "Retired",
  ACCRUED: "Accrued",
  ADJUSTED: "Adjusted",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  REVERSED: "Reversed",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
