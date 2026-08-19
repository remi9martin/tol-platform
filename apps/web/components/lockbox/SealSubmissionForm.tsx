"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { LockboxRegion, LockboxRelationshipType } from "@tol/contracts";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";

const RELATIONSHIP_TYPE_LABELS: Record<LockboxRelationshipType, string> = {
  ACQUIRER_RELATIONSHIP: "Acquirer relationship",
  PROCESSOR_RELATIONSHIP: "Processor relationship",
  PSP_RELATIONSHIP: "PSP relationship",
  MERCHANT_RELATIONSHIP: "Merchant relationship",
  BANKING_RELATIONSHIP: "Banking relationship",
  INFRASTRUCTURE_RELATIONSHIP: "Infrastructure relationship",
  QUALIFIED_OPPORTUNITY: "Qualified opportunity",
};
const RELATIONSHIP_TYPE_OPTIONS = Object.keys(RELATIONSHIP_TYPE_LABELS) as LockboxRelationshipType[];

const REGION_LABELS: Record<LockboxRegion, string> = {
  EU: "Europe",
  UK: "United Kingdom",
  US: "United States",
  LATAM: "Latin America",
  APAC: "Asia-Pacific",
  MENA: "Middle East & North Africa",
  GLOBAL: "Global",
};
const REGION_OPTIONS = Object.keys(REGION_LABELS) as LockboxRegion[];

/**
 * Ported field-for-field from the reuse-reference prototype's
 * ContributeForm (../../the prototype repo/components/lockbox/
 * ContributeForm.tsx, visual structure only) — the earlier brief's
 * "SealSubmissionForm". The prototype's onContribute callback created a
 * client-only DRAFT (mockSealHash never touched); this version submits
 * directly to POST /lockbox, where apps/api's lockboxService.seal()
 * performs REAL AES-256-GCM encryption + Shamir threshold split
 * (ADR-0001/ADR-0009) before anything is persisted — there is no
 * separate persisted DRAFT state (@tol/domain/src/lockbox-states.ts's
 * header comment), so "submitting" IS sealing, in one step, matching
 * this build's actual mechanism rather than the prototype's two-step
 * draft-then-seal UI (draft here is purely this component's own
 * unsubmitted form state, never a server round trip).
 */
export function SealSubmissionForm({ sealerOrgName }: { sealerOrgName: string }) {
  const router = useRouter();
  const [relationshipType, setRelationshipType] = useState<LockboxRelationshipType>("ACQUIRER_RELATIONSHIP");
  const [region, setRegion] = useState<LockboxRegion>("EU");
  const [metadataSummary, setMetadataSummary] = useState("");
  const [counterpartyPrivate, setCounterpartyPrivate] = useState("");
  const [evidenceSummary, setEvidenceSummary] = useState("");
  const [priorDealHistory, setPriorDealHistory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sealing, setSealing] = useState(false);

  const canSubmit = counterpartyPrivate.trim().length > 0 && evidenceSummary.trim().length > 0 && priorDealHistory.trim().length > 0;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!canSubmit) {
      setError("Counterparty, evidence, and prior deal history are all required — sealing needs real content to encrypt.");
      return;
    }

    const csrfToken = readCsrfTokenFromCookie();
    if (!csrfToken) {
      setError("Session expired — please sign in again.");
      return;
    }

    setSealing(true);
    try {
      const lockbox = await apiClient.sealLockbox(
        {
          relationshipType,
          region,
          metadataSummary: metadataSummary.trim() || undefined,
          // No `|| "fallback string"` on any of these three fields (unlike
          // the reuse-reference prototype's ContributeForm, which allowed
          // submitting with blank history) — real review finding, fixed:
          // `canSubmit` above already requires all three fields non-empty
          // (matching LockboxPayloadSchema's own `.min(1)` on each), so a
          // fallback here was genuinely dead code that could never
          // execute — removed rather than left as confusing leftover
          // from the port.
          payload: {
            counterpartyPrivate: counterpartyPrivate.trim(),
            evidenceSummary: evidenceSummary.trim(),
            priorDealHistory: priorDealHistory.trim(),
          },
        },
        csrfToken,
      );
      router.push(`/app/lockbox/${lockbox.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Failed to seal Lockbox.");
    } finally {
      setSealing(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="panel flex flex-col gap-5 p-5">
      <div className="rounded-md border border-edge bg-[rgba(255,80,80,0.04)] p-3.5 text-[12.5px] leading-relaxed text-ink-3">
        Before sealing: everything below except <span className="text-ink-2">type</span>,{" "}
        <span className="text-ink-2">region</span>, and the optional{" "}
        <span className="text-ink-2">public label</span> is encrypted before it ever leaves this
        request — AES-256-GCM, a fresh key per submission, split three ways so no single stored
        value can decrypt it alone. Only a sha256 hash of the ciphertext and a signed receipt are
        ever visible outside this Lockbox.
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="mono-label">Relationship type</span>
          <select
            className="field-input"
            value={relationshipType}
            onChange={(e) => setRelationshipType(e.target.value as LockboxRelationshipType)}
          >
            {RELATIONSHIP_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {RELATIONSHIP_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="mono-label">Region</span>
          <select className="field-input" value={region} onChange={(e) => setRegion(e.target.value as LockboxRegion)}>
            {REGION_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {REGION_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="mono-label">Public label (optional) — market-visible, never encrypted</span>
        <input
          className="field-input"
          value={metadataSummary}
          onChange={(e) => setMetadataSummary(e.target.value)}
          placeholder="e.g. Acquirer relationship — EU"
          maxLength={200}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="mono-label">Counterparty — encrypted, never shown to the market</span>
        <input
          value={counterpartyPrivate}
          onChange={(e) => setCounterpartyPrivate(e.target.value)}
          placeholder="e.g. a named bank, acquirer, or processor contact"
          className="field-input"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="mono-label">Evidence — encrypted</span>
        <textarea
          value={evidenceSummary}
          onChange={(e) => setEvidenceSummary(e.target.value)}
          rows={2}
          placeholder="What backs this relationship — agreement, statements, correspondence"
          className="field-input resize-y"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="mono-label">Prior deal history — encrypted</span>
        <textarea
          value={priorDealHistory}
          onChange={(e) => setPriorDealHistory(e.target.value)}
          rows={2}
          placeholder="How long this relationship has existed, and what it has produced so far"
          className="field-input resize-y"
        />
      </label>

      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-edge pt-4">
        <button type="submit" disabled={!canSubmit || sealing} className="btn btn-go disabled:cursor-not-allowed disabled:opacity-40">
          {sealing ? "Sealing…" : "Seal into Lockbox"}
        </button>
        <span className="text-[12px] text-ink-3">
          Sealing as <span className="text-ink-2">{sealerOrgName}</span>. Real AES-256-GCM
          encryption runs the instant you submit — there is no separate draft saved on the server.
        </span>
      </div>
    </form>
  );
}
