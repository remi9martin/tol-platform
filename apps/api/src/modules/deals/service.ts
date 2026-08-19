// apps/api/src/modules/deals/service.ts — the spec (P14 gate).
//
// Every function here loads the parent DealRoom first, computes
// `isParticipant` via a real DealRoomParticipant lookup, then calls
// can() once against the DealRoom resource — child rows (DealCondition/
// DealDecision) are authorized through their PARENT's decision, never
// independently (ADR-0008). This mirrors rfqs/service.ts's
// isParticipant pattern exactly, for the platform's other two-sided
// resource.

import { assertValidDealConditionTransition, assertValidDealRoomTransition } from "@tol/domain";
import { can, type Actor } from "@tol/authz";
import {
  dealConditionRepository,
  dealDecisionRepository,
  dealRoomParticipantRepository,
  dealRoomRepository,
  domainEventRepository,
  prisma,
  type DealCondition,
  type DealDecision,
  type DealRoom,
  type DealRoomParticipant,
  type DomainEvent,
} from "@tol/db";
import type { PostConditionRequest, RecordDecisionRequest, ResolveConditionRequest } from "@tol/contracts";
import { ProblemError } from "../../shared/errors.js";
import { auditWriter } from "../../shared/audit.js";
import { timelineWriter } from "../../shared/timeline.js";
import { withTransaction } from "../../shared/transaction.js";
import type { RequestContext } from "../../shared/request-context.js";

