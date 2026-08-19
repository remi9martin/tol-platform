// apps/api/src/modules/capacity/service.ts
//
// earlier (P8): freshnessClass is now LIVE-COMPUTED via @tol/evidence's
// REAL classifyCapacityFreshness() on every create AND every read —
// never trusted from client input (removed from the request contract
// entirely, see @tol/contracts/src/capacity.ts's own comment) and never
// just read back off the stored `freshnessClass` column, which is only
// a write-time cache that would otherwise silently go stale the moment
// real time passes without a mutation. The service returns
// `{ profile, freshnessClass }` pairs; the mapper (this stage) takes the
// live value as an explicit argument rather than reading the stored
// column itself — same "service decides, mapper just shapes" division
// of labor as every other module in this codebase.

import { can, type Actor } from "@tol/authz";
import { capacityProfileRepository, prisma, type CapacityProfile, type FreshnessClass } from "@tol/db";
import { parseBigIntMinorUnits } from "@tol/domain";
import { classifyCapacityFreshness } from "@tol/evidence";
import { enqueueCapacityFreshness } from "@tol/queue";
import type { CreateCapacityProfileRequest } from "@tol/contracts";
import { ProblemError } from "../../shared/errors.js";
import { auditWriter } from "../../shared/audit.js";
import { withTransaction } from "../../shared/transaction.js";
import type { RequestContext } from "../../shared/request-context.js";

const CROSS_ORG_READ_ROLES = new Set(["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "PARTNERSHIP_LEAD", "COMPLIANCE_REVIEWER", "AUDITOR_READONLY"]);

export interface CapacityProfileWithLiveFreshness {
  profile: CapacityProfile;
  freshnessClass: FreshnessClass;
}

/** The one place this module reads the clock — every call to classifyCapacityFreshness below passes this SAME `now`, so a single request's response is internally consistent even across a list of many profiles. */
function liveFreshness(profile: CapacityProfile, now: Date): FreshnessClass {
  return classifyCapacityFreshness({ asOf: profile.asOf, sourceType: profile.sourceType }, now);
}

export const capacityService = {
  async getById(actor: Actor, id: string): Promise<CapacityProfileWithLiveFreshness> {
    const profile = await capacityProfileRepository.findById(prisma, id);
    if (!profile) throw ProblemError.notFound("Capacity profile not found.");

    const decision = can(actor, "capacity.read", { type: "capacity_profile", id, ownerOrgId: profile.providerOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    return { profile, freshnessClass: liveFreshness(profile, new Date()) };
  },

  /**
   * Cross-org for operator/partnership-lead/compliance/auditor;
   * own-org otherwise. Note: this endpoint is ALSO how a merchant/
   * operator populates the "which providers can I invite" list when
   * creating an RFQ (apps/web's create-RFQ form) — MERCHANT_PSP_USER has
   * no capacity.list grant at all (matrix.ts), so that specific UI flow
   * goes through the operator's cross-org view, consistent with
   * rfq.create being operator-only this pass.
   */
  async list(actor: Actor): Promise<CapacityProfileWithLiveFreshness[]> {
    const decision = can(actor, "capacity.list", { type: "capacity_profile", ownerOrgId: actor.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const profiles =
      actor.role !== null && CROSS_ORG_READ_ROLES.has(actor.role)
        ? await capacityProfileRepository.list(prisma)
        : actor.organizationId
          ? await capacityProfileRepository.listByProviderOrg(prisma, actor.organizationId)
          : [];

    const now = new Date();
    return profiles.map((profile) => ({ profile, freshnessClass: liveFreshness(profile, now) }));
  },

  async create(actor: Actor, input: CreateCapacityProfileRequest, context: RequestContext): Promise<CapacityProfileWithLiveFreshness> {
    if (!actor.organizationId) throw ProblemError.forbidden("Actor has no active organization membership.");

    const decision = can(actor, "capacity.create", { type: "capacity_profile", ownerOrgId: actor.organizationId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const monthlyCapacityMinor = parseBigIntMinorUnits(input.monthlyCapacityMinor, "monthlyCapacityMinor");
    const now = new Date();
    // A fresh profile's asOf is ALWAYS "now" — a provider confirming
    // capacity through this endpoint is, by construction, confirming it
    // as of this moment; classifyCapacityFreshness then computes FRESH
    // for it deterministically (age 0), the same real function every
    // later read also calls, not a hardcoded literal standing in for
    // what that function would say.
    const freshnessClass = classifyCapacityFreshness({ asOf: now, sourceType: "PLATFORM" }, now);

    const result = await withTransaction(async (tx) => {
      const created = await capacityProfileRepository.create(tx, {
        providerOrgId: actor.organizationId!,
        asOf: now,
        freshnessClass,
        acceptingNewVolume: input.acceptingNewVolume ?? true,
        jurisdictions: input.jurisdictions ?? [],
        mccsAccepted: input.mccsAccepted ?? [],
        mccsExcluded: input.mccsExcluded ?? [],
        currency: input.currency,
        monthlyCapacityMinor,
        minTicketMinor: input.minTicketMinor,
        maxTicketMinor: input.maxTicketMinor,
        maxChargebackBps: input.maxChargebackBps,
        maxFraudBps: input.maxFraudBps,
        maxRefundBps: input.maxRefundBps,
        settlementRail: input.settlementRail,
        settlementCadenceDays: input.settlementCadenceDays,
        commercialTerms: input.commercialTerms,
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: actor.organizationId,
        action: "capacity_profile.created",
        resourceType: "capacity_profile",
        resourceId: created.id,
        afterValue: { freshnessClass: created.freshnessClass, currency: created.currency },
      });

      return { profile: created, freshnessClass };
    });

    // earlier-stage work: event-triggered enqueue ("capacity update ->
    // freshness"). A freshly-created profile's freshnessClass is
    // deterministically FRESH (computed synchronously just above), so this
    // is typically a same-value, compare-before-write no-op today — wired
    // anyway so the event-triggered path exists the moment a real update
    // endpoint lands, and because capacity-freshness.job.ts's own
    // idempotency key (profileId + asOf + newClass) makes a same-value
    // enqueue a cheap, safe no-op, not a wasted one. safeEnqueue-backed,
    // called after commit — see passport/service.ts's create() for the
    // full reasoning this mirrors.
    await enqueueCapacityFreshness(result.profile.id);

    return result;
  },
};
