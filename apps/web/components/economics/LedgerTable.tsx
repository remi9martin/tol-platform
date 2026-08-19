import type { AccrualDTO } from "@tol/contracts";
import { StatusChip } from "@/components/shared/StatusChip";
import { formatDateTime, formatMoneyMinor, shortId } from "@/lib/format";

// apps/web/components/economics/LedgerTable.tsx — THE traceable ledger
// P15's exit condition names. One block per logical accrual
// (accrualRootId): its real, @tol/domain-computed balance (never a
// client-recomputed one) plus the FULL append-only entry chain that
// produced it — every entry's provenance (schedule/component/claim/
// revenue event) rendered directly off the wire, so a viewer can trace
// any number back to why it exists without leaving this page.

const ENTRY_TYPE_LABELS: Record<string, string> = { ACCRUAL: "Accrual", ADJUSTMENT: "Adjustment", PAYMENT: "Payment", REVERSAL: "Reversal" };

export function LedgerTable({ accruals, currency }: { accruals: AccrualDTO[]; currency: string }) {
  if (accruals.length === 0) {
    return (
      <div className="panel p-6">
        <p className="text-sm text-ink-3">No ledger entries yet — record a revenue event above to compute the first split.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {accruals.map((a) => (
        <div key={a.accrualRootId} className="panel p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="mono-label">Recipient {shortId(a.recipientOrgId)}</span>
              <StatusChip status={a.balance.status} />
              {a.claimId && <span className="chip chip-neutral">claim {shortId(a.claimId)}</span>}
            </div>
            <span className="text-[11px] text-ink-3">accrual {shortId(a.accrualRootId)}</span>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Original" value={formatMoneyMinor(a.balance.originalAmountMinor, currency)} />
            <Stat label="Net (after adjustments)" value={formatMoneyMinor(a.balance.netAmountMinor, currency)} />
            <Stat label="Paid" value={formatMoneyMinor(a.balance.paidAmountMinor, currency)} />
            <Stat label="Outstanding" value={formatMoneyMinor(a.balance.outstandingAmountMinor, currency)} emphasize />
          </div>

          <h3 className="mono-label mb-2">Entry history (append-only, oldest first)</h3>
          <div className="scrollx">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-edge text-left">
                  <th className="mono-label px-3 py-2 font-normal">Type</th>
                  <th className="mono-label px-3 py-2 font-normal">Amount</th>
                  <th className="mono-label px-3 py-2 font-normal">Provenance</th>
                  <th className="mono-label px-3 py-2 font-normal">Computed</th>
                </tr>
              </thead>
              <tbody>
                {a.entries.map((e) => (
                  <tr key={e.id} className="border-b border-edge last:border-0">
                    <td className="px-3 py-2">
                      <span className="chip chip-neutral">{ENTRY_TYPE_LABELS[e.entryType] ?? e.entryType}</span>
                      <span className="ml-1 text-[11px] text-ink-3">{e.direction}</span>
                    </td>
                    <td className="px-3 py-2 text-ink">{formatMoneyMinor(e.amountMinor, e.currency)}</td>
                    <td className="px-3 py-2">
                      <div className="mono-label">
                        schedule v{e.scheduleVersion} · component {shortId(e.componentId)}
                        {e.paymentId && <> · payment {shortId(e.paymentId)}</>}
                      </div>
                      {e.reason && <div className="mt-0.5 text-[12px] text-ink-2">{e.reason}</div>}
                      {e.inputVersions.length > 0 && <div className="mt-0.5 text-[10px] text-ink-3">{e.inputVersions.join(", ")}</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-[11px] text-ink-3">{formatDateTime(e.computedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div>
      <div className="mono-label">{label}</div>
      <div className={emphasize ? "text-base font-semibold text-ink" : "text-sm text-ink-2"}>{value}</div>
    </div>
  );
}
