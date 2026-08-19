// apps/api/src/modules/rfqs/service.ts
//
// the spec (P13 gate). Every mutation here follows the pattern
// exactly: can() first, domain-state-transition validation second
// (@tol/domain, never a raw field write), then a transaction that
// persists + writes BOTH an AuditEvent (who/what, security trail) and a
// DomainEvent (timeline, @tol/events' typed catalog). The one NEW
// wrinkle vs. earlier: RFQ/DealRoom are two-sided resources, so several
// functions here compute `context.isParticipant` via a real
// RFQRecipient lookup BEFORE calling can() (ADR-0008) — that
// lookup is this file's job, never can()'s (can() has no DB access).

import {
  assertValidOpportunityTransition,
  assertValidQuoteTransition,
  assertValidRfqRecipientTransition,
  assertValidRfqTransition,
} from "@tol/domain";
import { can, type Actor } from "@tol/authz";
import {
  dealDecisionRepository,
  dealRoomParticipantRepository,
  dealRoomRepository,
  opportunityRepository,
  organizationRepository,
  prisma,
  Prisma,
  quoteRepository,
  rfqRecipientRepository,
  rfqRepository,
  rfqVersionRepository,
  type DealRoom,
  type Quote,
  type RFQ,
  type RFQRecipient,
  type RFQVersion,
} from "@tol/db";
import type { CreateRfqRequest, DeclineRfqRequest, SelectQuoteRequest, SubmitQuoteRequest } from "@tol/contracts";
import { enqueueRfqExpiry } from "@tol/queue";
import { ProblemError } from "../../shared/errors.js";
import { auditWriter } from "../../shared/audit.js";
import { timelineWriter } from "../../shared/timeline.js";
import { withTransaction } from "../../shared/transaction.js";
import type { RequestContext } from "../../shared/request-context.js";

const CROSS_ORG_RFQ_ROLES = new Set(["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "COMPLIANCE_REVIEWER", "AUDITOR_READONLY"]);

/**
 * Same shape as memberships/service.ts's runUniqueConstraintSafe (earlier)
 * — kept as its own local copy rather than extracted into shared/, per
 * this repo's no-premature-abstraction stance (two independent call
 * sites don't yet justify a shared helper; a third might). This is also
 * the fix for the real BLOCKER packages/db's review flagged on
 * quoteRepository.nextQuoteVersion (review "review-
 * repositories") — the losing side of a concurrent double-submit now
 * gets a clean 409 instead of an unhandled 500.
 */
async function runUniqueConstraintSafe<T>(fn: () => Promise<T>, conflictMessage: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ProblemError.conflict(conflictMessage, true);
    }
    throw err;
  }
}

export interface RfqDetail {
  rfq: RFQ;
  merchantOrgId: string;
  version: RFQVersion | null;
  recipients: RFQRecipient[];
  quotes: Quote[];
}

