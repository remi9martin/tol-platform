// packages/db — public surface. apps/api and apps/worker import ONLY from
// here (the @tol/db workspace alias), never a deep path into src/internal
// (the spec: "forbid deep imports into another package's internal
// directory") and never @prisma/client directly (the spec: "routes
// never call Prisma directly").

export { prisma, disconnectPrisma } from "./client.js";
export { newId } from "./ids.js";
export { hashPassword, verifyPassword } from "./password.js";
export * from "./repositories/index.js";
// DbClient wasn't part of the public surface before earlier — every prior
// caller (apps/api) only ever passed `prisma`/`tx` INTO repository
// functions without needing to name the union type itself. apps/worker's
// health-check gate (startup-check.ts) is the first caller that needs to
// accept "a DbClient" as its own parameter type.
export type { DbClient } from "./repositories/types.js";
// earlier: apps/worker's startup/readiness consistency gate (the spec
// scenario #5) — see health-check.ts's own header comment.
export { checkDatabaseReachable } from "./health-check.js";
export type { DatabaseHealthResult } from "./health-check.js";

// Re-export the generated Prisma types/enums so downstream packages
// (packages/authz, apps/api, apps/web) have one source of truth for the
// PersonaRole / DisclosureClass / etc vocabulary instead of redefining it.
export type {
  Organization,
  OrganizationType,
  VerificationStatus,
  Person,
  User,
  UserStatus,
  OrganizationMembership,
  MembershipStatus,
  PersonaRole,
  Session,
  AuditEvent,
  IdempotencyKey,
  DisclosureClass,
  RecordStatus,
  SourceType,
  // ---- earlier: RFQ + Deal Room ----
  Opportunity,
  OpportunityType,
  OpportunityStatus,
  CapacityProfile,
  FreshnessClass,
  RFQ,
  RfqStatus,
  RFQVersion,
  DisclosurePacketType,
  RFQRecipient,
  RfqRecipientState,
  Quote,
  QuoteStatus,
  DealRoom,
  DealRoomStatus,
  DealRoomParticipant,
  DealParticipantRole,
  DealCondition,
  DealConditionState,
  DealDecision,
  DealDecisionType,
  DomainEvent,
  // ---- earlier: Lockbox ----
  Lockbox,
  LockboxStatus,
  LockboxRelationshipType,
  LockboxRegion,
  LockboxShareRole,
  LockboxKeyShare,
  LockboxReceipt,
  LockboxReleaseEvidence,
  // ---- earlier: Attribution ----
  DirectnessTier,
  ClaimEvidenceType,
  EvidenceVerificationState,
  Claim,
  ClaimStatus,
  ClaimEvidence,
  ClaimDecision,
  ClaimDecisionOutcome,
  ClaimAppealStatus,
  ClaimDispute,
  ClaimDisputeStatus,
  ClaimDisputeResolution,
  // ---- earlier: Passport (P6) + Opportunity VolumeSlice (P7) ----
  Passport,
  PassportStatus,
  PassportSectionType,
  Fact,
  FactProvenance,
  Evidence,
  EvidenceSourceKind,
  ReadinessResult,
  VolumeSlice,
  // ---- earlier: Matching (P11 Eligibility + P12 Ranking) ----
  MatchResult,
  // ---- earlier: Economics (P15) ----
  CommissionBasis,
  CommissionScheduleStatus,
  CommissionRecipientType,
  CommissionComponentType,
  LedgerEntryType,
  LedgerDirection,
  CommissionSchedule,
  CommissionComponent,
  RevenueEvent,
  CommissionAccrual,
  CommissionPayment,
} from "@prisma/client";

// `Prisma` is a VALUE export, not type-only — Prisma.PrismaClientKnownRequestError
// and Prisma.JsonNull are runtime values (used for instanceof/sentinel checks by
// apps/api's shared/idempotency.ts and this package's own audit.repository.ts),
// not just a namespace of types.
export { Prisma } from "@prisma/client";
