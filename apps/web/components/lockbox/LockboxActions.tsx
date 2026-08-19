"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { LockboxDTO, LockboxPayload, OrganizationDTO } from "@tol/contracts";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";

/**
 * the spec UI acceptance: "before sealing, user sees what is public
 * metadata vs encrypted payload; after sealing, receipt/hash/status is
 * visible." This component covers the two mutating actions available
 * AFTER sealing — withdraw (sealer only, before release) and release
 * (operator/platform-owner only, threshold-gated server-side) — plus
 * rendering the ONE moment plaintext is ever shown: a successful
 * release's `disclosedPayload`.
 *
 * `canWithdraw`/`canRelease` are computed SERVER-SIDE (the detail page,
 * from the session + @tol/authz's own persona list — mirroring, not
 * replacing, packages/authz's matrix) and passed down as plain booleans —
 * apps/api's own can() checks are what actually enforce this; these
 * props only decide which affordances render, matching every other
 * earlier phases client component's "server decides, UI reflects" split.
 */
export function LockboxActions({
  lockbox,
  organizations,
  canWithdraw,
  canRelease,
}: {
  lockbox: LockboxDTO;
  organizations: OrganizationDTO[];
  canWithdraw: boolean;
  canRelease: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disclosed, setDisclosed] = useState<LockboxPayload | null>(null);

  const terminal = lockbox.status === "WITHDRAWN" || lockbox.status === "OPENED" || lockbox.status === "DISPUTED";

  if (terminal && !disclosed) {
    return lockbox.status === "OPENED" ? (
      <p className="panel-2 p-4 text-[12.5px] text-ink-3">
        Released to the recipient organization on {lockbox.releasedAt ? new Date(lockbox.releasedAt).toLocaleString() : "—"}. No
        further action available.
      </p>
    ) : (
      <p className="panel-2 p-4 text-[12.5px] text-ink-3">
        {lockbox.status === "WITHDRAWN" ? "Withdrawn — the sealed contents can never be released." : "Disputed — flagged for resolution."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      {disclosed && (
        <div className="panel-2 flex flex-col gap-3 border-[rgba(255,36,54,0.38)] p-4">
          <div className="mono-label text-red">Released — decrypted contents (this is the only place this ever appears)</div>
          <Fact label="Counterparty" value={disclosed.counterpartyPrivate} />
          <Fact label="Evidence" value={disclosed.evidenceSummary} />
          <Fact label="Prior deal history" value={disclosed.priorDealHistory} />
        </div>
      )}

      {!disclosed && canWithdraw && <WithdrawForm lockboxId={lockbox.id} busy={busy} setBusy={setBusy} setError={setError} router={router} />}
      {!disclosed && canRelease && (
        <ReleaseForm
          lockboxId={lockbox.id}
          organizations={organizations}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onReleased={setDisclosed}
        />
      )}
      {!canWithdraw && !canRelease && !disclosed && (
        <p className="text-[12.5px] text-ink-3">You do not hold withdraw or release authority for this Lockbox.</p>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mono-label mb-1">{label}</div>
      <div className="text-[13px] leading-relaxed text-ink">{value}</div>
    </div>
  );
}

function WithdrawForm({
  lockboxId,
  busy,
  setBusy,
  setError,
  router,
}: {
  lockboxId: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  router: ReturnType<typeof useRouter>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost self-start" onClick={() => setOpen(true)}>
        Withdraw
      </button>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const token = readCsrfTokenFromCookie();
    if (!token) {
      setError("Session expired — please sign in again.");
      return;
    }
    setBusy(true);
    try {
      await apiClient.withdrawLockbox(lockboxId, { withdrawReason: reason.trim() || undefined }, token);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Withdraw failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel-2 flex flex-col gap-3 p-4">
      <div className="mono-label">Withdraw this Lockbox</div>
      <p className="text-[12px] leading-relaxed text-ink-3">
        Destroys all 3 threshold shares immediately — release becomes cryptographically
        impossible afterward, not just permission-denied. This cannot be undone.
      </p>
      <textarea
        className="field-input"
        rows={2}
        placeholder="Reason (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-go">
          Confirm withdraw
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ReleaseForm({
  lockboxId,
  organizations,
  busy,
  setBusy,
  setError,
  onReleased,
}: {
  lockboxId: string;
  organizations: OrganizationDTO[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onReleased: (payload: LockboxPayload) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recipientOrgId, setRecipientOrgId] = useState(organizations[0]?.id ?? "");
  const [conditionRef, setConditionRef] = useState("");

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost self-start" onClick={() => setOpen(true)}>
        Release
      </button>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!recipientOrgId || !conditionRef.trim()) {
      setError("Recipient organization and condition reference are both required.");
      return;
    }
    const token = readCsrfTokenFromCookie();
    if (!token) {
      setError("Session expired — please sign in again.");
      return;
    }
    setBusy(true);
    try {
      const result = await apiClient.releaseLockbox(lockboxId, { recipientOrgId, conditionRef: conditionRef.trim() }, token);
      onReleased(result.disclosedPayload);
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Release failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel-2 flex flex-col gap-3 p-4">
      <div className="mono-label">Release this Lockbox</div>
      <p className="text-[12px] leading-relaxed text-ink-3">
        Combines the OPERATOR + ESCROW threshold shares (real Shamir reconstruction, real
        AES-256-GCM decryption) and discloses the sealed contents to the named recipient, under a
        controlled condition reference. Only under a committed match/deal — see ADR-0001/ADR-0009.
      </p>
      <label className="flex flex-col gap-1.5">
        <span className="mono-label">Recipient organization</span>
        <select className="field-input" value={recipientOrgId} onChange={(e) => setRecipientOrgId(e.target.value)}>
          {organizations.length === 0 && <option value="">No organizations available</option>}
          {organizations.map((org) => (
            <option key={org.id} value={org.id}>
              {org.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="mono-label">Condition reference (the committed match/deal this release satisfies)</span>
        <input
          className="field-input"
          value={conditionRef}
          onChange={(e) => setConditionRef(e.target.value)}
          placeholder="DealCondition id"
        />
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-go">
          Confirm release
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
