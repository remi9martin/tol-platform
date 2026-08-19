"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { DealRoomDTO } from "@tol/contracts";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";

/**
 * the spec Deal Room surfaces ("Conditions: owner, evidence, due date,
 * blocking state, resolution history"; "Decisions: quote selection,
 * approvals, declines, exceptions and rationale") as UI affordances —
 * the server (@tol/authz's isParticipant mechanism, ADR-0008)
 * decides who can actually post/resolve/decide; this component only
 * reflects that, same as RfqDetailActions.
 */
export function DealActions({ deal }: { deal: DealRoomDTO }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const csrfToken = () => {
    const token = readCsrfTokenFromCookie();
    if (!token) setError("Session expired — please sign in again.");
    return token;
  };

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  const terminal = deal.status === "DECLINED" || deal.status === "ARCHIVED";

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {!terminal && (
        <>
          <PostConditionForm dealId={deal.id} merchantOrgId={deal.merchantOrgId} providerOrgId={deal.providerOrgId} busy={busy} onSubmit={run} onCsrf={csrfToken} />
          <RecordDecisionForm dealId={deal.id} busy={busy} onSubmit={run} onCsrf={csrfToken} />
        </>
      )}
    </div>
  );
}

export function ResolveConditionButton({
  dealId,
  conditionId,
  state,
}: {
  dealId: string;
  conditionId: string;
  state: "PENDING" | "SATISFIED" | "WAIVED" | "REJECTED";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state !== "PENDING" && state !== "REJECTED") return null;

  async function resolve(target: "SATISFIED" | "WAIVED" | "REJECTED") {
    setError(null);
    const token = readCsrfTokenFromCookie();
    if (!token) {
      setError("Session expired — please sign in again.");
      return;
    }
    setBusy(true);
    try {
      await apiClient.resolveCondition(dealId, conditionId, { state: target, resolutionNote: note || undefined }, token);
      router.refresh();
    } catch (err) {
      // Standalone component (not a child of DealActions — rendered directly
      // by the deal page's conditions list, see page.tsx), so it owns its
      // own error surface rather than a parent's shared state (this stage
      // review, 2026-08-18: this catch block used to be empty and this
      // comment used to (incorrectly) claim a parent state that doesn't
      // apply here — see review).
      setError(err instanceof ApiError ? err.problem.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOpen(true)}>
        Resolve
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-edge-2 p-2">
      {error && (
        <p role="alert" className="field-error text-xs">
          {error}
        </p>
      )}
      <input
        className="field-input text-xs"
        placeholder="Resolution note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={busy} className="btn btn-go" onClick={() => resolve("SATISFIED")}>
          Satisfied
        </button>
        <button type="button" disabled={busy} className="btn btn-ghost" onClick={() => resolve("WAIVED")}>
          Waive
        </button>
        <button type="button" disabled={busy} className="btn btn-ghost" onClick={() => resolve("REJECTED")}>
          Reject
        </button>
      </div>
    </div>
  );
}

function PostConditionForm({
  dealId,
  merchantOrgId,
  providerOrgId,
  busy,
  onSubmit,
  onCsrf,
}: {
  dealId: string;
  merchantOrgId: string;
  providerOrgId: string;
  busy: boolean;
  onSubmit: (fn: () => Promise<unknown>) => Promise<void>;
  onCsrf: () => string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [ownerOrgId, setOwnerOrgId] = useState(merchantOrgId);
  const [blocking, setBlocking] = useState(true);

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost self-start" onClick={() => setOpen(true)}>
        + Post condition
      </button>
    );
  }

  return (
    <form
      className="panel-2 flex flex-col gap-3 p-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const token = onCsrf();
        if (!token) return;
        onSubmit(() => apiClient.postCondition(dealId, { description, ownerOrgId, blocking }, token)).then(() => {
          setDescription("");
          setOpen(false);
        });
      }}
    >
      <div>
        <label htmlFor="conditionDescription" className="mono-label mb-1 block">
          Condition
        </label>
        <textarea
          id="conditionDescription"
          required
          className="field-input"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Provide UBO documentation"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="ownerOrgId" className="mono-label mb-1 block">
            Owed by
          </label>
          <select id="ownerOrgId" className="field-input" value={ownerOrgId} onChange={(e) => setOwnerOrgId(e.target.value)}>
            <option value={merchantOrgId}>Merchant</option>
            <option value={providerOrgId}>Provider</option>
          </select>
        </div>
        <label className="mt-6 flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={blocking} onChange={(e) => setBlocking(e.target.checked)} />
          Blocking
        </label>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-go">
          Post
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RecordDecisionForm({
  dealId,
  busy,
  onSubmit,
  onCsrf,
}: {
  dealId: string;
  busy: boolean;
  onSubmit: (fn: () => Promise<unknown>) => Promise<void>;
  onCsrf: () => string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [decisionType, setDecisionType] = useState<"APPROVAL" | "DECLINE" | "EXCEPTION">("APPROVAL");
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost self-start" onClick={() => setOpen(true)}>
        + Record decision
      </button>
    );
  }

  return (
    <form
      className="panel-2 flex flex-col gap-3 p-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const token = onCsrf();
        if (!token) return;
        onSubmit(() => apiClient.recordDecision(dealId, { decisionType, reason }, token)).then(() => {
          setReason("");
          setOpen(false);
        });
      }}
    >
      <div>
        <label htmlFor="decisionType" className="mono-label mb-1 block">
          Decision
        </label>
        <select
          id="decisionType"
          className="field-input"
          value={decisionType}
          onChange={(e) => setDecisionType(e.target.value as "APPROVAL" | "DECLINE" | "EXCEPTION")}
        >
          <option value="APPROVAL">Approve</option>
          <option value="DECLINE">Decline</option>
          <option value="EXCEPTION">Exception</option>
        </select>
      </div>
      <div>
        <label htmlFor="decisionReason" className="mono-label mb-1 block">
          Rationale
        </label>
        <textarea
          id="decisionReason"
          required
          className="field-input"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-go">
          Record
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
