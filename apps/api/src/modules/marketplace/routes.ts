// apps/api/src/modules/marketplace/routes.ts — the spec: "/app/market
// || Visible Marketplace || Anonymized supply/demand inventory and
// filters." Read-only — no mutation exists at the marketplace level (an
// interested party moves to a REAL RFQ/deal flow to act, per the
// existing rfqs/deals modules; browsing never itself creates a
// relationship).

import type { FastifyPluginAsync } from "fastify";
import type { ListMarketplaceCapacityResponse, ListMarketplaceOpportunitiesResponse } from "@tol/contracts";
import { marketplaceService } from "./service.js";

const marketplaceRoutes: FastifyPluginAsync = async (app) => {
  app.get("/market/capacity", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const cards = await marketplaceService.listCapacity(request.actor!);
    const body: ListMarketplaceCapacityResponse = { cards };
    return reply.code(200).send(body);
  });

  app.get("/market/opportunities", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const cards = await marketplaceService.listOpportunities(request.actor!);
    const body: ListMarketplaceOpportunitiesResponse = { cards };
    return reply.code(200).send(body);
  });
};

export default marketplaceRoutes;
