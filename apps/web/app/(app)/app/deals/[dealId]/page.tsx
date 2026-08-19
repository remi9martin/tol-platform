import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient, ApiError } from "@/lib/api-client";
import { StatusChip } from "@/components/shared/StatusChip";
import { DealActions, ResolveConditionButton } from "@/components/deals/DealActions";
import { DealTimeline } from "@/components/deals/DealTimeline";
import { formatDateTime, shortId } from "@/lib/format";

interface Props {
  params: Promise<{ dealId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { dealId } = await params;
  return { title: `Deal Room ${shortId(dealId)} — TOL` };
}

/** the spec: "/app/deals/[dealId] — Private Deal Room — Versioned docs, tasks, decisions, timeline." the spec names the full surface set (Overview/Vault/Questions/Conditions/Decisions/Timeline/Activation/Outcome) — earlier builds Overview/Conditions/Decisions/Timeline (P14's actual exit condition); Vault/Questions/Activation/Outcome are later-day surfaces (no Evidence/RFQQuestion/ActivationChecklist entities exist yet — see the build log). */
export default async function DealRoomPage({ params }: Props) {
  const { dealId } = await params;
  const session = await getServerSession();
  if (!session) throw new Error("DealRoomPage rendered without a session — AppLayout's guard should prevent this.");

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

  const { events } = await apiClient.getDealTimeline(dealId, { cookieHeader }).catch(() => ({ events: [] }));

  const isMerchant = session.activeOrganizationId === deal.merchantOrgId;
  const isProvider = session.activeOrganizationId === deal.providerOrgId;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mono-label mb-2">Deal Room {shortId(deal.id)}</div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-ink">
            {shortId(deal.merchantOrgId)} <span className="text-ink-3">×</span> {shortId(deal.providerOrgId)}
          </h1>
          <StatusChip status={deal.status} />
        </div>
        {deal.nextAction && <p className="mt-1 text-sm text-ink-2">Next: {deal.nextAction}</p>}
        <p className="mt-1 text-xs text-ink-3">
          Viewing as {isMerchant ? "the merchant" : isProvider ? "the provider" : session.activeRole}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="panel p-5">
            <h2 className="mono-label mb-3">Conditions ({deal.conditions?.length ?? 0})</h2>
            {!deal.conditions || deal.conditions.length === 0 ? (
              <p className="text-sm text-ink-3">No conditions posted yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {deal.conditions.map((c) => (
                  <li key={c.id} className="rounded-md border border-edge px-3 py-2 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-ink">{c.description}</p>
                        <p className="mono-label mt-1">
                          Owed by {c.ownerOrgId === deal.merchantOrgId ? "merchant" : "provider"}
                          {c.blocking ? " · blocking" : ""}
                          {c.dueAt ? ` · due ${formatDateTime(c.dueAt)}` : ""}
                        </p>
                        {c.resolutionNote && <p className="mt-1 text-xs text-ink-3">{c.resolutionNote}</p>}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <StatusChip status={c.state} />
                        <ResolveConditionButton dealId={deal.id} conditionId={c.id} state={c.state} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel p-5">
            <h2 className="mono-label mb-3">Decisions ({deal.decisions?.length ?? 0})</h2>
            {!deal.decisions || deal.decisions.length === 0 ? (
              <p className="text-sm text-ink-3">No decisions recorded yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {deal.decisions.map((d) => (
                  <li key={d.id} className="rounded-md border border-edge px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="chip chip-neutral">{d.decisionType}</span>
                      <span className="mono-label">{formatDateTime(d.decidedAt)}</span>
                    </div>
                    <p className="mt-1.5 text-ink-2">{d.reason}</p>
                    <p className="mono-label mt-1">
                      {d.actorOrgId ? shortId(d.actorOrgId) : "system"} {d.actorRole ? `· ${d.actorRole}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel p-5">
            <h2 className="mono-label mb-3">Take action</h2>
            <DealActions deal={deal} />
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <div className="panel p-5">
            <h2 className="mono-label mb-3">Participants ({deal.participants?.length ?? 0})</h2>
            <ul className="flex flex-col gap-2">
              {deal.participants?.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded-md border border-edge px-3 py-2 text-sm">
                  <span className="text-ink">{shortId(p.organizationId)}</span>
                  <span className="chip chip-neutral">{p.participantRole}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel p-5">
            <h2 className="mono-label mb-3">Timeline</h2>
            <DealTimeline events={events} />
          </div>
        </div>
      </div>
    </div>
  );
}
