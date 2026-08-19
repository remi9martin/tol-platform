"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { EvidenceSourceKind, FactProvenance, PassportSectionType } from "@tol/contracts";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";

// the spec/p.18's required-facts vocabulary, mirrored locally as a
// plain literal list — same "don't import a domain/engine package into
// apps/web, mirror the small vocabulary locally" precedent
// CreateClaimForm.tsx's own DIRECTNESS_TIERS already established. The
// REAL, authoritative list this maps onto lives server-side
// (packages/evidence/src/config.ts's EVIDENCE_CONFIG.requiredFacts) —
// this is a rendering convenience (a picklist of the fields most likely
// to matter), not a second source of truth: filing ANY fieldKey the
// server doesn't recognize as required is still accepted (a Fact isn't
// restricted to a closed enum, the spec), it just won't move a
// blocker.
const SUGGESTED_FIELDS: { fieldKey: string; sectionType: PassportSectionType; label: string }[] = [
  { fieldKey: "legalEntityConfirmed", sectionType: "IDENTITY", label: "Legal entity / registration confirmed" },
  { fieldKey: "primaryContactConfirmed", sectionType: "IDENTITY", label: "Named, verified primary contact" },
  { fieldKey: "processingHistorySummary", sectionType: "PROCESSING_METRICS", label: "Processing history summary" },
  { fieldKey: "riskProfileSummary", sectionType: "RISK", label: "Risk profile summary" },
  { fieldKey: "settlementCapability", sectionType: "COMMERCIAL", label: "Settlement capability" },
  { fieldKey: "technicalIntegrationProfile", sectionType: "TECHNICAL", label: "Technical integration profile" },
  { fieldKey: "priorAcquirerRelationships", sectionType: "RELATIONSHIP_HISTORY", label: "Prior acquirer / provider relationships" },
  { fieldKey: "chargebackHistoryDetail", sectionType: "RISK", label: "Detailed chargeback history" },
];

const VERIFICATION_STATES: FactProvenance[] = ["SELF_REPORTED", "DOCUMENT_EXTRACTED", "API_VERIFIED", "COUNTERPARTY_CONFIRMED", "OPERATOR_VERIFIED", "OUTCOME_LEARNED", "INFERRED"];
const EVIDENCE_TYPES: EvidenceSourceKind[] = ["FILE", "API", "ATTESTATION"];

export function PassportActions({
  passportId,
  canUpdate,
  canVerify,
  evidenceOptions,
}: {
  passportId: string;
  canUpdate: boolean;
  canVerify: boolean;
  evidenceOptions: { id: string; label: string }[];
}) {
  if (!canUpdate && !canVerify) return null;

  return (
    <div className="flex flex-col gap-4">
      {canUpdate && <FactForm passportId={passportId} evidenceOptions={evidenceOptions} />}
      {canUpdate && <EvidenceForm passportId={passportId} />}
      {canVerify && <VerifyForm passportId={passportId} />}
    </div>
  );
}

