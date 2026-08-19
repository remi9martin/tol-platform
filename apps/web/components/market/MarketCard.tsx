// apps/web/components/market/MarketCard.tsx — the spec verbatim
// component name: "MarketCard || .../MarketCard.tsx || Safe inventory;
// never leaks private fields." Renders EXACTLY the fields present on
// @tol/contracts' MarketplaceCapacityCard/MarketplaceOpportunityCard —
// deliberately narrow, `.strict()` wire types with no slot for
// providerOrgId/ownerOrgId/commercialTerms/exact figures at all (see
// that schema file's own header comment). This component cannot render
// a private field even by mistake — the TYPE it accepts doesn't have
// one to read.

import type { MarketplaceCapacityCard, MarketplaceOpportunityCard } from "@tol/contracts";
import { FreshnessBadge } from "@/components/shared/FreshnessBadge";
import { shortId } from "@/lib/format";

const VOLUME_BAND_LABELS: Record<string, string> = {
  UNDER_100K: "< $100K/mo",
  "100K_1M": "$100K – $1M/mo",
  "1M_5M": "$1M – $5M/mo",
  "5M_20M": "$5M – $20M/mo",
  "20M_PLUS": "$20M+/mo",
};

const RISK_TIER_TONE: Record<string, string> = { LOW: "chip-ok", MODERATE: "chip-warn", ELEVATED: "chip-red" };

export function CapacityMarketCard({ card }: { card: MarketplaceCapacityCard }) {
  return (
    <div className="panel flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="mono-label">Capacity {shortId(card.cardId)}</span>
        <FreshnessBadge freshnessClass={card.freshnessClass} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {card.jurisdictions.map((j) => (
          <span key={j} className="chip chip-neutral">
            {j}
          </span>
        ))}
        {card.mccsAccepted.map((m) => (
          <span key={m} className="chip chip-neutral">
            MCC {m}
          </span>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-edge pt-3">
        <div>
          <div className="mono-label mb-0.5">Capacity</div>
          <div className="text-sm text-ink">{VOLUME_BAND_LABELS[card.monthlyCapacityBand] ?? card.monthlyCapacityBand}</div>
        </div>
        <div className="text-right">
          <div className="mono-label mb-0.5">Risk tier</div>
          <span className={`chip ${RISK_TIER_TONE[card.riskTier] ?? "chip-neutral"}`}>{card.riskTier}</span>
        </div>
      </div>
      <div className="flex items-center justify-between text-[11px] text-ink-3">
        <span>{card.currency}</span>
        <span>{card.acceptingNewVolume ? "Accepting new volume" : "At capacity"}</span>
      </div>
    </div>
  );
}

export function OpportunityMarketCard({ card }: { card: MarketplaceOpportunityCard }) {
  return (
    <div className="panel flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="mono-label">Opportunity {shortId(card.cardId)}</span>
        <span className="chip chip-neutral">{card.opportunityType}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {card.jurisdictions.map((j) => (
          <span key={j} className="chip chip-neutral">
            {j}
          </span>
        ))}
        {card.mccs.map((m) => (
          <span key={m} className="chip chip-neutral">
            MCC {m}
          </span>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-edge pt-3">
        <div>
          <div className="mono-label mb-0.5">Offered volume</div>
          <div className="text-sm text-ink">{VOLUME_BAND_LABELS[card.offeredVolumeBand] ?? card.offeredVolumeBand}</div>
        </div>
        <span className="chip chip-warn">{card.status}</span>
      </div>
      <div className="text-[11px] text-ink-3">{card.currency}</div>
    </div>
  );
}
