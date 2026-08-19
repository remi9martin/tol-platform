import type { CommissionScheduleDetailDTO } from "@tol/contracts";
import { StatusChip } from "@/components/shared/StatusChip";
import { formatBps, formatMoneyMinor, shortId } from "@/lib/format";

// apps/web/components/economics/ScheduleSummary.tsx — the spec's
// EconomicSchedule + EconomicComponent, rendered as-is off the wire (the
// real @tol/domain-computed/persisted split), never re-derived
// client-side. A PERCENTAGE_BPS component's `bps` renders via the same
// formatBps helper Quote/CapacityProfile already use; a FIXED_AMOUNT
// component renders via formatMoneyMinor — same "money never touched
// client-side except for display" discipline as every other page in
// this codebase.

const RECIPIENT_LABELS: Record<string, string> = { CONTRIBUTOR: "Contributor", PLATFORM: "Platform", OTHER: "Other" };
const BASIS_LABELS: Record<string, string> = {
  GROSS_PROCESSING_VOLUME: "Gross processing volume",
  NET_PLATFORM_REVENUE: "Net platform revenue",
  RECEIVED_COMMISSION: "Received commission",
  FIXED_FEE: "Fixed fee",
  SETUP_FEE: "Setup fee",
  OTHER: "Other",
};

export function ScheduleSummary({ schedule, currency }: { schedule: CommissionScheduleDetailDTO; currency: string }) {
  return (
    <div className="panel p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="mono-label">Schedule v{schedule.versionNumber}</h2>
          <StatusChip status={schedule.status} />
        </div>
        <span className="text-[11px] text-ink-3">{BASIS_LABELS[schedule.basis] ?? schedule.basis}</span>
      </div>
      {schedule.description && <p className="mb-3 text-sm text-ink-2">{schedule.description}</p>}

      <div className="flex flex-col gap-2">
        {schedule.components
          .slice()
          .sort((a, b) => a.priority - b.priority)
          .map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3 rounded-md border border-edge px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="text-ink">
                  {RECIPIENT_LABELS[c.recipientType] ?? c.recipientType} <span className="text-ink-3">· {shortId(c.recipientOrgId)}</span>
                </div>
                {c.claimId && <div className="mono-label mt-0.5">justified by claim {shortId(c.claimId)}</div>}
              </div>
              <div className="shrink-0 text-right text-ink">
                {c.componentType === "PERCENTAGE_BPS" ? formatBps(c.bps ?? 0) : formatMoneyMinor(c.fixedAmountMinor ?? "0", currency)}
              </div>
            </div>
          ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge pt-3 text-[11px] text-ink-3">
        {schedule.capMinor && <span>cap {formatMoneyMinor(schedule.capMinor, currency)}</span>}
        {schedule.floorMinor && <span>floor {formatMoneyMinor(schedule.floorMinor, currency)}</span>}
        {schedule.survivalMonths != null && <span>survives {schedule.survivalMonths}mo post-deal</span>}
        <span>schedule {shortId(schedule.id)}</span>
      </div>

      {/* Follow-up fix: DISCLOSURE, not enforcement — the server
          never blocks or truncates a split because of a cap (see
          @tol/domain's evaluateScheduleCapFloor doc comment), so this is
          the one place a Finance Operator actually sees whether this
          schedule's real, cumulative distributed total has run past its
          own cap or hasn't yet reached its own floor. Rendered only when
          there is something to disclose (capFloorStatus is null when the
          schedule carries neither field, and each chip only appears when
          that specific bound is actually breached) — no noise on the
          common, healthy case. */}
      {schedule.capFloorStatus && (schedule.capFloorStatus.capExceededByMinor !== null || schedule.capFloorStatus.floorShortfallMinor !== null) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {schedule.capFloorStatus.capExceededByMinor !== null && (
            <span className="chip chip-red">over cap by {formatMoneyMinor(schedule.capFloorStatus.capExceededByMinor, currency)}</span>
          )}
          {schedule.capFloorStatus.floorShortfallMinor !== null && (
            <span className="chip chip-warn">{formatMoneyMinor(schedule.capFloorStatus.floorShortfallMinor, currency)} short of floor</span>
          )}
        </div>
      )}
    </div>
  );
}
