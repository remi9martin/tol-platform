// apps/api/src/modules/matching/service.ts
//
// the spec/p.20 (P11 Eligibility + P12 Ranking). Every mutation follows
// earlier phases's pattern exactly: can() first, a transaction that persists +
// writes BOTH an AuditEvent and a DomainEvent. Eligibility/ranking go
// through @tol/matching's REAL evaluateEligibility()/rankMatches() —
// never hand-computed or fabricated, same anti-fabrication discipline as
// every other derived-output engine in this codebase (the real
// crypto, the real scoreClaim(), the real computeReadiness()).
//
// CANDIDATE POOL: every ACTIVE CapacityProfile, cross-org — no search/
// filter surface exists yet (D11's own "What's explicitly NOT done"
// note: "nothing on this page feeds into P11/P12"), matching the
// reuse-reference prototype's own runMatch(), which evaluates against
// the full acquirer pool.
//
// LIVE-COMPUTED INPUTS, NEVER THE STALE STORED COLUMN:
//   - freshnessClass via @tol/evidence's classifyCapacityFreshness — same
//     "never trust the write-time cache" discipline as capacity/
//     service.ts's own liveFreshness helper.
//   - the provider's Passport status via a staleness-aware read
//     (liveProviderPassportStatus, below) — same reasoning as passport/
//     service.ts's own loadDetailWithStalenessCheck, reimplemented here
//     in miniature rather than imported: this codebase's convention is
//     each module composes packages/db repositories + packages/*
//     engines directly, never another module's service (no module in
//     apps/api/src/modules/* imports from a sibling module's service.ts
//     anywhere in this codebase). Deliberately READ-ONLY here (unlike
//     passport/service.ts's own read path) — matching's internal lookup
//     informs an eligibility computation; persisting an opportunistic
//     STALE transition on a Passport as a SIDE EFFECT of an unrelated
//     "evaluate matching" call would be a surprising, undocumented
//     mutation this endpoint was never asked to own. Passport's own read
//     path remains the one place that persists it.
//
// the spec's own INVARIANT ("eligibility runs first") is enforced at
// THREE independent layers in this build: the pure engine
// (@tol/matching's own architecture — rankMatches only ever sees the
// caller's already-eligible set, never re-derives eligibility itself),
// the repository (matchResultRepository.create's bidirectional guard —
// packages/db), and here (ranking runs EXACTLY ONCE, after every
// candidate's eligibility is already known — never per-candidate before
// the full eligible set exists).
//
// MERCHANT-SIDE RISK PROFILE — a named, deliberate scope cut: @tol/
// matching's RISK rule/factor accepts an optional context.
// merchantRiskProfile, typically resolved from the merchant's own
// Passport RISK-section Facts. This service does NOT populate it —
// Meridian's own seeded RISK fact (packages/db/prisma/seed.ts) is a
// PROVIDER's self-reported capacity-side risk handling, not an
// established fieldKey convention for OPPORTUNITY-side/merchant risk
// history; inventing one here to "fill the field" would be exactly the
// kind of fabrication this codebase's anti-fabrication discipline
// exists to prevent. The engine's own documented, tested fallback (a
// non-blocking neutral default — see @tol/matching's RISK_NO_HISTORY)
// is the honest behavior until a real convention exists. Flagged here,
// not silently absent — see ADR-0012.

import { can, type Actor } from "@tol/authz";
import { isPassportReadinessStale } from "@tol/domain";
import {
  capacityProfileRepository,
  matchResultRepository,
  opportunityRepository,
  passportRepository,
  prisma,
  readinessResultRepository,
  type CapacityProfile,
  type MatchResult,
  type Opportunity,
} from "@tol/db";
import { classifyCapacityFreshness } from "@tol/evidence";
import { evaluateEligibility, rankMatches, MATCHING_CONFIG, type MatchCapacityInput, type MatchContext, type MatchOpportunityInput, type PassportStatusLike } from "@tol/matching";
import type { EvaluateMatchesRequest } from "@tol/contracts";
import { ProblemError } from "../../shared/errors.js";
import { auditWriter } from "../../shared/audit.js";
import { timelineWriter } from "../../shared/timeline.js";
import { withTransaction } from "../../shared/transaction.js";
import type { RequestContext } from "../../shared/request-context.js";

