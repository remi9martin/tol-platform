"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";

/**
 * the spec: EvaluateMatchesRequestSchema's own comment — "a bare POST
 * runs a full evaluation against every active candidate capacity" — so
 * the primary action needs no fields at all, one click. `averageTicketMinor`/
 * `requiredSettlementRail` are optional sharpening inputs (the contract
 * note: "explicitly wired through, not left inert") exposed here as a
 * collapsed "Advanced" disclosure — same open/closed affordance shape as
 * ClaimActions.tsx's DisputeForm — so they're reachable without cluttering
 * the common one-click case. `canEvaluate` is computed by the calling
 * page from packages/authz's matrix.ts matching.evaluate grant
 * (PLATFORM_OWNER + MARKETPLACE_OPERATOR only); apps/api's own can()
 * re-enforces this regardless of what renders here — this component
 * never re-derives that check, same "server decides, UI reflects" split
 * as every other earlier phases action component.
 */
export function EvaluateMatchesButton({ opportunityId }: { opportunityId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [averageTicket, setAverageTicket] = useState("");
  const [settlementRail, setSettlementRail] = useState("");

  async function run(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    const token = readCsrfTokenFromCookie();
    if (!token) {
      setError("Session expired — please sign in again.");
      return;
    }
    // Validated client-side before the round trip (review MAJOR, earlier-stage work,
    // review): a non-numeric average-ticket value used to reach the server as
    // `Number.parseInt(...)`'s NaN, which JSON.stringify silently turns into `null` —
    // still correctly rejected server-side by EvaluateMatchesRequestSchema (a clean
    // 400, never a crash), but only after a wasted round trip and a less specific
    // error than catching it here.
    const trimmedTicket = averageTicket.trim();
    let averageTicketMinor: number | undefined;
    if (trimmedTicket) {
      const parsed = Number.parseInt(trimmedTicket, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        setError("Average ticket must be a non-negative whole number of minor units.");
        return;
      }
      averageTicketMinor = parsed;
    }
    setBusy(true);
    try {
      const payload: { averageTicketMinor?: number; requiredSettlementRail?: string } = {};
      if (averageTicketMinor !== undefined) payload.averageTicketMinor = averageTicketMinor;
      if (settlementRail.trim()) payload.requiredSettlementRail = settlementRail.trim();
      await apiClient.evaluateMatches(opportunityId, payload, token);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Running matching failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel-2 flex flex-col gap-3 p-4">
      <div className="mono-label">Run matching</div>
      <p className="text-[12px] leading-relaxed text-ink-3">
        Evaluates every active candidate capacity against this opportunity — eligibility (P11) first,
        then ranking (P12) over the eligible subset only. Each run persists a new, versioned MatchResult
        row per candidate; nothing is overwritten in place.
      </p>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {advancedOpen ? (
        <form onSubmit={run} className="flex flex-col gap-2">
          <input
            className="field-input"
            placeholder="Average ticket (minor units, optional)"
            inputMode="numeric"
            value={averageTicket}
            onChange={(e) => setAverageTicket(e.target.value)}
          />
          <input
            className="field-input"
            placeholder="Required settlement rail (optional)"
            value={settlementRail}
            onChange={(e) => setSettlementRail(e.target.value)}
          />
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="btn btn-go">
              {busy ? "Running…" : "Run matching"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setAdvancedOpen(false)}>
              Hide advanced
            </button>
          </div>
        </form>
      ) : (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => run()} className="btn btn-go">
            {busy ? "Running…" : "Run matching"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setAdvancedOpen(true)}>
            Advanced
          </button>
        </div>
      )}
    </div>
  );
}
