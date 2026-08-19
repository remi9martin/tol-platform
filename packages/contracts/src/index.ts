// packages/contracts — public surface. apps/api's route validation and
// apps/web's API client both import ONLY from here (the spec: "All API
// calls use typed contracts from @tol/contracts; no ad hoc fetch response
// parsing"), never redefine a shape locally.
//
// Status: request/response Zod schemas for auth, organizations,
// memberships, audit — exactly the resources this pass's apps/api
// exposes. OpenAPI generation + CI breaking-change checks (the spec,
// p.11: "OpenAPI is generated from @tol/contracts and checked in CI") are
// NOT built this pass — that's CI/tooling infrastructure appropriately
// scoped to when there's a stable-enough surface and a CI pipeline
// (.github/workflows) to check it in, neither of which earlier builds.
// Tracked as an open item, not silently claimed done.

export * from "./common.js";
export * from "./auth.js";
export * from "./organization.js";
export * from "./membership.js";
export * from "./audit.js";
// ---- earlier: RFQ + Deal Room ----
export * from "./opportunity.js";
export * from "./capacity.js";
export * from "./rfq.js";
export * from "./deal.js";
// ---- earlier: Lockbox ----
export * from "./lockbox.js";
// ---- earlier: Attribution ----
export * from "./claim.js";
// ---- earlier: Passport (P6) + Marketplace (P5) ----
export * from "./passport.js";
export * from "./marketplace.js";
// ---- earlier: Matching (P11 Eligibility + P12 Ranking) ----
export * from "./matching.js";
// ---- earlier: Economics (P15) ----
export * from "./economics.js";
