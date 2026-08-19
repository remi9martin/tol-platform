"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ClaimEvidenceType, EvidenceVerificationState, OpportunityDTO, OrganizationDTO } from "@tol/contracts";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";

const DIRECTNESS_TIERS: { value: "D5" | "D4" | "D3" | "D2" | "D1" | "D0"; label: string }[] = [
  { value: "D5", label: "D5 — Counterparty executive directly acknowledges the relationship" },
  { value: "D4", label: "D4 — Direct operating/commercial decision-maker" },
  { value: "D3", label: "D3 — Direct employee contact, authority uncertain" },
  { value: "D2", label: "D2 — Known intermediary with a named next hop" },
  { value: "D1", label: "D1 — Generic mailbox, list, or unverified claim" },
  { value: "D0", label: "D0 — Public knowledge only (scores zero — see the spec)" },
];

const EVIDENCE_TYPES: ClaimEvidenceType[] = ["CONTRACT", "COUNTERPARTY_ACKNOWLEDGMENT", "EMAIL_THREAD", "CRM_RECORD", "OTHER"];
const VERIFICATION_STATES: EvidenceVerificationState[] = ["SELF_REPORTED", "DOCUMENT_EXTRACTED", "API_VERIFIED", "COUNTERPARTY_CONFIRMED", "OPERATOR_VERIFIED"];

