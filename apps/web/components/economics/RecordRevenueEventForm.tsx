"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";
import type { CommissionBasis } from "@tol/contracts";

// apps/web/components/economics/RecordRevenueEventForm.tsx — the
// "economics engages" action (economics.record — FINANCE_OPERATOR/
// PLATFORM_OWNER only, apps/api can()-enforced regardless of what
// renders here). netDistributableMinor is never computed client-side —
// the server always derives it from gross - deductions (packages/
// contracts' own RecordRevenueEventRequestSchema has no such field at
// all) — this form only collects the SOURCE figures. Same
// busy/error/CSRF-token shape as EvaluateMatchesButton.tsx.

export function RecordRevenueEventForm({ dealRoomId, basis, currency }: { dealRoomId: string; basis: CommissionBasis; currency: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState("");
  const [source, setSource] = useState("processing_volume");
  const [gross, setGross] = useState("");
  const [deductions, setDeductions] = useState("");

  async function run(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const token = readCsrfTokenFromCookie();
    if (!token) {
      setError("Session expired — please sign in again.");
      return;
    }
    if (!/^\d+$/.test(gross.trim())) {
      setError("Gross amount must be a non-negative whole number of minor units (e.g. 500000 for $5,000.00).");
      return;
    }
    if (deductions.trim() && !/^\d+$/.test(deductions.trim())) {
      setError("Deductions must be a non-negative whole number of minor units.");
      return;
    }
    if (!period.trim()) {
      setError("Period is required (e.g. 2026-08).");
      return;
    }
    setBusy(true);
    try {
      await apiClient.recordRevenueEvent(
        dealRoomId,
        { basis, period: period.trim(), source: source.trim(), grossAmountMinor: gross.trim(), deductionsMinor: deductions.trim() || undefined, currency },
        token,
      );
      setPeriod("");
      setGross("");
      setDeductions("");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Recording revenue failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel-2 flex flex-col gap-3 p-4">
      <div className="mono-label">Record revenue</div>
      <p className="text-[12px] leading-relaxed text-ink-3">
        Computes the real split via the schedule&apos;s active components (the same engine every ledger entry below was computed
        by) and persists one ACCRUAL entry per recipient — zero leakage, provably exact.
      </p>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <form onSubmit={run} className="grid grid-cols-2 gap-2">
        <input className="field-input" placeholder="Period (e.g. 2026-08)" value={period} onChange={(e) => setPeriod(e.target.value)} />
        <input className="field-input" placeholder="Source (e.g. processing_volume)" value={source} onChange={(e) => setSource(e.target.value)} />
        <input className="field-input" placeholder={`Gross amount (minor units, ${currency})`} inputMode="numeric" value={gross} onChange={(e) => setGross(e.target.value)} />
        <input className="field-input" placeholder="Deductions (minor units, optional)" inputMode="numeric" value={deductions} onChange={(e) => setDeductions(e.target.value)} />
        <div className="col-span-2">
          <button type="submit" disabled={busy} className="btn btn-go">
            {busy ? "Recording…" : "Record revenue"}
          </button>
        </div>
      </form>
    </div>
  );
}
