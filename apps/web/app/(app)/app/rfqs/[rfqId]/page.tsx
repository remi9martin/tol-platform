import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient, ApiError } from "@/lib/api-client";
import { StatusChip } from "@/components/shared/StatusChip";
import { RfqDetailActions } from "@/components/rfq/RfqDetailActions";
import { formatBps, formatDate, formatDateTime, formatMoneyMinor, shortId } from "@/lib/format";

// Next.js 16: dynamic-route `params` is a Promise — see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md
// ("Since the params prop is a promise... you must use async/await").
interface Props {
  params: Promise<{ rfqId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { rfqId } = await params;
  return { title: `RFQ ${shortId(rfqId)} — TOL` };
}

/** the spec: "/app/rfqs/[rfqId] — RFQ Workspace — Disclosure packet, questions, quote, conditions." */
export default async function RfqDetailPage({ params }: Props) {
  const { rfqId } = await params;
  const session = await getServerSession();
  if (!session) throw new Error("RfqDetailPage rendered without a session — AppLayout's guard should prevent this.");

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  let rfq;
  try {
    rfq = await apiClient.getRfq(rfqId, { cookieHeader });
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

  const opportunity = await apiClient.getOpportunity(rfq.opportunityId, { cookieHeader }).catch(() => null);
  const merchantOrgId = opportunity?.ownerOrgId ?? "";
  const isMerchantViewer = session.activeOrganizationId !== null && session.activeOrganizationId === merchantOrgId;
  const myRecipient = rfq.recipients?.find((r) => r.providerOrgId === session.activeOrganizationId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mono-label mb-2">RFQ {shortId(rfq.id)}</div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-ink">{opportunity?.requestedService ?? "RFQ"}</h1>
          <StatusChip status={rfq.status} />
        </div>
        <p className="mt-1 text-sm text-ink-2">
          Due {formatDate(rfq.dueAt)} · disclosure version {rfq.currentVersion?.versionNumber ?? rfq.currentVersionNumber}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {rfq.currentVersion && (
            <div className="panel p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="mono-label">Disclosure packet</h2>
                <span className="chip chip-neutral">{rfq.currentVersion.packetType}</span>
              </div>
              <dl className="divide-y divide-edge text-sm">
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-ink-3">Requested service</dt>
                  <dd className="text-right text-ink">{rfq.currentVersion.disclosureSnapshot.opportunitySummary.requestedService}</dd>
                </div>
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-ink-3">Jurisdictions</dt>
                  <dd className="text-right text-ink">{rfq.currentVersion.disclosureSnapshot.opportunitySummary.jurisdictions.join(", ")}</dd>
                </div>
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-ink-3">MCCs</dt>
                  <dd className="text-right text-ink">{rfq.currentVersion.disclosureSnapshot.opportunitySummary.mccs.join(", ")}</dd>
                </div>
              </dl>
            </div>
          )}

          <div className="panel p-5">
            <h2 className="mono-label mb-3">
              Quotes {rfq.quotes && rfq.quotes.length > 0 ? `(${rfq.quotes.length})` : ""}
            </h2>
            {!rfq.quotes || rfq.quotes.length === 0 ? (
              <p className="text-sm text-ink-3">No quotes yet.</p>
            ) : (
              <div className="scrollx">
                <table className="w-full min-w-[560px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-edge text-left">
                      <th className="mono-label px-2 py-2 font-normal">Provider</th>
                      <th className="mono-label px-2 py-2 font-normal">Rate</th>
                      <th className="mono-label px-2 py-2 font-normal">Reserve</th>
                      <th className="mono-label px-2 py-2 font-normal">Capacity/mo</th>
                      <th className="mono-label px-2 py-2 font-normal">Status</th>
                      <th className="mono-label px-2 py-2 font-normal">Valid until</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rfq.quotes.map((q) => (
                      <tr key={q.id} className="border-b border-edge last:border-0">
                        <td className="px-2 py-2 text-ink">
                          {shortId(q.providerOrgId)} <span className="text-ink-3">v{q.quoteVersion}</span>
                        </td>
                        <td className="px-2 py-2 text-ink-2">{formatBps(q.terms.rate.bps ?? 0)}</td>
                        <td className="px-2 py-2 text-ink-2">{formatBps(q.terms.reserve.bps ?? 0)}</td>
                        <td className="px-2 py-2 text-ink-2">{formatMoneyMinor(q.terms.capacityOffer.monthlyAmountMinor, q.currency)}</td>
                        <td className="px-2 py-2">
                          <StatusChip status={q.status} />
                        </td>
                        <td className="px-2 py-2 text-ink-2">{formatDate(q.validUntil)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-ink-3">
              {isMerchantViewer
                ? "As the requesting organization, you see every quote submitted."
                : "You see only your own organization's quotes — competing quotes stay private (the spec)."}
            </p>
          </div>

          <RfqDetailActions
            rfq={rfq}
            myRecipient={myRecipient}
            myOrgId={session.activeOrganizationId}
            isMerchantViewer={isMerchantViewer}
          />
        </div>

        <div className="panel p-5">
          <h2 className="mono-label mb-3">Invited providers ({rfq.recipients?.length ?? 0})</h2>
          <ul className="flex flex-col gap-2">
            {rfq.recipients?.map((r) => (
              <li key={r.id} className="rounded-md border border-edge px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink">{shortId(r.providerOrgId)}</span>
                  <StatusChip status={r.state} />
                </div>
                {r.declineReason && <p className="mt-1 text-xs text-ink-3">Declined: {r.declineReason}</p>}
                {r.acknowledgedAt && <p className="mt-1 text-xs text-ink-3">Ack. {formatDateTime(r.acknowledgedAt)}</p>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
