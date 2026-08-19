// packages/evidence/src/config.ts
//
// the spec does not enumerate a fixed list of which Passport fields
// are REQUIRED for readiness — same documented-inference discipline as
// @tol/attribution/src/config.ts's own scoring bands. This list is
// grounded in the scope's own recurring field vocabulary for
// institution-level trust: corporate identity (p.13 Organization:
// registrationId/verificationStatus), a named authorized contact (p.13
// Person), processing/relationship history (p.15 VolumeSummary echoed
// at the org level), risk posture (p.15 RiskSnapshot), settlement
// capability (p.16 SettlementCapability), and technical integration
// readiness (p.15 TechnicalRequirement / p.16 TechnicalCapability) — the
// same six categories @tol/domain/src/passport-states.ts's
// PassportSectionType enum names, one or two required facts per
// section. Configurable/revisitable, same "documented inference, not
// scope-verbatim" stance as every other numeric/enumerated band this
// codebase infers (attribution's proximityScoreByTier, evidence's own
// freshness-window constants below).

import type { RequiredFact } from "./types.js";

export const EVIDENCE_CONFIG = {
  /** Bumped only on a genuine change to this file's REQUIRED_FACTS list or the readiness scoring math — every persisted ReadinessResult.algorithmVersion is a direct stamp of this constant (the spec: "record... algorithmVersion... so historical decisions can be reproduced"). */
  algorithmVersion: "evidence-readiness-v1",
  /** Independent of algorithmVersion — bumped when the readiness RULE SET changes (which facts are required/blocking) without the underlying scoring arithmetic changing, same algorithmVersion-vs-ruleVersion split @tol/attribution's ClaimDecision.ruleVersion already establishes. */
  ruleVersion: "evidence-rules-v1",

  /**
   * The six blocking-or-warning required facts a Passport is judged
   * against. `blocking: true` facts must all be present (a non-null
   * Fact.normalizedValue) for a Passport to reach READY; `blocking:
   * false` facts contribute to the completeness SCORE and generate a
   * WARNING when absent, but do not by themselves prevent READY — same
   * blocker-vs-warning split ReadinessResult's own two array fields
   * (schema.prisma) exist to carry.
   */
  requiredFacts: [
    { fieldKey: "legalEntityConfirmed", sectionType: "IDENTITY", blocking: true, label: "Legal entity / registration confirmed" },
    { fieldKey: "primaryContactConfirmed", sectionType: "IDENTITY", blocking: true, label: "Named, verified primary contact" },
    { fieldKey: "processingHistorySummary", sectionType: "PROCESSING_METRICS", blocking: true, label: "Processing history summary" },
    { fieldKey: "riskProfileSummary", sectionType: "RISK", blocking: true, label: "Risk profile summary (CB / fraud / refund posture)" },
    { fieldKey: "settlementCapability", sectionType: "COMMERCIAL", blocking: true, label: "Settlement capability (currency / rail / cadence)" },
    { fieldKey: "technicalIntegrationProfile", sectionType: "TECHNICAL", blocking: true, label: "Technical integration profile" },
    { fieldKey: "priorAcquirerRelationships", sectionType: "RELATIONSHIP_HISTORY", blocking: false, label: "Prior acquirer / provider relationships" },
    { fieldKey: "chargebackHistoryDetail", sectionType: "RISK", blocking: false, label: "Detailed chargeback history" },
  ] as const satisfies readonly RequiredFact[],

  /**
   * the spec acceptance example: "user can distinguish real active
   * capacity from discovery leads and stale profiles within 10
   * seconds." Not scope-specified numerically — documented inference,
   * matching @tol/attribution/src/config.ts's own banding style. A
   * CapacityProfile confirmed (asOf) within `freshDays` is FRESH; within
   * `agingDays` is AGING (ranking penalty applies per p.16); older than
   * that is STALE. UNKNOWN is NOT reached by aging at all — see
   * freshness.ts's classifyCapacityFreshness doc comment for why it is
   * a `sourceType`-driven override layered on top of this age ladder,
   * not a fourth age band.
   */
  capacityFreshnessWindowDays: { fresh: 30, aging: 90 },

  /**
   * Passport Fact/Evidence freshness, judged against `expiresAt`
   * (either the Fact's own effectiveTo or its linked Evidence's
   * expiresAt — see types.ts's FactSnapshot.expiresAt comment) rather
   * than a fixed age-since-confirmation window the way Capacity is —
   * the spec: "Expiration is field-specific: corporate registration
   * may refresh on one cadence; processing metrics may be monthly;
   * capacity appetite may be much shorter," i.e. Passport Facts do not
   * share one universal freshness clock the way a CapacityProfile's
   * single `asOf` does. `warnWithinDays` is how close to `expiresAt` a
   * Fact must be to count as AGING rather than FRESH; past `expiresAt`
   * entirely is STALE; no expiry information at all is UNKNOWN.
   */
  factFreshnessWarnWithinDays: 30,
} as const;