export const rfqsService = {
  async getById(actor: Actor, id: string): Promise<RfqDetail> {
    const rfq = await rfqRepository.findById(prisma, id);
    if (!rfq) throw ProblemError.notFound("RFQ not found.");
    const opportunity = await opportunityRepository.findById(prisma, rfq.opportunityId);
    if (!opportunity) throw ProblemError.internal("RFQ references a missing opportunity.");

    const recipient = actor.organizationId
      ? await rfqRecipientRepository.findByRfqAndProviderOrg(prisma, id, actor.organizationId)
      : null;

    const decision = can(
      actor,
      "rfq.read",
      { type: "rfq", id: rfq.id, ownerOrgId: opportunity.ownerOrgId },
      { isParticipant: recipient !== null },
    );
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const [version, recipients, quotes] = await Promise.all([
      rfqVersionRepository.findByRfqAndVersion(prisma, id, rfq.currentVersionNumber),
      rfqRecipientRepository.listByRfq(prisma, id),
      quoteRepository.listByRfq(prisma, id),
    ]);

    return { rfq, merchantOrgId: opportunity.ownerOrgId, version, recipients, quotes };
  },

  /**
   * List headers only (no embedded quotes/version/recipients — that's
   * the detail view's job, per this function's own comment on why
   * per-row merchantOrgId resolution isn't worth doing for a summary
   * list). isParticipant:true unconditionally here — this is a
   * COLLECTION-level gate (does this role have ANY right to a
   * participant-scoped RFQ list at all), not an instance check; the
   * actual scoping happens in the repository query chosen below, the
   * same two-layer discipline the organizationsService.list uses.
   */
  async list(actor: Actor): Promise<RFQ[]> {
    const decision = can(actor, "rfq.list", { type: "rfq", ownerOrgId: actor.organizationId }, { isParticipant: true });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    if (actor.role !== null && CROSS_ORG_RFQ_ROLES.has(actor.role)) {
      return rfqRepository.list(prisma);
    }
    if (actor.role === "ACQUIRER_PROVIDER_USER" && actor.organizationId) {
      return rfqRepository.listByInvitedProvider(prisma, actor.organizationId);
    }
    if (actor.organizationId) {
      const myOpportunities = await opportunityRepository.listByOwnerOrg(prisma, actor.organizationId);
      const perOpportunity = await Promise.all(
        myOpportunities.map((o) => rfqRepository.listByOpportunity(prisma, o.id)),
      );
      return perOpportunity.flat();
    }
    return [];
  },

  async create(actor: Actor, input: CreateRfqRequest, context: RequestContext): Promise<RfqDetail> {
    const opportunity = await opportunityRepository.findById(prisma, input.opportunityId);
    if (!opportunity) throw ProblemError.notFound("Opportunity not found.");

    const decision = can(actor, "rfq.create", { type: "rfq", ownerOrgId: opportunity.ownerOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    if (opportunity.status !== "MATCH_READY" && opportunity.status !== "INVITED") {
      throw ProblemError.badRequest(
        `Opportunity must be MATCH_READY or INVITED to receive an RFQ (current status: ${opportunity.status}).`,
      );
    }

    const providers = await organizationRepository.findManyByIds(prisma, input.providerOrgIds);
    if (providers.length !== input.providerOrgIds.length) {
      throw ProblemError.badRequest("One or more invited provider organizations do not exist.");
    }

    const result = await withTransaction(async (tx) => {
      const rfq = await rfqRepository.create(tx, {
        opportunityId: opportunity.id,
        status: "SENT",
        dueAt: new Date(input.dueAt),
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      const version = await rfqVersionRepository.create(tx, {
        rfqId: rfq.id,
        versionNumber: 1,
        packetType: input.packetType,
        disclosureSnapshot: input.disclosureSnapshot,
        changeSummary: null,
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      const recipients: RFQRecipient[] = [];
      for (const providerOrgId of input.providerOrgIds) {
        recipients.push(
          await rfqRecipientRepository.create(tx, {
            rfqId: rfq.id,
            providerOrgId,
            createdByUserId: actor.userId,
            createdByOrgId: actor.organizationId,
          }),
        );
      }

      if (opportunity.status === "MATCH_READY") {
        assertValidOpportunityTransition("MATCH_READY", "INVITED");
        await opportunityRepository.updateStatus(tx, opportunity.id, "INVITED", actor.userId);
      }

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: opportunity.ownerOrgId,
        action: "rfq.created",
        resourceType: "rfq",
        resourceId: rfq.id,
        afterValue: { opportunityId: opportunity.id, providerOrgIds: input.providerOrgIds, dueAt: rfq.dueAt.toISOString() },
      });
      await timelineWriter(context).write(tx, {
        eventType: "rfq.sent",
        aggregateType: "rfq",
        aggregateId: rfq.id,
        payload: { opportunityId: opportunity.id, recipientOrgIds: input.providerOrgIds, versionNumber: 1 },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return { rfq, merchantOrgId: opportunity.ownerOrgId, version, recipients, quotes: [] };
    });

    // earlier-stage work: event-triggered enqueue ("rfq create -> expiry
    // timer"). Uses BullMQ's real delayed-job scheduling (opts.delay) for
    // precise, on-time expiry at dueAt — apps/worker's own scheduled sweep
    // (rfqRepository.listOverdue) remains the fallback/catch-all for any
    // enqueue that's silently dropped (a Redis hiccup at this exact
    // moment, a delayed job lost to a Redis restart, etc.), never the only
    // path to expiry. safeEnqueue-backed, called after commit — see
    // passport/service.ts's create() for the full reasoning this mirrors.
    await enqueueRfqExpiry(result.rfq.id, result.rfq.dueAt.getTime() - Date.now());

    return result;
  },

  async decline(actor: Actor, rfqId: string, input: DeclineRfqRequest, context: RequestContext): Promise<RFQRecipient> {
    const rfq = await rfqRepository.findById(prisma, rfqId);
    if (!rfq) throw ProblemError.notFound("RFQ not found.");
    const opportunity = await opportunityRepository.findById(prisma, rfq.opportunityId);
    if (!opportunity) throw ProblemError.internal("RFQ references a missing opportunity.");

    const recipient = actor.organizationId
      ? await rfqRecipientRepository.findByRfqAndProviderOrg(prisma, rfqId, actor.organizationId)
      : null;

    const decision = can(
      actor,
      "rfq.decline",
      { type: "rfq", id: rfq.id, ownerOrgId: opportunity.ownerOrgId },
      { isParticipant: recipient !== null },
    );
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);
    if (!recipient) throw ProblemError.notFound("You are not an invited recipient of this RFQ.");

    assertValidRfqRecipientTransition(recipient.state, "DECLINED");

    return withTransaction(async (tx) => {
      // ADVISORY LOCK, keyed by the RFQ's own id — closes a gap the
      // re-read-fresh-inside-tx pattern (submitQuote/selectQuote below)
      // alone does NOT close (concurrency-audit clean-window pass,
      // a later, propagating claims/service.ts's established idiom to
      // this module). Locked on rfqId (the parent aggregate for every
      // RFQRecipient/Quote row, not this recipient's own id) so it also
      // serializes against a concurrent submitQuote()/selectQuote() by
      // the SAME provider on the SAME RFQ, not just against another
      // decline() racing this exact recipient.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${rfqId}))`;

      const updated = await rfqRecipientRepository.updateState(tx, recipient.id, "DECLINED", actor.userId, {
        declineReason: input.declineReason,
      });

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: opportunity.ownerOrgId,
        action: "rfq.declined",
        resourceType: "rfq",
        resourceId: rfq.id,
        reason: input.declineReason,
        afterValue: { providerOrgId: recipient.providerOrgId },
      });
      await timelineWriter(context).write(tx, {
        eventType: "rfq.declined",
        aggregateType: "rfq",
        aggregateId: rfq.id,
        payload: { providerOrgId: recipient.providerOrgId, declineReason: input.declineReason },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return updated;
    });
  },

  async submitQuote(actor: Actor, rfqId: string, input: SubmitQuoteRequest, context: RequestContext): Promise<Quote> {
    const rfq = await rfqRepository.findById(prisma, rfqId);
    if (!rfq) throw ProblemError.notFound("RFQ not found.");
    const opportunity = await opportunityRepository.findById(prisma, rfq.opportunityId);
    if (!opportunity) throw ProblemError.internal("RFQ references a missing opportunity.");

    const recipient = actor.organizationId
      ? await rfqRecipientRepository.findByRfqAndProviderOrg(prisma, rfqId, actor.organizationId)
      : null;

    const decision = can(
      actor,
      "rfq.submit_quote",
      { type: "rfq", id: rfq.id, ownerOrgId: opportunity.ownerOrgId },
      { isParticipant: recipient !== null },
    );
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);
    if (!recipient) throw ProblemError.notFound("You are not an invited recipient of this RFQ.");

    // Throws if the recipient already DECLINED/EXPIRED — a provider
    // cannot quote after declining. INVITED/ACKNOWLEDGED/QUOTED (a
    // re-quote/amendment) are all valid entry points.
    assertValidRfqRecipientTransition(recipient.state, "QUOTED");

    return runUniqueConstraintSafe(
      () =>
        withTransaction(async (tx) => {
          // ADVISORY LOCK, keyed by the RFQ's own id — closes a gap the
          // re-read-fresh-inside-tx pattern below alone does NOT close
          // (concurrency-audit clean-window pass, a later): without
          // it, two concurrent mutations on this SAME RFQ (this
          // submitQuote() racing a concurrent selectQuote(), or a second
          // provider's own submitQuote()) could each read the same
          // pre-commit status and both proceed, with whichever commits
          // last silently overwriting the other's transition outcome —
          // the runUniqueConstraintSafe wrapper only protects
          // quoteRepository.nextQuoteVersion's OWN unique constraint,
          // not the RFQ/opportunity status transitions this function
          // also performs.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${rfqId}))`;

          // Re-read RFQ status FRESH inside the transaction (and now
          // inside the lock) rather than trusting the `rfq` snapshot read
          // before the transaction started — self-identified during
          // the review (a real, if narrow, check-then-act race a
          // review only gestured at indirectly, review
          // "review" service.ts:426-427's
          // comparisonSnapshot finding): without this, a concurrent
          // selectQuote() that closes the RFQ between this function's
          // initial read and its own transaction could let a quote slip
          // in AFTER the RFQ was already SELECTED, since the stale outer
          // `rfq.status` would still read QUOTED/SENT and the `if
          // (rfq.status !== "QUOTED")` branch would proceed as if
          // nothing had changed.
          const freshRfq = await rfqRepository.findById(tx, rfq.id);
          if (!freshRfq) throw ProblemError.internal("RFQ disappeared mid-transaction.");
          if (freshRfq.status === "SELECTED" || freshRfq.status === "DECLINED" || freshRfq.status === "EXPIRED") {
            throw ProblemError.conflict(
              `This RFQ is no longer accepting quotes (status: ${freshRfq.status}).`,
            );
          }

          const quoteVersion = await quoteRepository.nextQuoteVersion(tx, recipient.id);
          const quote = await quoteRepository.create(tx, {
            rfqId: rfq.id,
            rfqRecipientId: recipient.id,
            providerOrgId: actor.organizationId!,
            quoteVersion,
            currency: input.currency,
            validUntil: new Date(input.validUntil),
            terms: input.terms,
            createdByUserId: actor.userId,
            createdByOrgId: actor.organizationId,
          });

          if (recipient.state !== "QUOTED") {
            await rfqRecipientRepository.updateState(tx, recipient.id, "QUOTED", actor.userId);
          }
          if (freshRfq.status !== "QUOTED") {
            assertValidRfqTransition(freshRfq.status, "QUOTED");
            await rfqRepository.updateStatus(tx, rfq.id, "QUOTED", actor.userId);
          }
          if (opportunity.status === "INVITED") {
            assertValidOpportunityTransition("INVITED", "QUOTED");
            await opportunityRepository.updateStatus(tx, opportunity.id, "QUOTED", actor.userId);
          }

          await auditWriter(context).write(tx, {
            actorUserId: actor.userId,
            actorOrgId: actor.organizationId,
            actorRole: actor.role,
            subjectOrgId: opportunity.ownerOrgId,
            action: "quote.submitted",
            resourceType: "rfq",
            resourceId: rfq.id,
            afterValue: { quoteId: quote.id, providerOrgId: actor.organizationId, quoteVersion },
          });
          await timelineWriter(context).write(tx, {
            eventType: "quote.submitted",
            aggregateType: "rfq",
            aggregateId: rfq.id,
            payload: { quoteId: quote.id, providerOrgId: actor.organizationId, quoteVersion },
            actorUserId: actor.userId,
            actorOrgId: actor.organizationId,
            actorRole: actor.role,
          });

          return quote;
        }),
      "A quote submission for this RFQ is already being processed — retry once it completes.",
    );
  },

  async withdrawQuote(actor: Actor, rfqId: string, quoteId: string, context: RequestContext): Promise<Quote> {
    const rfq = await rfqRepository.findById(prisma, rfqId);
    if (!rfq) throw ProblemError.notFound("RFQ not found.");
    const opportunity = await opportunityRepository.findById(prisma, rfq.opportunityId);
    if (!opportunity) throw ProblemError.internal("RFQ references a missing opportunity.");

    const quote = await quoteRepository.findById(prisma, quoteId);
    if (!quote || quote.rfqId !== rfq.id) throw ProblemError.notFound("Quote not found on this RFQ.");

    const recipient = actor.organizationId
      ? await rfqRecipientRepository.findByRfqAndProviderOrg(prisma, rfqId, actor.organizationId)
      : null;

    const decision = can(
      actor,
      "rfq.withdraw_quote",
      { type: "rfq", id: rfq.id, ownerOrgId: opportunity.ownerOrgId },
      { isParticipant: recipient !== null },
    );
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    // A data-integrity check distinct from the authz check above: BOTH
    // providers invited to this RFQ are legitimate "participants" of it,
    // but only the quote's OWN provider may withdraw it.
    if (quote.providerOrgId !== actor.organizationId) {
      throw ProblemError.forbidden("You may only withdraw your own quote.");
    }

    // Fast, cheap pre-transaction rejection for the common case — the
    // AUTHORITATIVE check is the re-read-inside-the-lock below.
    assertValidQuoteTransition(quote.status, "WITHDRAWN");

    return withTransaction(async (tx) => {
      // ADVISORY LOCK, keyed by the RFQ's own id — same idiom as
      // decline()/submitQuote()/selectQuote() in this file. This
      // function previously had NEITHER a lock NOR a re-read-inside-tx
      // guard at all (concurrency-audit clean-window pass, a later,
      // found this the most exposed of the four): quote.status SELECTED
      // has zero legal outgoing transitions (packages/domain's
      // QUOTE_TRANSITIONS), so a concurrent selectQuote() racing this
      // withdrawQuote() — without the lock+re-read added here — could
      // let this function blindly overwrite an ALREADY-SELECTED quote
      // (the one a real DealRoom now references as selectedQuoteId)
      // back to WITHDRAWN, corrupting a live deal.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${rfqId}))`;

      // Re-read the Quote fresh INSIDE the transaction (and now inside
      // the lock) — the established check-then-act race guard: a
      // concurrent selectQuote() could have already moved this quote to
      // SELECTED between the pre-checks above and this transaction
      // actually starting.
      const freshQuote = await quoteRepository.findById(tx, quote.id);
      if (!freshQuote) throw ProblemError.internal("Quote disappeared mid-transaction.");
      assertValidQuoteTransition(freshQuote.status, "WITHDRAWN");

      const updated = await quoteRepository.updateStatus(tx, quote.id, "WITHDRAWN", actor.userId);

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: opportunity.ownerOrgId,
        action: "quote.withdrawn",
        resourceType: "rfq",
        resourceId: rfq.id,
        afterValue: { quoteId: quote.id },
      });
      await timelineWriter(context).write(tx, {
        eventType: "quote.withdrawn",
        aggregateType: "rfq",
        aggregateId: rfq.id,
        payload: { quoteId: quote.id, providerOrgId: quote.providerOrgId },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return updated;
    });
  },

  /**
   * THE compound P13->P14 handoff: selecting a quote is the ONE action
   * that opens a DealRoom (ADR-0008 — there is no separate
   * "deal.open" action). One can() check (merchant-only, via the
   * ordinary ownerOrgId path — no isParticipant needed since the
   * merchant IS the RFQ's owner), one transaction: Quote -> SELECTED,
   * RFQ -> SELECTED, Opportunity -> SELECTED, DealRoom created OPEN with
   * both counterparties added as DealRoomParticipant rows, and the
   * QUOTE_SELECTED DealDecision recorded — matching p.21's QuoteDecision
   * (selected/rejected, actor, reason, comparison snapshot) folded into
   * this DealDecision per ADR-0008's consolidation.
   */
  async selectQuote(actor: Actor, rfqId: string, input: SelectQuoteRequest, context: RequestContext): Promise<DealRoom> {
    const rfq = await rfqRepository.findById(prisma, rfqId);
    if (!rfq) throw ProblemError.notFound("RFQ not found.");
    const opportunity = await opportunityRepository.findById(prisma, rfq.opportunityId);
    if (!opportunity) throw ProblemError.internal("RFQ references a missing opportunity.");

    const decision = can(actor, "rfq.select_quote", { type: "rfq", id: rfq.id, ownerOrgId: opportunity.ownerOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const quote = await quoteRepository.findById(prisma, input.quoteId);
    if (!quote || quote.rfqId !== rfq.id) throw ProblemError.notFound("Quote not found on this RFQ.");

    // These three pre-transaction checks are a fast, cheap rejection for
    // the common case (wrong state, obviously invalid request) — the
    // AUTHORITATIVE check is the re-read-inside-the-transaction below
    // (same check-then-act discipline as submitQuote's fix, this block).
    assertValidQuoteTransition(quote.status, "SELECTED");
    assertValidRfqTransition(rfq.status, "SELECTED");
    assertValidOpportunityTransition(opportunity.status, "SELECTED");

    const allQuotesForRfq = await quoteRepository.listByRfq(prisma, rfq.id);

    return runUniqueConstraintSafe(
      () =>
        withTransaction(async (tx) => {
          // ADVISORY LOCK, keyed by the RFQ's own id — same idiom as
          // decline()/submitQuote()/withdrawQuote() above (concurrency-
          // audit clean-window pass, a later). Without it, this
          // function's own re-read below is still vulnerable to the
          // classic "second transaction's UPDATE only blocks on
          // Postgres's row lock AFTER the first commits, by which point
          // it's too late for the already-passed transition check to
          // reflect the first's outcome" race (same shape claims/
          // service.ts's decide() comment documents in full) — e.g. two
          // concurrent selectQuote() calls on two DIFFERENT quotes for
          // the SAME RFQ could otherwise both pass their own checks
          // against a stale pre-commit RFQ status and both create a
          // DealRoom.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${rfqId}))`;

          // Re-read the Quote fresh inside the transaction (and now
          // inside the lock) — guards against a concurrent
          // withdrawQuote() (or a second selectQuote() racing this one)
          // between the pre-checks above and this transaction actually
          // starting. Same check-then-act fix as submitQuote's, applied
          // to the other side of the same race window.
          const freshQuote = await quoteRepository.findById(tx, quote.id);
          if (!freshQuote) throw ProblemError.internal("Quote disappeared mid-transaction.");
          assertValidQuoteTransition(freshQuote.status, "SELECTED");

          const selectedQuote = await quoteRepository.updateStatus(tx, quote.id, "SELECTED", actor.userId);
          await rfqRepository.updateStatus(tx, rfq.id, "SELECTED", actor.userId);
          await opportunityRepository.updateStatus(tx, opportunity.id, "SELECTED", actor.userId);

          const dealRoom = await dealRoomRepository.create(tx, {
            opportunityId: opportunity.id,
            rfqId: rfq.id,
            selectedQuoteId: selectedQuote.id,
            merchantOrgId: opportunity.ownerOrgId,
            providerOrgId: selectedQuote.providerOrgId,
            createdByUserId: actor.userId,
            createdByOrgId: actor.organizationId,
          });

          await dealRoomParticipantRepository.create(tx, {
            dealRoomId: dealRoom.id,
            organizationId: opportunity.ownerOrgId,
            participantRole: "MERCHANT",
            createdByUserId: actor.userId,
            createdByOrgId: actor.organizationId,
          });
          await dealRoomParticipantRepository.create(tx, {
            dealRoomId: dealRoom.id,
            organizationId: selectedQuote.providerOrgId,
            participantRole: "PROVIDER",
            createdByUserId: actor.userId,
            createdByOrgId: actor.organizationId,
          });

          const decisionRow = await dealDecisionRepository.create(tx, {
            dealRoomId: dealRoom.id,
            decisionType: "QUOTE_SELECTED",
            reason: input.reason,
            relatedQuoteId: selectedQuote.id,
            comparisonSnapshot: {
              consideredQuoteIds: allQuotesForRfq.map((q) => q.id),
              selectedQuoteId: selectedQuote.id,
            },
            actorUserId: actor.userId,
            actorOrgId: actor.organizationId,
            actorRole: actor.role,
            createdByUserId: actor.userId,
            createdByOrgId: actor.organizationId,
          });

          await auditWriter(context).write(tx, {
            actorUserId: actor.userId,
            actorOrgId: actor.organizationId,
            actorRole: actor.role,
            subjectOrgId: opportunity.ownerOrgId,
            action: "rfq.quote_selected",
            resourceType: "rfq",
            resourceId: rfq.id,
            reason: input.reason,
            afterValue: { selectedQuoteId: selectedQuote.id, dealRoomId: dealRoom.id },
          });

          const timeline = timelineWriter(context);
          await timeline.write(tx, {
            eventType: "quote.selected",
            aggregateType: "rfq",
            aggregateId: rfq.id,
            payload: { quoteId: selectedQuote.id, dealRoomId: dealRoom.id },
            actorUserId: actor.userId,
            actorOrgId: actor.organizationId,
            actorRole: actor.role,
          });
          await timeline.write(tx, {
            eventType: "deal.opened",
            aggregateType: "deal_room",
            aggregateId: dealRoom.id,
            payload: {
              opportunityId: opportunity.id,
              rfqId: rfq.id,
              selectedQuoteId: selectedQuote.id,
              merchantOrgId: opportunity.ownerOrgId,
              providerOrgId: selectedQuote.providerOrgId,
            },
            actorUserId: actor.userId,
            actorOrgId: actor.organizationId,
            actorRole: actor.role,
          });
          await timeline.write(tx, {
            eventType: "deal.participant_added",
            aggregateType: "deal_room",
            aggregateId: dealRoom.id,
            payload: { organizationId: opportunity.ownerOrgId, participantRole: "MERCHANT" },
            actorUserId: actor.userId,
            actorOrgId: actor.organizationId,
            actorRole: actor.role,
          });
          await timeline.write(tx, {
            eventType: "deal.participant_added",
            aggregateType: "deal_room",
            aggregateId: dealRoom.id,
            payload: { organizationId: selectedQuote.providerOrgId, participantRole: "PROVIDER" },
            actorUserId: actor.userId,
            actorOrgId: actor.organizationId,
            actorRole: actor.role,
          });
          await timeline.write(tx, {
            eventType: "deal.decision_recorded",
            aggregateType: "deal_room",
            aggregateId: dealRoom.id,
            payload: { decisionId: decisionRow.id, decisionType: "QUOTE_SELECTED", relatedQuoteId: selectedQuote.id },
            actorUserId: actor.userId,
            actorOrgId: actor.organizationId,
            actorRole: actor.role,
          });

          return dealRoom;
        }),
      "This RFQ's quote selection is already being processed — retry once it completes.",
    );
  },
};