/** Every role with a cross-org match.read/match.list grant (packages/authz/src/matrix.ts). */
const CROSS_ORG_MATCH_READ_ROLES = new Set(["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "PARTNERSHIP_LEAD", "UNDERWRITING_ANALYST", "COMPLIANCE_REVIEWER", "AUDITOR_READONLY"]);

/**
 * Every active candidate is evaluated per pass, capped well above any
 * realistic MVP-scale marketplace — bounding, not filtering (no search/
 * filter surface exists yet, see this file's header comment).
 *
 * ACKNOWLEDGED LIMIT, not silently accepted (review): a marketplace that ever
 * exceeds this many ACTIVE CapacityProfiles would have the oldest ones
 * silently excluded from a single evaluate() pass (capacityProfileRepository.
 * list orders newest-first). The scope-correct fix for that scale is
 * exactly what its own worker table names: "match-recompute || Domain
 * event || opportunityId + ruleVersion || Replace derived result
 * atomically, retain prior result" (p.26) — apps/worker, earlier scope,
 * not this synchronous request/response endpoint's job to solve early
 * (same "on-read computation now, background worker later" split D11
 * part 3 already established for P6/P8's freshness).
 */
const MAX_CANDIDATE_CAPACITIES = 500;

/** Same window as passport/service.ts's own READINESS_STALE_AFTER_DAYS — a local copy, not an import (that constant isn't exported; see this file's header comment on why each module stays self-contained). */
const READINESS_STALE_AFTER_DAYS = 90;

function toMatchOpportunityInput(o: Opportunity): MatchOpportunityInput {
  return {
    id: o.id,
    currency: o.currency,
    jurisdictions: o.jurisdictions as string[],
    mccs: o.mccs as string[],
    movable30dMinor: o.movable30dMinor,
  };
}

function toMatchCapacityInput(c: CapacityProfile, freshnessClass: MatchCapacityInput["freshnessClass"]): MatchCapacityInput {
  return {
    id: c.id,
    currency: c.currency,
    jurisdictions: c.jurisdictions as string[],
    mccsAccepted: c.mccsAccepted as string[],
    mccsExcluded: c.mccsExcluded as string[],
    acceptingNewVolume: c.acceptingNewVolume,
    monthlyCapacityMinor: c.monthlyCapacityMinor,
    minTicketMinor: c.minTicketMinor,
    maxTicketMinor: c.maxTicketMinor,
    maxChargebackBps: c.maxChargebackBps,
    maxFraudBps: c.maxFraudBps,
    maxRefundBps: c.maxRefundBps,
    settlementRail: c.settlementRail,
    settlementCadenceDays: c.settlementCadenceDays,
    freshnessClass,
    commercialTerms: c.commercialTerms as MatchCapacityInput["commercialTerms"],
  };
}

/**
 * Live-computed provider Passport status for the EVIDENCE_LICENSE rule.
 * Returns undefined when the org has no Passport at all — @tol/matching's
 * own EVIDENCE_LICENSE rule already treats undefined as fail-closed
 * BLOCKED, which is the exact right behavior for "no Passport ever
 * created" too (mandatory evidence is definitionally absent).
 */
async function liveProviderPassportStatus(providerOrgId: string, now: Date): Promise<PassportStatusLike | undefined> {
  const passport = await passportRepository.findByOrganizationId(prisma, providerOrgId);
  if (!passport) return undefined;
  const latest = await readinessResultRepository.findLatestByPassport(prisma, passport.id);
  if (latest && isPassportReadinessStale(passport.status, latest.computedAt, now, READINESS_STALE_AFTER_DAYS)) {
    return "STALE";
  }
  return passport.status as PassportStatusLike;
}

export const matchingService = {
  /**
   * Runs a full evaluation pass: every ACTIVE CapacityProfile, cross-org,
   * against this one Opportunity. Eligibility is evaluated for every
   * candidate FIRST; ranking runs exactly ONCE over the resulting
   * eligible subset. All resulting MatchResult rows persist in one
   * transaction, alongside ONE AuditEvent + ONE DomainEvent summarizing
   * the whole pass (not one per candidate — matching this codebase's
   * audit-granularity convention: one user-facing action, one event).
   */
  async evaluate(actor: Actor, opportunityId: string, input: EvaluateMatchesRequest, context: RequestContext): Promise<MatchResult[]> {
    const opportunity = await opportunityRepository.findById(prisma, opportunityId);
    if (!opportunity) throw ProblemError.notFound("Opportunity not found.");

    const decision = can(actor, "matching.evaluate", { type: "match_result", ownerOrgId: opportunity.ownerOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    // Same allowed-status set as rfq.create (rfqs/service.ts) — matching
    // logically precedes/accompanies the RFQ invite step, not a status
    // this build invents independently.
    if (opportunity.status !== "MATCH_READY" && opportunity.status !== "INVITED") {
      throw ProblemError.badRequest(`Opportunity must be MATCH_READY or INVITED to evaluate matches (current status: ${opportunity.status}).`);
    }

    const now = new Date();
    const candidates = await capacityProfileRepository.list(prisma, { limit: MAX_CANDIDATE_CAPACITIES });
    const matchOpportunity = toMatchOpportunityInput(opportunity);
    const baseInputVersions = [`opportunity:${opportunity.id}:v${opportunity.version}`];

    // Evaluate eligibility for EVERY candidate first — nothing is
    // persisted or ranked yet at this point.
    const evaluated = await Promise.all(
      candidates.map(async (capacity) => {
        const freshnessClass = classifyCapacityFreshness({ asOf: capacity.asOf, sourceType: capacity.sourceType }, now);
        const providerPassportStatus = await liveProviderPassportStatus(capacity.providerOrgId, now);
        const matchCapacity = toMatchCapacityInput(capacity, freshnessClass);
        const matchContext: MatchContext = {
          now,
          providerPassportStatus,
          averageTicketMinor: input.averageTicketMinor,
          requiredSettlementRail: input.requiredSettlementRail,
          inputVersions: [...baseInputVersions, `capacity:${capacity.id}:v${capacity.version}`],
        };
        const eligibility = evaluateEligibility(matchOpportunity, matchCapacity, matchContext);
        return { capacity, matchCapacity, eligibility };
      }),
    );

    // Rank the eligible subset EXACTLY ONCE (the spec's own ordering
    // invariant). merchantRiskProfile intentionally absent — see this
    // file's header comment.
    const eligibleEntries = evaluated.filter((e) => e.eligibility.eligible);
    const rankingContext: MatchContext = { now, averageTicketMinor: input.averageTicketMinor, inputVersions: baseInputVersions };
    const ranked = eligibleEntries.length > 0 ? rankMatches(matchOpportunity, eligibleEntries.map((e) => e.matchCapacity), rankingContext) : [];
    const rankByCapacityId = new Map(ranked.map((r) => [r.capacityId, r]));

    const rows = await withTransaction(async (tx) => {
      const created: MatchResult[] = [];
      for (const entry of evaluated) {
        const rankEntry = rankByCapacityId.get(entry.capacity.id);
        const row = await matchResultRepository.create(tx, {
          opportunityId: opportunity.id,
          capacityId: entry.capacity.id,
          eligible: entry.eligibility.eligible,
          eligibilityResults: entry.eligibility.results as unknown as Record<string, unknown>[],
          ruleVersion: entry.eligibility.ruleVersion,
          rankingBreakdown: rankEntry ? (rankEntry.breakdown as unknown as Record<string, unknown>) : null,
          rank: rankEntry?.rank ?? null,
          totalScore: rankEntry?.breakdown.total ?? null,
          algorithmVersion: rankEntry?.breakdown.algorithmVersion ?? null,
          inputVersions: entry.eligibility.inputVersions,
          evaluatedAt: now,
          createdByUserId: actor.userId,
          createdByOrgId: opportunity.ownerOrgId,
        });
        created.push(row);
      }

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: opportunity.ownerOrgId,
        action: "matching.evaluated",
        resourceType: "match_result",
        resourceId: null,
        afterValue: {
          opportunityId: opportunity.id,
          candidateCount: candidates.length,
          eligibleCount: eligibleEntries.length,
          ruleVersion: MATCHING_CONFIG.ruleVersion,
          algorithmVersion: MATCHING_CONFIG.algorithmVersion,
        },
      });
      await timelineWriter(context).write(tx, {
        eventType: "match.computed",
        aggregateType: "opportunity",
        aggregateId: opportunity.id,
        payload: {
          opportunityId: opportunity.id,
          candidateCount: candidates.length,
          eligibleCount: eligibleEntries.length,
          ruleVersion: MATCHING_CONFIG.ruleVersion,
          algorithmVersion: MATCHING_CONFIG.algorithmVersion,
        },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return created;
    });

    return rows;
  },

  /**
   * Reads the latest evaluation per candidate capacity for one
   * opportunity. Collection-level gate (isParticipant: true
   * unconditionally) — same shape as rfqsService.list (see that file's
   * own comment): the actual per-role scoping happens below, not inside
   * can().
   */
  async list(actor: Actor, opportunityId: string): Promise<MatchResult[]> {
    const opportunity = await opportunityRepository.findById(prisma, opportunityId);
    if (!opportunity) throw ProblemError.notFound("Opportunity not found.");

    const decision = can(actor, "match.list", { type: "match_result", ownerOrgId: opportunity.ownerOrgId }, { isParticipant: true });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const all = await matchResultRepository.listLatestByOpportunity(prisma, opportunityId);

    if (actor.role !== null && CROSS_ORG_MATCH_READ_ROLES.has(actor.role)) return all;
    if (actor.organizationId !== null && actor.organizationId === opportunity.ownerOrgId) return all;
    if (actor.role === "ACQUIRER_PROVIDER_USER" && actor.organizationId) {
      const myCapacities = await capacityProfileRepository.listByProviderOrg(prisma, actor.organizationId);
      const myCapacityIds = new Set(myCapacities.map((c) => c.id));
      return all.filter((m) => myCapacityIds.has(m.capacityId));
    }
    return [];
  },
};
