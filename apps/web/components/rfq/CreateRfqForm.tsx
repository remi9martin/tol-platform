"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { CapacityProfileDTO, OpportunityDTO } from "@tol/contracts";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";

/**
 * the spec RFQ rules: "One provider receives one versioned packet" —
 * this form builds v1 of that packet (DisclosureSnapshot) directly from
 * the selected Opportunity's own fields, at QUALIFIED_RFQ tier (p.22:
 * "Named entity + normalized opportunity + selected evidence") — the
 * operator doesn't hand-author JSON, the form derives it.
 */
export function CreateRfqForm({
  opportunities,
  capacityProfiles,
}: {
  opportunities: OpportunityDTO[];
  capacityProfiles: CapacityProfileDTO[];
}) {
  const router = useRouter();
  const [opportunityId, setOpportunityId] = useState(opportunities[0]?.id ?? "");
  const [providerOrgIds, setProviderOrgIds] = useState<string[]>([]);
  const [dueInDays, setDueInDays] = useState(14);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedOpportunity = opportunities.find((o) => o.id === opportunityId);

  function toggleProvider(providerOrgId: string) {
    setProviderOrgIds((prev) => (prev.includes(providerOrgId) ? prev.filter((id) => id !== providerOrgId) : [...prev, providerOrgId]));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!selectedOpportunity) {
      setError("Select an opportunity.");
      return;
    }
    if (providerOrgIds.length === 0) {
      setError("Invite at least one provider.");
      return;
    }

    const csrfToken = readCsrfTokenFromCookie();
    if (!csrfToken) {
      setError("Session expired — please sign in again.");
      return;
    }

    setSubmitting(true);
    try {
      const rfq = await apiClient.createRfq(
        {
          opportunityId: selectedOpportunity.id,
          providerOrgIds,
          dueAt: new Date(Date.now() + dueInDays * 86_400_000).toISOString(),
          packetType: "QUALIFIED_RFQ",
          disclosureSnapshot: {
            opportunitySummary: {
              requestedService: selectedOpportunity.requestedService,
              jurisdictions: selectedOpportunity.jurisdictions,
              mccs: selectedOpportunity.mccs,
            },
            evidenceRefs: [],
          },
        },
        csrfToken,
      );
      router.push(`/app/rfqs/${rfq.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Failed to create RFQ.");
    } finally {
      setSubmitting(false);
    }
  }

  if (opportunities.length === 0) {
    return <p className="panel p-5 text-sm text-ink-3">No opportunities exist yet to attach an RFQ to.</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="panel flex flex-col gap-5 p-5">
      <div>
        <label htmlFor="opportunityId" className="mono-label mb-1.5 block">
          Opportunity
        </label>
        <select
          id="opportunityId"
          className="field-input"
          value={opportunityId}
          onChange={(e) => setOpportunityId(e.target.value)}
        >
          {opportunities.map((o) => (
            <option key={o.id} value={o.id}>
              {o.requestedService} ({o.status})
            </option>
          ))}
        </select>
      </div>

      <div>
        <span className="mono-label mb-1.5 block">Invite providers</span>
        {capacityProfiles.length === 0 ? (
          <p className="text-sm text-ink-3">No provider capacity profiles exist yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {capacityProfiles.map((cp) => (
              <label
                key={cp.id}
                className="flex items-center gap-2.5 rounded-md border border-edge px-3 py-2 text-sm text-ink-2"
              >
                <input
                  type="checkbox"
                  checked={providerOrgIds.includes(cp.providerOrgId)}
                  onChange={() => toggleProvider(cp.providerOrgId)}
                />
                <span className="text-ink">Provider {cp.providerOrgId.slice(0, 8)}</span>
                <span className="chip chip-neutral ml-auto">{cp.freshnessClass}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div>
        <label htmlFor="dueInDays" className="mono-label mb-1.5 block">
          Due in (days)
        </label>
        <input
          id="dueInDays"
          type="number"
          min={1}
          max={90}
          className="field-input"
          value={dueInDays}
          onChange={(e) => setDueInDays(Number(e.target.value))}
        />
      </div>

      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      <button type="submit" disabled={submitting} className="btn btn-go justify-center">
        {submitting ? "Sending…" : "Send RFQ"}
      </button>
    </form>
  );
}
