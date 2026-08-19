import type { Metadata } from "next";
import { cookies } from "next/headers";
import { apiClient } from "@/lib/api-client";
import { CapacityMarketCard, OpportunityMarketCard } from "@/components/market/MarketCard";

export const metadata: Metadata = { title: "Visible Marketplace — TOL" };

/**
 * the spec route, verbatim: "/app/market || Visible Marketplace ||
 * Anonymized supply/demand inventory and filters." P5 gate exit
 * condition: "Safe visible inventory works." Every card rendered here
 * is EXACTLY what apps/api's /market/capacity and /market/opportunities
 * returned — this page performs zero additional filtering/hiding of its
 * own; the server-side redaction (apps/api/src/modules/marketplace/
 * mapper.ts, proven in apps/api/tests/integration/marketplace.test.ts
 * against the raw response body) is what makes this page safe to render
 * unconditionally for every persona, not a client-side check here.
 */
export default async function MarketplacePage() {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  const [capacity, opportunities] = await Promise.all([
    apiClient.listMarketCapacity({ cookieHeader }),
    apiClient.listMarketOpportunities({ cookieHeader }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="mono-label mb-2">P5 · Marketplace</div>
        <h1 className="text-2xl font-semibold text-ink">Visible Marketplace</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-ink-2">
          Members can see market depth, categories of capacity and anonymized opportunity
          inventory — named contacts, exact appetite, private rates and underwriting evidence
          remain permissioned (the spec). Every card below is redacted server-side before this
          page ever receives it.
        </p>
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="mono-label">Supply — Provider Capacity ({capacity.cards.length})</h2>
        </div>
        {capacity.cards.length === 0 ? (
          <div className="panel p-5">
            <p className="text-sm text-ink-3">No capacity listed yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {capacity.cards.map((card) => (
              <CapacityMarketCard key={card.cardId} card={card} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="mono-label">Demand — Merchant / PSP Opportunities ({opportunities.cards.length})</h2>
        </div>
        {opportunities.cards.length === 0 ? (
          <div className="panel p-5">
            <p className="text-sm text-ink-3">No opportunities listed yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {opportunities.cards.map((card) => (
              <OpportunityMarketCard key={card.cardId} card={card} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
