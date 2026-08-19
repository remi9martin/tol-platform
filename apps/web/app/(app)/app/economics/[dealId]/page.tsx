import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient, ApiError } from "@/lib/api-client";
import { StatusChip } from "@/components/shared/StatusChip";
import { ScheduleSummary } from "@/components/economics/ScheduleSummary";
import { LedgerTable } from "@/components/economics/LedgerTable";
import { RecordRevenueEventForm } from "@/components/economics/RecordRevenueEventForm";
import { CreateScheduleForm } from "@/components/economics/CreateScheduleForm";
import { formatMoneyMinor, shortId } from "@/lib/format";
import type { AccrualDTO, CommissionScheduleDetailDTO, RevenueEventDTO } from "@tol/contracts";

interface Props {
  params: Promise<{ dealId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { dealId } = await params;
  return { title: `Economics for ${shortId(dealId)} — TOL` };
}

/** Roles packages/authz/src/matrix.ts grants schedule.manage — PLATFORM_OWNER only ("no rate editing without authority", p.4). */
const CAN_MANAGE_SCHEDULE = new Set(["PLATFORM_OWNER"]);
/** Roles granted economics.record — the "engage economics" action. */
const CAN_RECORD_REVENUE = new Set(["PLATFORM_OWNER", "FINANCE_OPERATOR"]);

/**
 * the spec: "/app/economics" — this build's own dynamic per-deal
 * extension (see the list page's own header comment). Every fetch below
 * is independently try/caught: packages/authz's earlier design means
 * DIFFERENT roles legitimately get 403 on DIFFERENT sub-resources for
 * the SAME deal (a contributor/provider sees its own ledger entries but
 * gets 403 on schedules/revenue-events; the deal's own merchant gets a
 * clean 403 on the ledger specifically — the P15 privacy proof, live —
 * while still reading schedules/revenue-events fine) — this page renders
 * whatever the real API actually returns for the signed-in actor, never
 * pre-filtering based on an assumed role.
 */
export default async function EconomicsDetailPage({ params }: Props) {
  const { dealId } = await params;
  const session = await getServerSession();
  if (!session) throw new Error("EconomicsDetailPage rendered without a session — AppLayout's guard should prevent this.");

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  let deal;
  try {
    deal = await apiClient.getDeal(dealId, { cookieHeader });
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

  let schedules: CommissionScheduleDetailDTO[] = [];
  let schedulesForbidden = false;
  try {
    schedules = (await apiClient.listSchedules(dealId, { cookieHeader })).schedules;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) schedulesForbidden = true;
    else if (!(err instanceof ApiError && err.status === 404)) throw err;
  }

  let revenueEvents: RevenueEventDTO[] = [];
  let revenueEventsForbidden = false;
  try {
    revenueEvents = (await apiClient.listRevenueEvents(dealId, { cookieHeader })).revenueEvents;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) revenueEventsForbidden = true;
    else if (!(err instanceof ApiError && err.status === 404)) throw err;
  }

  let ledgerAccruals: AccrualDTO[] = [];
  let ledgerForbidden = false;
  try {
    ledgerAccruals = (await apiClient.getLedger(dealId, { cookieHeader })).accruals;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) ledgerForbidden = true;
    else if (!(err instanceof ApiError && err.status === 404)) throw err;
  }

  const activeSchedule = schedules.find((s) => s.status === "ACTIVE");
  const currency = revenueEvents[0]?.currency ?? ledgerAccruals[0]?.currency ?? "USD";
  const canManageSchedule = CAN_MANAGE_SCHEDULE.has(session.activeRole ?? "");
  const canRecordRevenue = CAN_RECORD_REVENUE.has(session.activeRole ?? "");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mono-label mb-2">P15 · Economics for deal {shortId(deal.id)}</div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-ink">
            {shortId(deal.merchantOrgId)} <span className="text-ink-3">×</span> {shortId(deal.providerOrgId)}
          </h1>
          <StatusChip status={deal.status} />
        </div>
        <p className="mt-1 text-xs text-ink-3">
          Viewing as{" "}
          {session.activeOrganizationId === deal.merchantOrgId ? "the merchant" : session.activeOrganizationId === deal.providerOrgId ? "the provider" : session.activeRole}
          .
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div>
            <h2 className="mono-label mb-3">Ledger — traceable accruals</h2>
            {ledgerForbidden ? (
              <div className="panel p-6">
                <p className="text-sm text-ink-3">
                  You do not see the full ledger for this deal — economics stays permissioned to the recipient a component names,
                  or to Finance/Platform oversight. If you are a named recipient on this deal&apos;s schedule, sign in as that
                  organization to see your own accrual entries.
                </p>
              </div>
            ) : (
              <LedgerTable accruals={ledgerAccruals} currency={currency} />
            )}
          </div>

          <div>
            <h2 className="mono-label mb-3">Revenue events ({revenueEvents.length})</h2>
            {revenueEventsForbidden ? (
              <div className="panel p-5">
                <p className="text-sm text-ink-3">
                  Revenue events are Finance/Platform-only — not shown here as &quot;none recorded&quot; (live-verified fix: a
                  403 must never render the same as a genuinely empty list).
                </p>
              </div>
            ) : revenueEvents.length === 0 ? (
              <div className="panel p-5">
                <p className="text-sm text-ink-3">No revenue recorded yet for this deal.</p>
              </div>
            ) : (
              <div className="panel scrollx">
                <table className="w-full min-w-[560px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-edge text-left">
                      <th className="mono-label px-4 py-3 font-normal">Period / source</th>
                      <th className="mono-label px-4 py-3 font-normal">Gross</th>
                      <th className="mono-label px-4 py-3 font-normal">Deductions</th>
                      <th className="mono-label px-4 py-3 font-normal">Net distributable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revenueEvents.map((r) => (
                      <tr key={r.id} className="border-b border-edge last:border-0">
                        <td className="px-4 py-3 text-ink">
                          {r.period} <span className="text-ink-3">· {r.source}</span>
                        </td>
                        <td className="px-4 py-3 text-ink-2">{formatMoneyMinor(r.grossAmountMinor, r.currency)}</td>
                        <td className="px-4 py-3 text-ink-2">{formatMoneyMinor(r.deductionsMinor, r.currency)}</td>
                        <td className="px-4 py-3 text-ink">{formatMoneyMinor(r.netDistributableMinor, r.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <div>
            <h2 className="mono-label mb-3">Schedule</h2>
            {schedulesForbidden ? (
              <div className="panel p-5">
                <p className="text-sm text-ink-3">Schedule details are Finance/Platform-only.</p>
              </div>
            ) : activeSchedule ? (
              <ScheduleSummary schedule={activeSchedule} currency={currency} />
            ) : canManageSchedule ? (
              <CreateScheduleForm dealRoomId={deal.id} contributorOrgId={deal.providerOrgId} platformOrgId={session.activeOrganizationId ?? deal.providerOrgId} />
            ) : (
              <div className="panel p-5">
                <p className="text-sm text-ink-3">No active schedule yet — awaiting Platform Owner setup.</p>
              </div>
            )}
          </div>

          {canRecordRevenue && activeSchedule && <RecordRevenueEventForm dealRoomId={deal.id} basis={activeSchedule.basis} currency={currency} />}
        </div>
      </div>
    </div>
  );
}