/** Server-side Zod validation (CreateClaimRequestSchema: `z.number().int().min(0)...`) already rejects NaN/negative values with a clean 400 — this is purely a UX nicety so a non-numeric paste doesn't silently set state to NaN and confuse the number input's own display (review). */
function parseNonNegativeInt(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

interface EvidenceRow {
  evidenceType: ClaimEvidenceType;
  assertedFact: string;
  verificationState: EvidenceVerificationState;
}

/**
 * the spec Journey A: "Contributor creates a RelationshipClaim ->
 * selects target organization -> declares relationship type, scope,
 * proximity and prior commercial history -> uploads evidence metadata."
 * Filing scores the claim atomically (apps/api's claims service) — this
 * form's submit takes the caller straight to the real, explainable
 * breakdown on the new claim's detail page, never a client-side estimate.
 */
export function CreateClaimForm({ organizations, opportunities }: { organizations: OrganizationDTO[]; opportunities: OpportunityDTO[] }) {
  const router = useRouter();
  const [subjectOrgId, setSubjectOrgId] = useState(organizations[0]?.id ?? "");
  const [relationshipType, setRelationshipType] = useState("ACQUIRER_INTRODUCTION");
  const [directnessTier, setDirectnessTier] = useState<(typeof DIRECTNESS_TIERS)[number]["value"]>("D3");
  const [opportunityId, setOpportunityId] = useState<string>("");
  const [priorCommercialHistoryMonths, setPriorCommercialHistoryMonths] = useState(0);
  const [submissionLagDays, setSubmissionLagDays] = useState(0);
  const [evidenceItems, setEvidenceItems] = useState<EvidenceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function addEvidence() {
    setEvidenceItems((prev) => [...prev, { evidenceType: "EMAIL_THREAD", assertedFact: "", verificationState: "SELF_REPORTED" }]);
  }
  function updateEvidence(index: number, patch: Partial<EvidenceRow>) {
    setEvidenceItems((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function removeEvidence(index: number) {
    setEvidenceItems((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!subjectOrgId) {
      setError("Select the subject organization.");
      return;
    }
    if (!relationshipType.trim()) {
      setError("Relationship type is required.");
      return;
    }
    if (evidenceItems.some((item) => !item.assertedFact.trim())) {
      setError("Every evidence row needs a description, or remove it.");
      return;
    }

    const csrfToken = readCsrfTokenFromCookie();
    if (!csrfToken) {
      setError("Session expired — please sign in again.");
      return;
    }

    setSubmitting(true);
    try {
      const claim = await apiClient.createClaim(
        {
          subjectOrgId,
          relationshipType: relationshipType.trim(),
          directnessTier,
          opportunityId: opportunityId || undefined,
          priorCommercialHistoryMonths,
          submissionLagDays,
          evidenceItems: evidenceItems.map((item) => ({ ...item, assertedFact: item.assertedFact.trim() })),
        },
        csrfToken,
      );
      router.push(`/app/claims/${claim.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Failed to file claim.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="panel flex flex-col gap-5 p-5">
      <div>
        <label htmlFor="subjectOrgId" className="mono-label mb-1.5 block">
          Subject organization — whose relationship are you claiming?
        </label>
        {organizations.length > 0 ? (
          <select id="subjectOrgId" className="field-input" value={subjectOrgId} onChange={(e) => setSubjectOrgId(e.target.value)}>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.displayName}
              </option>
            ))}
          </select>
        ) : (
          // organization.list isn't granted to claimant-side personas
          // (packages/authz/src/matrix.ts) — no directory to pick from, so
          // this falls back to entering the organization id directly
          // (e.g. copied from a shared RFQ/deal/opportunity reference)
          // rather than blocking the whole form.
          <input
            id="subjectOrgId"
            className="field-input"
            value={subjectOrgId}
            onChange={(e) => setSubjectOrgId(e.target.value)}
            placeholder="Organization id (UUID)"
          />
        )}
      </div>

      <div>
        <label htmlFor="relationshipType" className="mono-label mb-1.5 block">
          Relationship type
        </label>
        <input
          id="relationshipType"
          className="field-input"
          value={relationshipType}
          onChange={(e) => setRelationshipType(e.target.value)}
          placeholder="e.g. ACQUIRER_INTRODUCTION, PSP_INTRODUCTION, EXISTING_RELATIONSHIP"
        />
      </div>

      {opportunities.length > 0 && (
        <div>
          <label htmlFor="opportunityId" className="mono-label mb-1.5 block">
            Opportunity (optional — scopes the claim to one deal rather than the whole relationship)
          </label>
          <select id="opportunityId" className="field-input" value={opportunityId} onChange={(e) => setOpportunityId(e.target.value)}>
            <option value="">— No specific opportunity —</option>
            {opportunities.map((o) => (
              <option key={o.id} value={o.id}>
                {o.requestedService}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <span className="mono-label mb-1.5 block">Directness (the spec)</span>
        <div className="flex flex-col gap-1.5">
          {DIRECTNESS_TIERS.map((t) => (
            <label key={t.value} className="flex items-center gap-2.5 rounded-md border border-edge px-3 py-2 text-[12.5px] text-ink-2">
              <input type="radio" name="directnessTier" checked={directnessTier === t.value} onChange={() => setDirectnessTier(t.value)} />
              {t.label}
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="priorCommercialHistoryMonths" className="mono-label mb-1.5 block">
            Prior history (months)
          </label>
          <input
            id="priorCommercialHistoryMonths"
            type="number"
            min={0}
            max={600}
            className="field-input"
            value={priorCommercialHistoryMonths}
            onChange={(e) => setPriorCommercialHistoryMonths(parseNonNegativeInt(e.target.value))}
          />
        </div>
        <div>
          <label htmlFor="submissionLagDays" className="mono-label mb-1.5 block">
            Submission lag (days)
          </label>
          <input
            id="submissionLagDays"
            type="number"
            min={0}
            max={3650}
            className="field-input"
            value={submissionLagDays}
            onChange={(e) => setSubmissionLagDays(parseNonNegativeInt(e.target.value))}
          />
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="mono-label">Evidence</span>
          <button type="button" className="btn btn-ghost text-[12px]" onClick={addEvidence}>
            + Add evidence
          </button>
        </div>
        {evidenceItems.length === 0 && (
          <p className="text-[12px] text-ink-3">
            No evidence attached — this is a structurally valid but weak claim (the spec&rsquo;s own anti-gaming test).
          </p>
        )}
        <div className="flex flex-col gap-3">
          {evidenceItems.map((item, index) => (
            <div key={index} className="rounded-md border border-edge p-3">
              <div className="mb-2 flex gap-2">
                <select
                  className="field-input"
                  value={item.evidenceType}
                  onChange={(e) => updateEvidence(index, { evidenceType: e.target.value as ClaimEvidenceType })}
                >
                  {EVIDENCE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <select
                  className="field-input"
                  value={item.verificationState}
                  onChange={(e) => updateEvidence(index, { verificationState: e.target.value as EvidenceVerificationState })}
                >
                  {VERIFICATION_STATES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-ghost shrink-0 text-[12px]" onClick={() => removeEvidence(index)}>
                  Remove
                </button>
              </div>
              <textarea
                className="field-input"
                rows={2}
                placeholder="What does this evidence show?"
                value={item.assertedFact}
                onChange={(e) => updateEvidence(index, { assertedFact: e.target.value })}
              />
            </div>
          ))}
        </div>
      </div>

      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      <button type="submit" disabled={submitting} className="btn btn-go justify-center">
        {submitting ? "Filing and scoring…" : "File claim"}
      </button>
    </form>
  );
}