const CROSS_ORG_DEAL_ROLES = new Set(["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "COMPLIANCE_REVIEWER", "AUDITOR_READONLY"]);

export interface DealRoomDetail {
  dealRoom: DealRoom;
  participants: DealRoomParticipant[];
  conditions: DealCondition[];
  decisions: DealDecision[];
}

/** Loads the DealRoom and computes isParticipant for `actor` — shared by every function below so the lookup logic lives in exactly one place. */
async function loadDealRoomAndAuthContext(actor: Actor, dealRoomId: string): Promise<{ dealRoom: DealRoom; isParticipant: boolean }> {
  const dealRoom = await dealRoomRepository.findById(prisma, dealRoomId);
  if (!dealRoom) throw ProblemError.notFound("Deal room not found.");

  const participant = actor.organizationId
    ? await dealRoomParticipantRepository.findByDealRoomAndOrg(prisma, dealRoomId, actor.organizationId)
    : null;

  return { dealRoom, isParticipant: participant !== null };
}

export const dealsService = {
  async getById(actor: Actor, id: string): Promise<DealRoomDetail> {
    const { dealRoom, isParticipant } = await loadDealRoomAndAuthContext(actor, id);

    const decision = can(
      actor,
      "deal.read",
      { type: "deal_room", id: dealRoom.id, ownerOrgId: dealRoom.merchantOrgId },
      { isParticipant },
    );
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const [participants, conditions, decisions] = await Promise.all([
      dealRoomParticipantRepository.listByDealRoom(prisma, id),
      dealConditionRepository.listByDealRoom(prisma, id),
      dealDecisionRepository.listByDealRoom(prisma, id),
    ]);

    return { dealRoom, participants, conditions, decisions };
  },

  /** Collection-level gate, same isParticipant:true-unconditionally discipline as rfqsService.list — the real scoping is the repository query chosen below. */
  async list(actor: Actor): Promise<DealRoom[]> {
    const decision = can(
      actor,
      "deal.list",
      { type: "deal_room", ownerOrgId: actor.organizationId },
      { isParticipant: true },
    );
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    if (actor.role !== null && CROSS_ORG_DEAL_ROLES.has(actor.role)) {
      return dealRoomRepository.list(prisma);
    }
    return actor.organizationId ? dealRoomRepository.listByOrg(prisma, actor.organizationId) : [];
  },

  /** p.22 "Timeline" — merges the DealRoom's own events with its originating RFQ's (so "RFQ sent"/"Quote submitted" entries from before the deal existed still render), chronological. */
  async getTimeline(actor: Actor, id: string): Promise<DomainEvent[]> {
    const { dealRoom, isParticipant } = await loadDealRoomAndAuthContext(actor, id);

    const decision = can(
      actor,
      "deal.read",
      { type: "deal_room", id: dealRoom.id, ownerOrgId: dealRoom.merchantOrgId },
      { isParticipant },
    );
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    return domainEventRepository.listByAggregates(prisma, [
      { aggregateType: "deal_room", aggregateId: dealRoom.id },
      { aggregateType: "rfq", aggregateId: dealRoom.rfqId },
    ]);
  },

  async postCondition(
    actor: Actor,
    dealRoomId: string,
    input: PostConditionRequest,
    context: RequestContext,
  ): Promise<DealCondition> {
    const { dealRoom, isParticipant } = await loadDealRoomAndAuthContext(actor, dealRoomId);

    const decision = can(
      actor,
      "deal.post_condition",
      { type: "deal_room", id: dealRoom.id, ownerOrgId: dealRoom.merchantOrgId },
      { isParticipant },
    );
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    // p.21: a condition's `ownerOrgId` names WHO OWES it, which need not
    // be the poster (e.g. the provider posts "merchant must supply UBO
    // docs", ownerOrgId = merchant) — but it must still be one of the
    // deal's two real counterparties, not an arbitrary third org.
    if (input.ownerOrgId !== dealRoom.merchantOrgId && input.ownerOrgId !== dealRoom.providerOrgId) {
      throw ProblemError.badRequest("ownerOrgId must be one of this deal room's two counterparties.");
    }

    return withTransaction(async (tx) => {
      // ADVISORY LOCK, keyed by the deal room's own id — closes a gap
      // the re-read-fresh-inside-tx pattern alone does NOT close
      // (concurrency-audit clean-window pass, a later, propagating
      // claims/service.ts's established idiom to this module, which had
      // the re-read guard but no lock): under Postgres's default READ
      // COMMITTED isolation, two truly concurrent mutations against the
      // SAME deal room (e.g. this postCondition() racing a concurrent
      // recordDecision()) could each independently re-read the same
      // pre-commit DealRoom status and both proceed, with whichever
      // commits last silently overwriting the other's stage transition
      // — the SECOND transaction's UPDATE only blocks on Postgres's row
      // lock AFTER the first commits, by which point it's too late for
      // its ALREADY-PASSED checks to reflect the first's outcome.
      // pg_advisory_xact_lock serializes concurrent transactions on the
      // SAME dealRoomId: the second transaction blocks here until the
      // first commits or rolls back, so its own fresh read below is
      // guaranteed to observe the first transaction's committed result.
      // Scoped to the deal room as a whole (not the specific condition/
      // decision row) so it also serializes against every OTHER mutating
      // function in this file touching the SAME deal room at the same
      // instant, matching claims' own "lock the shared aggregate, not
      // just the child row" precedent.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dealRoom.id}))`;

      const condition = await dealConditionRepository.create(tx, {
        dealRoomId: dealRoom.id,
        description: input.description,
        ownerOrgId: input.ownerOrgId,
        evidenceRef: input.evidenceRef ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        blocking: input.blocking ?? true,
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      // Re-read the DealRoom fresh inside the transaction (and now
      // inside the lock) rather than trusting the pre-transaction
      // `dealRoom` snapshot — closes the same class of check-then-act
      // race fixed in rfqs/service.ts (submitQuote/selectQuote),
      // independently corroborated by THIS block's own review
      // (review, MAJOR "service.ts:146-150...
      // TOCTOU race") and applied consistently to
      // postCondition/resolveCondition/recordDecision.
      const freshDealRoom = await dealRoomRepository.findById(tx, dealRoom.id);
      if (!freshDealRoom) throw ProblemError.internal("Deal room disappeared mid-transaction.");

      let stageChanged = false;
      if (freshDealRoom.status === "OPEN") {
        assertValidDealRoomTransition("OPEN", "CONDITIONS");
        await dealRoomRepository.updateStatus(tx, dealRoom.id, "CONDITIONS", actor.userId);
        stageChanged = true;
      }

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: dealRoom.merchantOrgId,
        action: "deal.condition_posted",
        resourceType: "deal_room",
        resourceId: dealRoom.id,
        afterValue: { conditionId: condition.id, ownerOrgId: condition.ownerOrgId, blocking: condition.blocking },
      });
      const timeline = timelineWriter(context);
      await timeline.write(tx, {
        eventType: "deal.condition_created",
        aggregateType: "deal_room",
        aggregateId: dealRoom.id,
        payload: { conditionId: condition.id, ownerOrgId: condition.ownerOrgId, blocking: condition.blocking },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });
      if (stageChanged) {
        await timeline.write(tx, {
          eventType: "deal.stage_changed",
          aggregateType: "deal_room",
          aggregateId: dealRoom.id,
          payload: { from: "OPEN", to: "CONDITIONS" },
          actorUserId: actor.userId,
          actorOrgId: actor.organizationId,
          actorRole: actor.role,
        });
      }

      return condition;
    });
  },

  async resolveCondition(
    actor: Actor,
    dealRoomId: string,
    conditionId: string,
    input: ResolveConditionRequest,
    context: RequestContext,
  ): Promise<DealCondition> {
    const { dealRoom, isParticipant } = await loadDealRoomAndAuthContext(actor, dealRoomId);

    const decision = can(
      actor,
      "deal.resolve_condition",
      { type: "deal_room", id: dealRoom.id, ownerOrgId: dealRoom.merchantOrgId },
      { isParticipant },
    );
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const condition = await dealConditionRepository.findById(prisma, conditionId);
    if (!condition || condition.dealRoomId !== dealRoom.id) throw ProblemError.notFound("Condition not found on this deal room.");

    // Fast, cheap pre-check for the common case — the AUTHORITATIVE
    // check is the re-read-inside-the-transaction below (real BLOCKER,
    // independently corroborated during review: two concurrent resolves on the
    // same condition could otherwise both pass this outer check against
    // the same stale PENDING snapshot, and the second write would
    // silently overwrite the first's result with no conflict detection).
    assertValidDealConditionTransition(condition.state, input.state);

    return withTransaction(async (tx) => {
      // ADVISORY LOCK — same key/reasoning as postCondition()'s own lock
      // above: locked on the PARENT dealRoomId (not this condition's own
      // id), so it also serializes against a concurrent postCondition()/
      // recordDecision() call on the SAME deal room, not just against
      // another resolveCondition() racing this exact condition.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dealRoom.id}))`;

      const freshCondition = await dealConditionRepository.findById(tx, condition.id);
      if (!freshCondition) throw ProblemError.internal("Condition disappeared mid-transaction.");
      assertValidDealConditionTransition(freshCondition.state, input.state);

      const updated = await dealConditionRepository.updateState(
        tx,
        condition.id,
        input.state,
        input.resolutionNote ?? null,
        actor.userId,
      );

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: dealRoom.merchantOrgId,
        action: "deal.condition_resolved",
        resourceType: "deal_room",
        resourceId: dealRoom.id,
        beforeValue: { state: condition.state },
        afterValue: { state: updated.state },
        reason: input.resolutionNote,
      });
      await timelineWriter(context).write(tx, {
        eventType: "deal.condition_resolved",
        aggregateType: "deal_room",
        aggregateId: dealRoom.id,
        payload: { conditionId: updated.id, state: updated.state },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return updated;
    });
  },

  async recordDecision(
    actor: Actor,
    dealRoomId: string,
    input: RecordDecisionRequest,
    context: RequestContext,
  ): Promise<DealDecision> {
    const { dealRoom, isParticipant } = await loadDealRoomAndAuthContext(actor, dealRoomId);

    const decision = can(
      actor,
      "deal.record_decision",
      { type: "deal_room", id: dealRoom.id, ownerOrgId: dealRoom.merchantOrgId },
      { isParticipant },
    );
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    // APPROVAL/DECLINE drive the DealRoom's own stage forward when the
    // current status is a real predecessor — an EXCEPTION never changes
    // status (p.22: exceptions are recorded alongside the normal flow,
    // not a replacement for it). This OUTER computation is a fast,
    // cheap pre-check for the common case (rejects an obviously invalid
    // decision before opening a transaction) — the AUTHORITATIVE
    // computation happens INSIDE the transaction below, against a fresh
    // read, same fix as postCondition/resolveCondition (real race,
    // corroborated by this block's own review
    // "review": two concurrent decisions — e.g. an APPROVAL
    // and a DECLINE — could otherwise both read the same stale
    // "CONDITIONS" status and both pass validation, with whichever
    // commits last silently overwriting the other's outcome).
    function computeNextStatus(currentStatus: typeof dealRoom.status): "APPROVED" | "DECLINED" | null {
      if (input.decisionType === "APPROVAL" && (currentStatus === "OPEN" || currentStatus === "CONDITIONS")) {
        return "APPROVED";
      }
      if (input.decisionType === "DECLINE" && (currentStatus === "OPEN" || currentStatus === "CONDITIONS")) {
        return "DECLINED";
      }
      return null;
    }
    const provisionalNextStatus = computeNextStatus(dealRoom.status);
    if (provisionalNextStatus) {
      assertValidDealRoomTransition(dealRoom.status, provisionalNextStatus);
    }

    return withTransaction(async (tx) => {
      // ADVISORY LOCK — same key/reasoning as postCondition()'s own lock
      // above: locked on dealRoomId so this serializes against a
      // concurrent postCondition()/resolveCondition()/recordDecision()
      // call on the SAME deal room (e.g. two concurrent decisions — an
      // APPROVAL and a DECLINE — that would otherwise both read the same
      // stale status and both pass validation, silently overwriting one
      // another's outcome, exactly this function's own pre-existing
      // comment already names as the risk the re-read alone doesn't
      // fully close).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dealRoom.id}))`;

      const freshDealRoom = await dealRoomRepository.findById(tx, dealRoom.id);
      if (!freshDealRoom) throw ProblemError.internal("Deal room disappeared mid-transaction.");
      const nextStatus = computeNextStatus(freshDealRoom.status);
      if (nextStatus) {
        assertValidDealRoomTransition(freshDealRoom.status, nextStatus);
      }

      const decisionRow = await dealDecisionRepository.create(tx, {
        dealRoomId: dealRoom.id,
        decisionType: input.decisionType,
        reason: input.reason,
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      if (nextStatus) {
        await dealRoomRepository.updateStatus(tx, dealRoom.id, nextStatus, actor.userId);
      }

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: dealRoom.merchantOrgId,
        action: "deal.decision_recorded",
        resourceType: "deal_room",
        resourceId: dealRoom.id,
        reason: input.reason,
        afterValue: { decisionId: decisionRow.id, decisionType: input.decisionType, nextStatus },
      });
      const timeline = timelineWriter(context);
      await timeline.write(tx, {
        eventType: "deal.decision_recorded",
        aggregateType: "deal_room",
        aggregateId: dealRoom.id,
        payload: { decisionId: decisionRow.id, decisionType: input.decisionType },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });
      if (nextStatus) {
        await timeline.write(tx, {
          eventType: "deal.stage_changed",
          aggregateType: "deal_room",
          aggregateId: dealRoom.id,
          payload: { from: freshDealRoom.status, to: nextStatus },
          actorUserId: actor.userId,
          actorOrgId: actor.organizationId,
          actorRole: actor.role,
        });
      }

      return decisionRow;
    });
  },
};
