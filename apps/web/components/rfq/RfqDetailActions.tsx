"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { QuoteDTO, RFQDTO, RFQRecipientDTO } from "@tol/contracts";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";
import { formatBps, formatMoneyMinor } from "@/lib/format";

/**
 * the spec RFQ rules, made concrete as UI affordances — but the SERVER
 * (packages/authz's can() + @tol/domain's transition validators) is the
 * real enforcement; every branch here is a convenience reflection of
 * what @tol/authz's matrix already decided, same discipline as the
 * OrgSwitcher/TopBar (the spec: "UI uses the same permission
 * vocabulary only to render affordances").
 */
export function RfqDetailActions({
  rfq,
  myRecipient,
  myOrgId,
  isMerchantViewer,
}: {
  rfq: RFQDTO;
  myRecipient: RFQRecipientDTO | null;
  myOrgId: string | null;
  isMerchantViewer: boolean;
}) {
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

  const canRespond = myRecipient && myRecipient.state !== "DECLINED" && myRecipient.state !== "EXPIRED";

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      {myRecipient && canRespond && <SubmitQuoteForm rfqId={rfq.id} busy={busy} onSubmit={run} onCsrf={csrfToken} />}

      {myRecipient && canRespond && (
        <DeclineForm rfqId={rfq.id} busy={busy} onSubmit={run} onCsrf={csrfToken} />
      )}

      {myOrgId &&
        rfq.quotes
          ?.filter((q) => q.providerOrgId === myOrgId && q.status === "SUBMITTED")
          .map((q) => (
            <button
              key={q.id}
              type="button"
              disabled={busy}
              className="btn btn-ghost"
              onClick={() => {
                const token = csrfToken();
                if (!token) return;
                void run(() => apiClient.withdrawQuote(rfq.id, q.id, token));
              }}
            >
              Withdraw quote v{q.quoteVersion}
            </button>
          ))}

      {isMerchantViewer && rfq.status === "QUOTED" && (
        <SelectQuoteSection rfqId={rfq.id} quotes={rfq.quotes ?? []} busy={busy} onSubmit={run} onCsrf={csrfToken} />
      )}
    </div>
  );
}

function DeclineForm({
  rfqId,
  busy,
  onSubmit,
  onCsrf,
}: {
  rfqId: string;
  busy: boolean;
  onSubmit: (fn: () => Promise<unknown>) => Promise<void>;
  onCsrf: () => string | undefined;
}) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost self-start" onClick={() => setOpen(true)}>
        Decline this RFQ
      </button>
    );
  }

  return (
    <form
      className="panel-2 flex flex-col gap-2 p-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const token = onCsrf();
        if (!token) return;
        onSubmit(() => apiClient.declineRfq(rfqId, { declineReason: reason }, token));
      }}
    >
      <label htmlFor="declineReason" className="mono-label">
        Decline reason
      </label>
      <textarea
        id="declineReason"
        required
        className="field-input"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-ghost">
          Confirm decline
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function SubmitQuoteForm({
  rfqId,
  busy,
  onSubmit,
  onCsrf,
}: {
  rfqId: string;
  busy: boolean;
  onSubmit: (fn: () => Promise<unknown>) => Promise<void>;
  onCsrf: () => string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [bps, setBps] = useState(285);
  const [reserveBps, setReserveBps] = useState(500);
  const [monthlyCapacityUSD, setMonthlyCapacityUSD] = useState(1_000_000);
  const [validDays, setValidDays] = useState(7);

  if (!open) {
    return (
      <button type="button" className="btn btn-go self-start" onClick={() => setOpen(true)}>
        Submit a quote
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
        onSubmit(() =>
          apiClient.submitQuote(
            rfqId,
            {
              currency: "USD",
              validUntil: new Date(Date.now() + validDays * 86_400_000).toISOString(),
              terms: {
                rate: { basisType: "blended", bps, scope: "all_volume", passThrough: false },
                reserve: { type: "rolling", bps: reserveBps, durationDays: 90 },
                settlement: { currency: "USD", rail: "ACH", cadenceDays: 2 },
                capacityOffer: {
                  monthlyAmountMinor: Math.round(monthlyCapacityUSD * 100),
                  rampSchedule: "90-day ramp to full capacity",
                  confidenceBps: 8000,
                },
              },
            },
            token,
          ),
        );
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="bps" className="mono-label mb-1 block">
            Blended rate (bps)
          </label>
          <input id="bps" type="number" min={0} className="field-input" value={bps} onChange={(e) => setBps(Number(e.target.value))} />
        </div>
        <div>
          <label htmlFor="reserveBps" className="mono-label mb-1 block">
            Reserve (bps)
          </label>
          <input
            id="reserveBps"
            type="number"
            min={0}
            className="field-input"
            value={reserveBps}
            onChange={(e) => setReserveBps(Number(e.target.value))}
          />
        </div>
        <div>
          <label htmlFor="capacity" className="mono-label mb-1 block">
            Monthly capacity (USD)
          </label>
          <input
            id="capacity"
            type="number"
            min={0}
            className="field-input"
            value={monthlyCapacityUSD}
            onChange={(e) => setMonthlyCapacityUSD(Number(e.target.value))}
          />
        </div>
        <div>
          <label htmlFor="validDays" className="mono-label mb-1 block">
            Valid for (days)
          </label>
          <input
            id="validDays"
            type="number"
            min={1}
            className="field-input"
            value={validDays}
            onChange={(e) => setValidDays(Number(e.target.value))}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-go">
          Send quote
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function SelectQuoteSection({
  rfqId,
  quotes,
  busy,
  onSubmit,
  onCsrf,
}: {
  rfqId: string;
  quotes: QuoteDTO[];
  busy: boolean;
  onSubmit: (fn: () => Promise<unknown>) => Promise<void>;
  onCsrf: () => string | undefined;
}) {
  const [reason, setReason] = useState("");
  const submitted = quotes.filter((q) => q.status === "SUBMITTED");
  if (submitted.length === 0) return null;

  return (
    <div className="panel-2 flex flex-col gap-3 p-4">
      <h3 className="mono-label">Select a quote to open the deal room</h3>
      {submitted.map((q) => (
        <div key={q.id} className="flex items-center justify-between gap-3 rounded-md border border-edge px-3 py-2 text-sm">
          <div>
            <div className="text-ink">
              {formatBps(q.terms.rate.bps ?? 0)} · reserve {formatBps(q.terms.reserve.bps ?? 0)} · capacity{" "}
              {formatMoneyMinor(q.terms.capacityOffer.monthlyAmountMinor, q.currency)}/mo
            </div>
            <div className="mono-label mt-0.5">Provider {q.providerOrgId.slice(0, 8)} · v{q.quoteVersion}</div>
          </div>
          <button
            type="button"
            disabled={busy || !reason.trim()}
            className="btn btn-go shrink-0"
            onClick={() => {
              const token = onCsrf();
              if (!token) return;
              onSubmit(() => apiClient.selectQuote(rfqId, { quoteId: q.id, reason }, token).then((deal) => {
                window.location.href = `/app/deals/${deal.id}`;
              }));
            }}
          >
            Select
          </button>
        </div>
      ))}
      <div>
        <label htmlFor="selectReason" className="mono-label mb-1 block">
          Selection reason (required)
        </label>
        <input
          id="selectReason"
          className="field-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Best blended rate within reserve tolerance…"
        />
      </div>
    </div>
  );
}
