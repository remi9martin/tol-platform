// apps/api/src/modules/marketplace/service.ts
//
// the spec/p.6 (P5 gate). Unlike every other list() in this codebase,
// this one is NOT scoped to "the actor's own org's rows" vs "every row
// (for cross-org roles)" — every authenticated actor with
// opportunity.browse_market/capacity.browse_market (which is EVERY
// persona, packages/authz/src/matrix.ts) sees the SAME market-wide
// inventory, because that is the entire point of a visible marketplace
// (the spec: "Members can see market depth"). What differs per actor
// is never WHICH rows they see here — it's WHICH FIELDS of each row,
// decided entirely by marketplace/mapper.ts's redactFields() call, not
// by this service filtering rows.
//
// STALE/UNKNOWN profiles are still LISTED (the spec CAPACITY
// INVARIANT names ranking/matching-time exclusion, not marketplace
// visibility — a merchant browsing the market should be able to SEE a
// stale profile exists, precisely so they can judge "real active
// capacity... within 10 seconds" per the p.6 acceptance example; hiding
// stale rows entirely would defeat that).

import { can, type Actor } from "@tol/authz";
import { capacityProfileRepository, opportunityRepository, prisma } from "@tol/db";
import { classifyCapacityFreshness } from "@tol/evidence";
import type { MarketplaceCapacityCard, MarketplaceOpportunityCard } from "@tol/contracts";
import { ProblemError } from "../../shared/errors.js";
import { toMarketplaceCapacityCard, toMarketplaceOpportunityCard } from "./mapper.js";

export const marketplaceService = {
  async listCapacity(actor: Actor): Promise<MarketplaceCapacityCard[]> {
    const decision = can(actor, "capacity.browse_market", { type: "capacity_profile", ownerOrgId: null });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const profiles = await capacityProfileRepository.list(prisma, { limit: 500 });
    const now = new Date();
    return profiles
      .map((profile) => toMarketplaceCapacityCard(actor, profile, classifyCapacityFreshness({ asOf: profile.asOf, sourceType: profile.sourceType }, now)))
      .filter((card): card is MarketplaceCapacityCard => card !== null);
  },

  async listOpportunities(actor: Actor): Promise<MarketplaceOpportunityCard[]> {
    const decision = can(actor, "opportunity.browse_market", { type: "opportunity", ownerOrgId: null });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const opportunities = await opportunityRepository.list(prisma, { limit: 500 });
    return opportunities.map((o) => toMarketplaceOpportunityCard(actor, o)).filter((card): card is MarketplaceOpportunityCard => card !== null);
  },
};