function FactForm({ passportId, evidenceOptions }: { passportId: string; evidenceOptions: { id: string; label: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fieldKey, setFieldKey] = useState(SUGGESTED_FIELDS[0]!.fieldKey);
  const [sectionType, setSectionType] = useState<PassportSectionType>(SUGGESTED_FIELDS[0]!.sectionType);
  const [customFieldKey, setCustomFieldKey] = useState("");
  const [value, setValue] = useState("");
  const [verification, setVerification] = useState<FactProvenance>("SELF_REPORTED");
  const [evidenceId, setEvidenceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-go self-start" onClick={() => setOpen(true)}>
        + File / update a fact
      </button>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const key = fieldKey === "__custom__" ? customFieldKey.trim() : fieldKey;
    if (!key) {
      setError("A field key is required.");
      return;
    }
    if (!value.trim()) {
      setError("A value is required.");
      return;
    }
    const token = readCsrfTokenFromCookie();
    if (!token) {
      setError("Session expired — please sign in again.");
      return;
    }

    // normalizedValue is polymorphic (the spec) — try JSON first
    // (lets a reviewer paste a structured object like {"gateway":"..."}),
    // fall back to the raw string, matching the wire contract's own
    // `z.unknown()` shape (packages/contracts/src/passport.ts).
    let normalizedValue: unknown = value.trim();
    try {
      normalizedValue = JSON.parse(value.trim());
    } catch {
      // not JSON — keep the plain string, that's a legitimate value too.
    }

    setBusy(true);
    try {
      await apiClient.upsertPassportFact(
        passportId,
        { sectionType, fieldKey: key, normalizedValue, verification, evidenceId: evidenceId || undefined },
        token,
      );
      router.refresh();
      setOpen(false);
      setValue("");
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Filing the fact failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel-2 flex flex-col gap-3 p-4">
      <div className="mono-label">File / update a fact</div>

      <div>
        <label htmlFor="fieldKey" className="mono-label mb-1.5 block">
          Field
        </label>
        <select
          id="fieldKey"
          className="field-input"
          value={fieldKey}
          onChange={(e) => {
            const next = e.target.value;
            setFieldKey(next);
            const suggestion = SUGGESTED_FIELDS.find((f) => f.fieldKey === next);
            if (suggestion) setSectionType(suggestion.sectionType);
          }}
        >
          {SUGGESTED_FIELDS.map((f) => (
            <option key={f.fieldKey} value={f.fieldKey}>
              {f.label}
            </option>
          ))}
          <option value="__custom__">Other (enter a field key)</option>
        </select>
        {fieldKey === "__custom__" && (
          <input
            className="field-input mt-2"
            value={customFieldKey}
            onChange={(e) => setCustomFieldKey(e.target.value)}
            placeholder="fieldKey, e.g. reserveHoldPolicy"
          />
        )}
      </div>

      <div>
        <label htmlFor="sectionType" className="mono-label mb-1.5 block">
          Section
        </label>
        <select id="sectionType" className="field-input" value={sectionType} onChange={(e) => setSectionType(e.target.value as PassportSectionType)}>
          {(["IDENTITY", "RELATIONSHIP_HISTORY", "PROCESSING_METRICS", "RISK", "COMMERCIAL", "TECHNICAL"] as const).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="value" className="mono-label mb-1.5 block">
          Value
        </label>
        <textarea
          id="value"
          className="field-input"
          rows={2}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder='e.g. true, or a description, or {"gateway":"Stripe"}'
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="verification" className="mono-label mb-1.5 block">
            Provenance
          </label>
          <select id="verification" className="field-input" value={verification} onChange={(e) => setVerification(e.target.value as FactProvenance)}>
            {VERIFICATION_STATES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        {evidenceOptions.length > 0 && (
          <div>
            <label htmlFor="evidenceId" className="mono-label mb-1.5 block">
              Supporting evidence (optional)
            </label>
            <select id="evidenceId" className="field-input" value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)}>
              <option value="">— None —</option>
              {evidenceOptions.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-go">
          {busy ? "Saving…" : "Save fact"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EvidenceForm({ passportId }: { passportId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<EvidenceSourceKind>("FILE");
  const [objectRef, setObjectRef] = useState("");
  const [issuer, setIssuer] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost self-start" onClick={() => setOpen(true)}>
        + Add evidence
      </button>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!objectRef.trim()) {
      setError("An object reference is required (e.g. a document label or storage key).");
      return;
    }
    const token = readCsrfTokenFromCookie();
    if (!token) {
      setError("Session expired — please sign in again.");
      return;
    }
    setBusy(true);
    try {
      await apiClient.addPassportEvidence(
        passportId,
        {
          type,
          objectRef: objectRef.trim(),
          issuer: issuer.trim() || undefined,
          collectedAt: new Date().toISOString(),
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        },
        token,
      );
      router.refresh();
      setOpen(false);
      setObjectRef("");
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Adding evidence failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel-2 flex flex-col gap-3 p-4">
      <div className="mono-label">Add evidence</div>
      <p className="text-[12px] leading-relaxed text-ink-3">
        A safe reference only (a label, filename, or storage key) — never the raw document
        content itself (the spec).
      </p>
      <div className="grid grid-cols-2 gap-3">
        <select className="field-input" value={type} onChange={(e) => setType(e.target.value as EvidenceSourceKind)}>
          {EVIDENCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input className="field-input" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Issuer (optional)" />
      </div>
      <input className="field-input" value={objectRef} onChange={(e) => setObjectRef(e.target.value)} placeholder="Reference (e.g. registration-certificate.pdf)" />
      <div>
        <label htmlFor="expiresAt" className="mono-label mb-1.5 block">
          Expires (optional)
        </label>
        <input id="expiresAt" type="date" className="field-input" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
      </div>

      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-go">
          {busy ? "Saving…" : "Add evidence"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function VerifyForm({ passportId }: { passportId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-go self-start" onClick={() => setOpen(true)}>
        Verify this Passport
      </button>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }
    const token = readCsrfTokenFromCookie();
    if (!token) {
      setError("Session expired — please sign in again.");
      return;
    }
    setBusy(true);
    try {
      await apiClient.verifyPassport(passportId, { reason: reason.trim() }, token);
      router.refresh();
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Verifying failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel-2 flex flex-col gap-3 p-4">
      <div className="mono-label">Verify this Passport</div>
      <p className="text-[12px] leading-relaxed text-ink-3">
        Only reachable from READY — every required fact present and current. This is the
        Journey B reviewer step; self-verification by the Passport&rsquo;s own org is never
        permitted, enforced server-side regardless of role.
      </p>
      <textarea className="field-input" rows={2} placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-go">
          {busy ? "Verifying…" : "Confirm verification"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
