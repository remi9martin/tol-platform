"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";
import type { CommissionBasis } from "@tol/contracts";

const BASIS_OPTIONS: CommissionBasis[] = ["GROSS_PROCESSING_VOLUME", "NET_PLATFORM_REVENUE", "RECEIVED_COMMISSION", "FIXED_FEE", "SETUP_FEE", "OTHER"];

// apps/web/components/economics/CreateScheduleForm.tsx — schedule.manage
// (PLATFORM_OWNER only — apps/api can()-enforced regardless of what
// renders here; p.4's own verbatim "no rate editing without authority"
// ceiling for every other role). Covers the common two-recipient case
// (one contributor + platform margin, both PERCENTAGE_BPS, summing to
// 10000) directly — a schedule needing more components, a FIXED_AMOUNT
// mix, or a claimId-attributed recipient is reachable via the same
// POST endpoint directly, not exposed as its own UI control this pass
// (a named, scoped-down UI surface, not a backend limitation — every
// shape @tol/domain's computeCommissionSplits supports is already
// proven end to end by apps/api's own integration tests).
export function CreateScheduleForm({ dealRoomId, contributorOrgId, platformOrgId }: { dealRoomId: string; contributorOrgId: string; platformOrgId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [basis, setBasis] = useState<CommissionBasis>("GROSS_PROCESSING_VOLUME");
  const [contributorBps, setContributorBps] = useState("8000");

  async function run(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const token = readCsrfTokenFromCookie();
    if (!token) {
      setError("Session expired — please sign in again.");
      return;
    }
    const parsedBps = Number.parseInt(contributorBps.trim(), 10);
    if (!Number.isInteger(parsedBps) || parsedBps < 0 || parsedBps > 10_000) {
      setError("Contributor share must be a whole number of basis points, 0-10000.");
      return;
    }
    setBusy(true);
    try {
      await apiClient.createSchedule(
        dealRoomId,
        {
          basis,
          description: `${(parsedBps / 100).toFixed(0)}% contributor / ${((10_000 - parsedBps) / 100).toFixed(0)}% platform.`,
          components: [
            { recipientType: "CONTRIBUTOR", recipientOrgId: contributorOrgId, componentType: "PERCENTAGE_BPS", bps: parsedBps, priority: 1 },
            { recipientType: "PLATFORM", recipientOrgId: platformOrgId, componentType: "PERCENTAGE_BPS", bps: 10_000 - parsedBps, priority: 2 },
          ],
        },
        token,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Creating the schedule failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel-2 flex flex-col gap-3 p-4">
      <div className="mono-label">Create + activate a schedule</div>
      <p className="text-[12px] leading-relaxed text-ink-3">No active schedule covers this deal yet — nothing to compute revenue against until one exists.</p>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <form onSubmit={run} className="flex flex-col gap-2">
        <select className="field-input" value={basis} onChange={(e) => setBasis(e.target.value as CommissionBasis)}>
          {BASIS_OPTIONS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <input className="field-input" placeholder="Contributor share (bps, e.g. 8000 = 80%)" inputMode="numeric" value={contributorBps} onChange={(e) => setContributorBps(e.target.value)} />
        <button type="submit" disabled={busy} className="btn btn-go">
          {busy ? "Creating…" : "Create + activate"}
        </button>
      </form>
    </div>
  );
}
