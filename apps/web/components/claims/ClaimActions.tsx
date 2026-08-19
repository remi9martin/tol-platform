"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";

/**
 * the spec/p.18. `canDispute`/`canDecide` are computed SERVER-SIDE (the
 * detail page, from the session + the claim's own state) and passed down
 * as plain booleans — apps/api's own can()/isParticipant checks are what
 * actually enforce this; these props only decide which affordances
 * render, matching every other earlier phases client component's "server
 * decides, UI reflects" split (see LockboxActions.tsx).
 */
export function ClaimActions({
  claimId,
  canDispute,
  canDecide,
  hasOpenDispute,
}: {
  claimId: string;
  canDispute: boolean;
  canDecide: boolean;
  hasOpenDispute: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!canDispute && !canDecide) return null;

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {canDispute && <DisputeForm claimId={claimId} setBusy={setBusy} busy={busy} setError={setError} router={router} />}
      {canDecide && (
        <DecideForm claimId={claimId} hasOpenDispute={hasOpenDispute} setBusy={setBusy} busy={busy} setError={setError} router={router} />
      )}
    </div>
  );
}

function DisputeForm({
  claimId,
  busy,
  setBusy,
  setError,
  router,
}: {
  claimId: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  router: ReturnType<typeof useRouter>;
}) {
  const [open, setOpen] = useState(false);
  const [basis, setBasis] = useState("");
  const [note, setNote] = useState("");

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost self-start" onClick={() => setOpen(true)}>
        Dispute this claim
      </button>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!basis.trim()) {
      setError("A basis for the dispute is required.");
      return;
    }
    const token = readCsrfTokenFromCookie();
    if (!token) {
      setError("Session expired — please sign in again.");
      return;
    }
    setBusy(true);
    try {
      await apiClient.fileClaimDispute(
        claimId,
        { basis: basis.trim(), evidence: note.trim() ? [{ evidenceType: "OTHER", note: note.trim() }] : undefined },
        token,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Filing the dispute failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel-2 flex flex-col gap-3 p-4">
      <div className="mono-label">Dispute this claim</div>
      <p className="text-[12px] leading-relaxed text-ink-3">
        the spec anti-gaming rule: a later, more direct relationship can defeat an earlier
        generic-mailbox claim. Standing (your own competing claim, or being the claim&rsquo;s
        subject organization) is verified server-side before this is accepted.
      </p>
      <textarea
        className="field-input"
        rows={3}
        placeholder="Basis for the dispute"
        value={basis}
        onChange={(e) => setBasis(e.target.value)}
      />
      <textarea
        className="field-input"
        rows={2}
        placeholder="Supporting note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-go">
          File dispute
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const DECISIONS = [
  { value: "VERIFIED", label: "Verify" },
  { value: "PARTIAL", label: "Shared (partial)" },
  { value: "REJECTED", label: "Reject" },
] as const;

function DecideForm({
  claimId,
  hasOpenDispute,
  busy,
  setBusy,
  setError,
  router,
}: {
  claimId: string;
  hasOpenDispute: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  router: ReturnType<typeof useRouter>;
}) {
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<(typeof DECISIONS)[number]["value"]>("VERIFIED");
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost self-start" onClick={() => setOpen(true)}>
        {hasOpenDispute ? "Resolve dispute" : "Record decision"}
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
      await apiClient.decideClaim(claimId, { decision, reason: reason.trim() }, token);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Recording the decision failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel-2 flex flex-col gap-3 p-4">
      <div className="mono-label">{hasOpenDispute ? "Resolve the open dispute" : "Record a decision"}</div>
      <p className="text-[12px] leading-relaxed text-ink-3">
        Self-certification is never permitted — this is blocked server-side if your own
        organization filed this claim, regardless of role.
      </p>
      <div className="flex gap-2">
        {DECISIONS.map((d) => (
          <label key={d.value} className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
            <input
              type="radio"
              name={`decision-${claimId}`}
              checked={decision === d.value}
              onChange={() => setDecision(d.value)}
            />
            {d.label}
          </label>
        ))}
      </div>
      <textarea
        className="field-input"
        rows={3}
        placeholder="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-go">
          Submit decision
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
