// apps/api/src/modules/economics/service.ts
//
// the spec (Economics, Attribution Ledger & Commission Accounting) +
// P15 exit condition ("Traceable schedule/accrual ledger"). Every
// mutation follows earlier phases's pattern exactly: can() first, a transaction
// that persists + writes BOTH an AuditEvent and a DomainEvent. Splits/
// balances/reconciliation go through @tol/domain's REAL engine — never
// hand-computed, same anti-fabrication discipline as every other derived-
// output engine in this codebase.
//
// ECONOMICS ONLY ENGAGE ONCE A DEAL HAS REACHED AN ACTIVATED/CLOSED
// STATE (this day's own build instructions) — enforced on
// recordRevenueEvent specifically (ACTIVATION/LIVE/ARCHIVED only), NOT
// on createSchedule: a schedule is commercial TERMS, which operators
// realistically negotiate and prepare BEFORE a deal formally activates,
// so it can be ready the moment it does; revenue recording is the actual
// "economics engaging" moment the spec describes. Documented choice,
// ADR-0013.
//
// LEDGER PRIVACY (packages/authz's own commission_accrual design,
// actions.ts's Resource.ownerOrgId comment + can.ts's structural
// hardening): every ledger.* check below passes `ownerOrgId: null` —
// NEVER the deal's real merchantOrgId — and computes `isParticipant`
// from a genuine `recipientOrgId === actor.organizationId` match on the
// ACTUAL accrual rows being read, never inferred from deal membership.

import {
  assertValidCommissionScheduleTransition,
  computeAccrualBalance,
  computeCommissionSplits,
  evaluateScheduleCapFloor,
  reconcileRevenueEvent,
  selectComponentsForBasis,
  assertCurrencyCode,
  assertIntegerBps,
  parseBigIntMinorUnits,
  EconomicsInvariantError,
  ECONOMICS_ENGINE_VERSION,
  type AccrualBalance,
  type CommissionBasis as DomainCommissionBasis,
  type EconomicsComponentInput,
  type ScheduleCapFloorStatus,
} from "@tol/domain";
import { can, type Actor } from "@tol/authz";
import {
  commissionAccrualRepository,
  commissionComponentRepository,
  commissionPaymentRepository,
  commissionScheduleRepository,
  dealRoomRepository,
  prisma,
  Prisma,
  type CommissionAccrual,
  type CommissionComponent,
  type CommissionPayment,
  type CommissionSchedule,
  type DbClient,
  type DealRoom,
  type RevenueEvent,
} from "@tol/db";
import { revenueEventRepository } from "@tol/db";
import type { AdjustLedgerRequest, CreateScheduleRequest, RecordPaymentRequest, RecordRevenueEventRequest } from "@tol/contracts";
import { enqueueEconomicsAccrual } from "@tol/queue";
import { ProblemError } from "../../shared/errors.js";
import { auditWriter } from "../../shared/audit.js";
import { timelineWriter } from "../../shared/timeline.js";
import { withTransaction } from "../../shared/transaction.js";
import type { RequestContext } from "../../shared/request-context.js";

/** Every role with a cross-org schedule/economics/ledger read-or-manage grant (packages/authz/src/matrix.ts). */
const CROSS_ORG_ECONOMICS_ROLES = new Set(["PLATFORM_OWNER", "FINANCE_OPERATOR", "AUDITOR_READONLY"]);
/** The three party-side roles that may see ONLY their own accrual entries (packages/authz's participantActions grant). */
const LEDGER_PARTY_ROLES = new Set(["CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER", "ACQUIRER_PROVIDER_USER"]);
/** A deal's economics only "engage" once it has reached one of these states — see this file's own header comment. */
const ECONOMICS_ELIGIBLE_DEAL_STATUSES = new Set(["ACTIVATION", "LIVE", "ARCHIVED"]);

/**
 * Same shape as memberships/service.ts's and rfqs/service.ts's own
 * runUniqueConstraintSafe — kept as its own local copy rather than
 * extracted into shared/, matching those two files' own stated
 * no-premature-abstraction reasoning ("two independent call sites don't
 * yet justify a shared helper; a third might" — rfqs/service.ts). This
 * is that third call site; still not extracting here, since doing so
 * would mean editing memberships/service.ts and rfqs/service.ts too,
 * outside this pass's scope (a later pass, economics-only) — left
 * as a note for whichever pass next touches either of those two files.
 *
 * Follow-up fix: CommissionPayment.reference is now @unique
 * (packages/db schema.prisma + the commission_payment_reference_unique
 * migration) — recordPayment()'s commissionPaymentRepository.create()
 * call below can now throw a real Prisma P2002 on a reused reference
 * (a retried request, or two different callers coincidentally choosing
 * the same reference). Without this wrapper that would surface as an
 * unhandled 500 instead of a clean, understood 409 — same gap class as
 * the two existing precedents.
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

export interface ScheduleDetail {
  schedule: CommissionSchedule;
  components: CommissionComponent[];
  /** Follow-up fix: null whenever the schedule carries neither a capMinor nor a floorMinor (nothing to disclose) — DISCLOSURE only, see evaluateScheduleCapFloor's own doc comment (economics-engine.ts) for why this pass does not enforce it. */
  capFloorStatus: ScheduleCapFloorStatus | null;
}

export interface AccrualWithBalance {
  accrualRootId: string;
  dealRoomId: string;
  revenueEventId: string;
  scheduleId: string;
  componentId: string;
  recipientOrgId: string;
  claimId: string | null;
  currency: string;
  balance: AccrualBalance;
  entries: CommissionAccrual[];
}

async function loadDealRoom(dealRoomId: string): Promise<DealRoom> {
  const dealRoom = await dealRoomRepository.findById(prisma, dealRoomId);
  if (!dealRoom) throw ProblemError.notFound("Deal room not found.");
  return dealRoom;
}

interface LoadedPayment {
  accrualRootId: string;
  amountMinor: bigint;
  root: CommissionAccrual;
}

/**
 * Loads + validates every named payment in a batch against its REAL,
 * engine-computed outstanding balance — shared by recordPayment()'s
 * fast, cheap pre-check (called against `prisma`) and its AUTHORITATIVE
 * re-check inside the advisory-locked transaction (called against
 * `tx`), same "fast pre-check + authoritative re-read-inside-the-lock"
 * discipline as claims/service.ts's fileDispute()/decide(). Accepts a
 * DbClient rather than being hardcoded to `prisma` (unlike loadDealRoom
 * above) specifically so it can be called both ways.
 */
async function loadAndValidatePayments(
  db: DbClient,
  dealRoomId: string,
  payments: RecordPaymentRequest["payments"],
): Promise<LoadedPayment[]> {
  return Promise.all(
    payments.map(async (p) => {
      const chain = await commissionAccrualRepository.listByAccrualRoot(db, p.accrualRootId);
      if (chain.length === 0 || chain[0]!.dealRoomId !== dealRoomId) {
        throw ProblemError.badRequest(`accrualRootId ${p.accrualRootId} does not reference an accrual on this deal room.`);
      }
      const balance = computeAccrualBalance(chain.map((e) => ({ entryType: e.entryType, direction: e.direction, amountMinor: e.amountMinor })));
      if (balance.status === "REVERSED") {
        throw ProblemError.badRequest(`Accrual ${p.accrualRootId} has been REVERSED — no further payment may be recorded against it.`);
      }
      const amountMinor = parseBigIntMinorUnits(p.amountMinor, `payment[accrualRootId=${p.accrualRootId}].amountMinor`);
      if (amountMinor <= 0n) throw ProblemError.badRequest(`Payment amount for accrual ${p.accrualRootId} must be positive.`);
      if (amountMinor > balance.outstandingAmountMinor) {
        throw ProblemError.badRequest(`Payment amount ${amountMinor} for accrual ${p.accrualRootId} exceeds its outstanding balance ${balance.outstandingAmountMinor}.`);
      }
      return { accrualRootId: p.accrualRootId, amountMinor, root: chain[0]! };
    }),
  );
}

/** recipientOrgId/currency are static fields of the (immutable, never-updated) ACCRUAL root row, so re-deriving them from a freshly-loaded batch is cheap and keeps the batch internally consistent — shared by recordPayment()'s pre-check and authoritative re-check, same reason loadAndValidatePayments above is shared. */
function validateSingleRecipientAndCurrency(loaded: LoadedPayment[]): { recipientOrgId: string; currency: string } {
  const recipientOrgIds = new Set(loaded.map((l) => l.root.recipientOrgId));
  if (recipientOrgIds.size > 1) {
    throw ProblemError.badRequest("A single payment batch must cover accruals for exactly one recipient organization.");
  }
  const currencies = new Set(loaded.map((l) => l.root.currency));
  if (currencies.size > 1) {
    throw ProblemError.badRequest("A single payment batch must cover accruals in exactly one currency.");
  }
  return { recipientOrgId: loaded[0]!.root.recipientOrgId, currency: loaded[0]!.root.currency };
}

/** Groups a flat list of CommissionAccrual rows (every entryType) by accrualRootId and computes each group's real balance via the pure engine — never a stored/denormalized status. */
function groupIntoAccruals(rows: readonly CommissionAccrual[]): AccrualWithBalance[] {
  const byRoot = new Map<string, CommissionAccrual[]>();
  for (const row of rows) {
    const group = byRoot.get(row.accrualRootId) ?? [];
    group.push(row);
    byRoot.set(row.accrualRootId, group);
  }
  const result: AccrualWithBalance[] = [];
  for (const [accrualRootId, entries] of byRoot) {
    const root = entries.find((e) => e.entryType === "ACCRUAL");
    if (!root) continue; // structurally unreachable (every accrualRootId originates from a real ACCRUAL row) — defensive skip, never a thrown 500 on a read path.
    const sorted = [...entries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const balance = computeAccrualBalance(sorted.map((e) => ({ entryType: e.entryType, direction: e.direction, amountMinor: e.amountMinor })));
    result.push({
      accrualRootId,
      dealRoomId: root.dealRoomId,
      revenueEventId: root.revenueEventId,
      scheduleId: root.scheduleId,
      componentId: root.componentId,
      recipientOrgId: root.recipientOrgId,
      claimId: root.claimId,
      currency: root.currency,
      balance,
      entries: sorted,
    });
  }
  return result;
}

/**
 * Follow-up fix: null (nothing to disclose) whenever the
 * schedule carries neither a cap nor a floor; otherwise the real,
 * derived cap/floor disclosure for this schedule version, per
 * evaluateScheduleCapFloor's own doc comment (economics-engine.ts).
 * Shared by createSchedule (a fresh schedule has zero accruals yet —
 * cumulativeDistributedMinor is 0n by construction, not queried, since
 * a schedule's id cannot appear on any CommissionAccrual row before the
 * schedule itself exists) and listSchedules (a real DB aggregate via
 * commissionAccrualRepository.sumAccrualAmountByScheduleId).
 */
function toCapFloorStatus(schedule: Pick<CommissionSchedule, "capMinor" | "floorMinor">, cumulativeDistributedMinor: bigint): ScheduleCapFloorStatus | null {
  if (schedule.capMinor === null && schedule.floorMinor === null) return null;
  return evaluateScheduleCapFloor({ capMinor: schedule.capMinor, floorMinor: schedule.floorMinor, cumulativeDistributedMinor });
}

export const economicsService = {
  // ================================================================
  // Schedules
  // ================================================================

  /** schedule.manage covers create + activate + (optionally) supersede in one call — see packages/authz/src/actions.ts's own comment on why there is no separate schedule.create/schedule.activate. */
  async createSchedule(actor: Actor, dealRoomId: string, input: CreateScheduleRequest, context: RequestContext): Promise<ScheduleDetail> {
    const dealRoom = await loadDealRoom(dealRoomId);

    const decision = can(actor, "schedule.manage", { type: "commission_schedule", ownerOrgId: dealRoom.merchantOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    // Follow-up fix: parseBigIntMinorUnits once,
    // up front — same "fast, cheap pre-transaction rejection" shape as
    // loadAndValidatePayments below — so a cap/floor cross-check can run
    // BEFORE opening a transaction, and so the parsed values are reused
    // inside it rather than re-parsed. A schedule with capMinor <
    // floorMinor is a logically self-contradictory configuration (it
    // would be impossible to simultaneously satisfy "distribute at
    // least floorMinor" and "never distribute more than capMinor") —
    // real gap this pass's own review caught (the (removed) review script,
    // review: neither
    // capMinor nor floorMinor was ever cross-validated against the
    // other anywhere). evaluateScheduleCapFloor (economics-engine.ts)
    // deliberately does NOT own this check — it is a pure per-read
    // comparison function, and this is a write-time configuration
    // invariant that only needs checking once, at the boundary where a
    // schedule's cap/floor are first accepted, not on every read.
    const capMinor = input.capMinor ? parseBigIntMinorUnits(input.capMinor, "capMinor") : null;
    const floorMinor = input.floorMinor ? parseBigIntMinorUnits(input.floorMinor, "floorMinor") : null;
    if (capMinor !== null && floorMinor !== null && capMinor < floorMinor) {
      throw ProblemError.badRequest(`capMinor (${capMinor}) must not be less than floorMinor (${floorMinor}) — a schedule cannot promise to distribute at least floorMinor while also capping total distribution below it.`);
    }

    let previous: CommissionSchedule | null = null;
    if (input.supersedesScheduleId) {
      previous = await commissionScheduleRepository.findById(prisma, input.supersedesScheduleId);
      if (!previous || previous.dealRoomId !== dealRoomId) {
        throw ProblemError.badRequest("supersedesScheduleId does not reference an existing schedule for this deal room.");
      }
      if (previous.status !== "ACTIVE") {
        throw ProblemError.badRequest(`Cannot supersede a schedule that is not ACTIVE (current status: ${previous.status}).`);
      }
      assertValidCommissionScheduleTransition(previous.status, "SUPERSEDED");
    }

    const result = await withTransaction(async (tx) => {
      const schedule = await commissionScheduleRepository.create(tx, {
        dealRoomId,
        basis: input.basis,
        status: "DRAFT",
        // Already parsed (parseBigIntMinorUnits, not a bare BigInt(...)
        // call — same guard capacity/service.ts and opportunities/
        // service.ts apply to every wire minor-units string) and
        // cross-validated above, before this transaction opened — reused
        // here rather than re-parsed.
        capMinor,
        floorMinor,
        survivalMonths: input.survivalMonths ?? null,
        description: input.description ?? null,
        previousVersionId: previous?.id ?? null,
        privacyClass: "RESTRICTED",
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      assertValidCommissionScheduleTransition("DRAFT", "ACTIVE");
      const activated = await commissionScheduleRepository.updateStatus(tx, schedule.id, "ACTIVE", actor.userId);

      // Follow-up fix: @tol/contracts' CommissionComponentInputSchema
      // already enforces `bps: z.number().int().min(0).max(10_000)` at
      // the wire boundary — assertIntegerBps here is the SAME defense-
      // in-depth "belt and suspenders" layer money.ts's own header
      // comment describes (contracts validates request shape; this
      // guards any value a service function constructs/re-derives
      // internally), matching the codebase's own existing convention
      // rather than leaving economics as the one money-heavy module with
      // no domain-layer bps guard at all.
      for (const c of input.components) {
        if (c.bps !== undefined) assertIntegerBps(c.bps, `component[recipientOrgId=${c.recipientOrgId}].bps`, 10_000);
      }
      const components = await commissionComponentRepository.createMany(
        tx,
        input.components.map((c) => ({
          scheduleId: schedule.id,
          recipientType: c.recipientType,
          recipientOrgId: c.recipientOrgId,
          componentType: c.componentType,
          bps: c.bps ?? null,
          fixedAmountMinor: c.fixedAmountMinor ? parseBigIntMinorUnits(c.fixedAmountMinor, `component[recipientOrgId=${c.recipientOrgId}].fixedAmountMinor`) : null,
          calculationBasis: c.calculationBasis ?? null,
          priority: c.priority,
          claimId: c.claimId ?? null,
          privacyClass: "RESTRICTED",
          createdByUserId: actor.userId,
          createdByOrgId: actor.organizationId,
        })),
      );

      if (previous) {
        await commissionScheduleRepository.updateStatus(tx, previous.id, "SUPERSEDED", actor.userId);
      }

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: dealRoom.merchantOrgId,
        action: "economics.schedule_created",
        resourceType: "commission_schedule",
        resourceId: activated.id,
        afterValue: { dealRoomId, basis: activated.basis, versionNumber: activated.versionNumber, componentCount: components.length, supersedes: previous?.id ?? null },
      });
      await timelineWriter(context).write(tx, {
        eventType: previous ? "economics.schedule_superseded" : "economics.schedule_created",
        aggregateType: "deal_room",
        aggregateId: dealRoomId,
        payload: { scheduleId: activated.id, versionNumber: activated.versionNumber, basis: activated.basis },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      // cumulativeDistributedMinor is 0n by construction, not queried —
      // this schedule's id cannot appear on any CommissionAccrual row
      // before the schedule itself exists (this is the row being
      // created in this very transaction).
      return { schedule: activated, components, capFloorStatus: toCapFloorStatus(activated, 0n) };
    });

    return result;
  },

  async listSchedules(actor: Actor, dealRoomId: string): Promise<ScheduleDetail[]> {
    const dealRoom = await loadDealRoom(dealRoomId);
    const decision = can(actor, "schedule.list", { type: "commission_schedule", ownerOrgId: dealRoom.merchantOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const schedules = await commissionScheduleRepository.listByDealRoom(prisma, dealRoomId);
    const details = await Promise.all(
      schedules.map(async (schedule) => {
        const components = await commissionComponentRepository.listBySchedule(prisma, schedule.id);
        // Follow-up fix: real DB aggregate, skipped entirely
        // (real query avoided, not just short-circuited after the fact)
        // when the schedule carries no cap/floor at all — the common
        // case, and there is nothing to disclose either way.
        const cumulativeDistributedMinor =
          schedule.capMinor === null && schedule.floorMinor === null ? 0n : await commissionAccrualRepository.sumAccrualAmountByScheduleId(prisma, schedule.id);
        return { schedule, components, capFloorStatus: toCapFloorStatus(schedule, cumulativeDistributedMinor) };
      }),
    );
    return details;
  },

  // ================================================================
  // Revenue events
  // ================================================================

  async recordRevenueEvent(actor: Actor, dealRoomId: string, input: RecordRevenueEventRequest, context: RequestContext): Promise<{ revenueEvent: RevenueEvent; ledgerEntries: CommissionAccrual[]; reconciliation: ReturnType<typeof reconcileRevenueEvent> }> {
    const dealRoom = await loadDealRoom(dealRoomId);

    const decision = can(actor, "economics.record", { type: "revenue_event", ownerOrgId: dealRoom.merchantOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    if (!ECONOMICS_ELIGIBLE_DEAL_STATUSES.has(dealRoom.status)) {
      throw ProblemError.badRequest(`Deal room must be ACTIVATION, LIVE, or ARCHIVED before economics can engage (current status: ${dealRoom.status}).`);
    }

    // Follow-up fix: @tol/contracts' RecordRevenueEventRequestSchema
    // only checks currency.length === 3 at the wire boundary (a
    // repo-wide convention, not economics-specific — see money.ts's own
    // assertCurrencyCode doc comment), which accepts "usd", "12$", or
    // any other 3-code-unit garbage as long as it's the right LENGTH.
    // assertCurrencyCode is the same defense-in-depth "belt and
    // suspenders" layer this codebase already applies elsewhere
    // (capacity/service.ts, opportunities/service.ts via
    // parseBigIntMinorUnits) — real money is about to be split and
    // persisted under whatever this string says, so it fails loud here
    // rather than silently recording a RevenueEvent no downstream
    // currency-matching logic (e.g. validateSingleRecipientAndCurrency,
    // above) can sensibly compare against a real ISO code.
    assertCurrencyCode(input.currency, "currency");

    const existing = await revenueEventRepository.findByDealPeriodSource(prisma, dealRoomId, input.period, input.source);
    if (existing) {
      throw ProblemError.conflict(`A RevenueEvent already exists for deal ${dealRoomId}, period ${input.period}, source "${input.source}".`);
    }

    const activeSchedules = await commissionScheduleRepository.listActiveByDealRoom(prisma, dealRoomId);
    const schedule = activeSchedules.find((s) => s.basis === input.basis);
    if (!schedule) {
      throw ProblemError.badRequest(`No ACTIVE CommissionSchedule covers basis "${input.basis}" for this deal room. Create one first (schedule.manage).`);
    }

    const grossAmountMinor = parseBigIntMinorUnits(input.grossAmountMinor, "grossAmountMinor");
    const deductionsMinor = input.deductionsMinor ? parseBigIntMinorUnits(input.deductionsMinor, "deductionsMinor") : 0n;
    const netDistributableMinor = grossAmountMinor - deductionsMinor;
    if (netDistributableMinor < 0n) {
      throw ProblemError.badRequest("deductionsMinor must not exceed grossAmountMinor.");
    }

    const allComponents = await commissionComponentRepository.listBySchedule(prisma, schedule.id);
    const componentInputs: EconomicsComponentInput[] = allComponents.map((c) => ({
      componentId: c.id,
      recipientOrgId: c.recipientOrgId,
      componentType: c.componentType,
      bps: c.bps,
      fixedAmountMinor: c.fixedAmountMinor,
      claimId: c.claimId,
      priority: c.priority,
    }));
    const basisOverrideMap = new Map(allComponents.map((c) => [c.id, c.calculationBasis as DomainCommissionBasis | null]));
    const targetedComponents = selectComponentsForBasis(componentInputs, schedule.basis, input.basis, basisOverrideMap);
    if (targetedComponents.length === 0) {
      throw ProblemError.badRequest(`Schedule ${schedule.id} has zero components covering basis "${input.basis}".`);
    }

    const recognizedAt = input.recognizedAt ? new Date(input.recognizedAt) : new Date();
    // @tol/domain's computeCommissionSplits throws EconomicsInvariantError
    // for a mis-configured schedule (e.g. bps not summing to exactly
    // 10000) — a CLIENT-actionable problem (the operator must fix the
    // schedule), never a server bug, so it is converted to a clean 400
    // here rather than allowed to fall through to app.ts's generic
    // unhandled-error 500 path (that path is reserved for genuine server
    // faults — EconomicsInvariantError is neither a ProblemError nor a
    // DomainTransitionError, the two types app.ts's error handler already
    // special-cases, so without this catch it would surface as a 500).
    let split: ReturnType<typeof computeCommissionSplits>;
    try {
      split = computeCommissionSplits({
        netDistributableMinor,
        components: targetedComponents,
        scheduleId: schedule.id,
        scheduleVersion: schedule.versionNumber,
        now: recognizedAt,
      });
    } catch (err) {
      if (err instanceof EconomicsInvariantError) {
        throw ProblemError.badRequest(`Cannot compute the commission split: ${err.message}`);
      }
      throw err;
    }

    const result = await withTransaction(async (tx) => {
      const revenueEvent = await revenueEventRepository.create(tx, {
        dealRoomId,
        scheduleId: schedule.id,
        basis: input.basis,
        period: input.period,
        source: input.source,
        grossAmountMinor,
        deductionsMinor,
        netDistributableMinor,
        currency: input.currency,
        recognizedAt,
        privacyClass: "RESTRICTED",
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      const ledgerEntries = await commissionAccrualRepository.createMany(
        tx,
        split.entries.map((e) => ({
          entryType: "ACCRUAL" as const,
          direction: e.direction,
          amountMinor: e.amountMinor,
          currency: input.currency,
          dealRoomId,
          revenueEventId: revenueEvent.id,
          scheduleId: schedule.id,
          scheduleVersion: schedule.versionNumber,
          componentId: e.componentId,
          recipientOrgId: e.recipientOrgId,
          claimId: e.claimId,
          calculationVersion: split.calculationVersion,
          inputVersions: split.inputVersions,
          computedAt: recognizedAt,
          privacyClass: "RESTRICTED",
          createdByUserId: actor.userId,
          createdByOrgId: actor.organizationId,
        })),
      );

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: dealRoom.merchantOrgId,
        action: "commission.accrued",
        resourceType: "revenue_event",
        resourceId: revenueEvent.id,
        afterValue: { dealRoomId, period: input.period, source: input.source, netDistributableMinor: netDistributableMinor.toString(), entryCount: ledgerEntries.length, calculationVersion: split.calculationVersion },
      });
      // the spec's own verbatim domain event name.
      await timelineWriter(context).write(tx, {
        eventType: "commission.accrued",
        aggregateType: "deal_room",
        aggregateId: dealRoomId,
        payload: { revenueEventId: revenueEvent.id, scheduleId: schedule.id, netDistributableMinor: netDistributableMinor.toString(), entryCount: ledgerEntries.length },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return { revenueEvent, ledgerEntries };
    });

    // earlier-stage work: event-triggered enqueue ("deal activation ->
    // accrual"). apps/worker's economics-accrual.job.ts's own header
    // documents this precisely: there is no "activation" event with money
    // attached before a RevenueEvent exists, so THIS is the actual
    // "economics engaging" moment the spec describes, and the point this
    // day's own instruction means by "deal activation -> accrual." Enqueued
    // RIGHT ALONGSIDE (never instead of) the synchronous split/ledger-write
    // already committed just above — a durable, retriable, idempotent
    // reconciliation pass over this exact revenueEventId, safe to enqueue
    // redundantly (its own listByRevenueEvent check no-ops when already
    // accrued). safeEnqueue-backed, called after commit — see
    // passport/service.ts's create() for the full reasoning this mirrors.
    await enqueueEconomicsAccrual(result.revenueEvent.id);

    const reconciliation = reconcileRevenueEvent({
      grossAmountMinor: result.revenueEvent.grossAmountMinor,
      deductionsMinor: result.revenueEvent.deductionsMinor,
      netDistributableMinor: result.revenueEvent.netDistributableMinor,
      ledgerEntries: result.ledgerEntries.map((e) => ({ entryType: e.entryType, direction: e.direction, amountMinor: e.amountMinor })),
    });

    return { ...result, reconciliation };
  },

  async listRevenueEvents(actor: Actor, dealRoomId: string): Promise<RevenueEvent[]> {
    const dealRoom = await loadDealRoom(dealRoomId);
    const decision = can(actor, "economics.list", { type: "revenue_event", ownerOrgId: dealRoom.merchantOrgId });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);
    return revenueEventRepository.listByDealRoom(prisma, dealRoomId);
  },

  // ================================================================
  // Ledger — the traceable, append-only accrual ledger itself
  // ================================================================

  /**
   * ownerOrgId is ALWAYS null for this check (packages/authz's own
   * design, actions.ts's Resource.ownerOrgId comment + can.ts's
   * structural hardening) — cross-org oversight roles pass unconditionally;
   * party roles must be a verified recipient on AT LEAST ONE accrual for
   * this deal, checked against the REAL rows below, never inferred from
   * deal participation.
   */
  async getLedger(actor: Actor, dealRoomId: string): Promise<AccrualWithBalance[]> {
    await loadDealRoom(dealRoomId);

    const isCrossOrg = actor.role !== null && CROSS_ORG_ECONOMICS_ROLES.has(actor.role);
    const allRows = await commissionAccrualRepository.listByDealRoom(prisma, dealRoomId);

    const isRecipient = actor.organizationId !== null && allRows.some((r) => r.recipientOrgId === actor.organizationId);
    const isParticipant = !isCrossOrg && actor.role !== null && LEDGER_PARTY_ROLES.has(actor.role) && isRecipient;

    const decision = can(actor, "ledger.list", { type: "commission_accrual", ownerOrgId: null }, { isParticipant });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    const visibleRows = isCrossOrg ? allRows : allRows.filter((r) => r.recipientOrgId === actor.organizationId);
    return groupIntoAccruals(visibleRows);
  },

  // ================================================================
  // Payments
  // ================================================================

  async recordPayment(actor: Actor, dealRoomId: string, input: RecordPaymentRequest, context: RequestContext): Promise<{ payment: CommissionPayment; ledgerEntries: CommissionAccrual[] }> {
    const dealRoom = await loadDealRoom(dealRoomId);

    const decision = can(actor, "ledger.record_payment", { type: "commission_accrual", ownerOrgId: null });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    // Fast, cheap pre-transaction rejection for the common case (same
    // discipline as rfqs/service.ts's selectQuote) — loads every named
    // accrual's full chain, validates it belongs to this deal, and
    // validates the requested amount doesn't exceed its real,
    // engine-computed outstanding balance. A REVERSED accrual is
    // rejected explicitly (real fix, review) — voided is voided, no further payment
    // against it. The AUTHORITATIVE check is the re-read-inside-the-lock
    // below — concurrent payments (or an adjustLedger()) against the
    // SAME accrual could change its outstanding balance between this
    // read and the transaction actually starting.
    const loaded = await loadAndValidatePayments(prisma, dealRoomId, input.payments);
    validateSingleRecipientAndCurrency(loaded);
    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();

    // Follow-up fix: CommissionPayment.reference is now @unique
    // at the DB level — wrapped in runUniqueConstraintSafe (this file's
    // own copy, see that function's doc comment) so a reused reference
    // (retried request, or two callers coincidentally choosing the same
    // one) surfaces as a clean 409, not a raw Prisma P2002 500. Written
    // as a single-line `runUniqueConstraintSafe(() => withTransaction(`
    // wrap (matching memberships/service.ts's and rfqs/service.ts's own
    // precedent exactly) specifically so the ADVISORY LOCK/transaction
    // body below keeps its EXACT existing indentation and content,
    // untouched — this pass does not modify that committed A2 lock.
    const result = await runUniqueConstraintSafe(() => withTransaction(async (tx) => {
      // ADVISORY LOCK — closes a genuine overpay race (concurrency-audit
      // clean-window pass, a later; also independently flagged by
      // an earlier review against this exact function,
      // review): under
      // Postgres's default READ COMMITTED isolation, two truly
      // concurrent recordPayment() calls against the SAME accrual could
      // each independently read the SAME pre-commit outstanding balance
      // (neither sees the other's still-uncommitted PAYMENT rows) and
      // both proceed — unlike claims'/lockbox's races, there is no
      // accidental row-lock protection here either, since each call
      // INSERTs its own new CommissionPayment + CommissionAccrual rows
      // rather than UPDATing a shared existing row, so nothing serializes
      // them without an explicit lock.
      //
      // Locked on dealRoomId, NOT a single accrualRootId: a single
      // recordPayment() call can name MULTIPLE accrualRootIds in one
      // batch (no single accrualRootId would cover them all), and this
      // lock must ALSO serialize against a concurrent adjustLedger()
      // call touching a DIFFERENT accrual root under the SAME deal room
      // (adjustLedger takes the identical dealRoomId lock below) —
      // dealRoomId is the coarsest common ancestor both functions share,
      // and the true serialization unit for this deal room's ledger.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dealRoomId}))`;

      // Re-validate every payment fresh, INSIDE the lock — the
      // established check-then-act race guard, using the exact same
      // loader as the pre-check above, now against `tx`.
      const freshLoaded = await loadAndValidatePayments(tx, dealRoomId, input.payments);
      const { recipientOrgId, currency } = validateSingleRecipientAndCurrency(freshLoaded);
      const totalAmountMinor = freshLoaded.reduce((sum, l) => sum + l.amountMinor, 0n);

      const payment = await commissionPaymentRepository.create(tx, {
        dealRoomId,
        recipientOrgId,
        totalAmountMinor,
        currency,
        paidAt,
        reference: input.reference,
        evidenceRef: input.evidenceRef ?? null,
        privacyClass: "RESTRICTED",
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      const ledgerEntries = await commissionAccrualRepository.createMany(
        tx,
        freshLoaded.map((l) => ({
          accrualRootId: l.accrualRootId,
          entryType: "PAYMENT" as const,
          direction: "DEBIT" as const,
          amountMinor: l.amountMinor,
          currency,
          dealRoomId,
          revenueEventId: l.root.revenueEventId,
          scheduleId: l.root.scheduleId,
          scheduleVersion: l.root.scheduleVersion,
          componentId: l.root.componentId,
          recipientOrgId: l.root.recipientOrgId,
          claimId: l.root.claimId,
          paymentId: payment.id,
          calculationVersion: ECONOMICS_ENGINE_VERSION,
          inputVersions: [`payment:${payment.id}`],
          computedAt: paidAt,
          privacyClass: "RESTRICTED",
          createdByUserId: actor.userId,
          createdByOrgId: actor.organizationId,
        })),
      );

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: dealRoom.merchantOrgId,
        action: "commission.paid",
        resourceType: "commission_accrual",
        resourceId: payment.id,
        afterValue: { dealRoomId, recipientOrgId, totalAmountMinor: totalAmountMinor.toString(), accrualCount: freshLoaded.length, reference: input.reference },
      });
      // the spec's own verbatim domain event name.
      await timelineWriter(context).write(tx, {
        eventType: "commission.paid",
        aggregateType: "deal_room",
        aggregateId: dealRoomId,
        payload: { paymentId: payment.id, recipientOrgId, totalAmountMinor: totalAmountMinor.toString(), accrualRootIds: freshLoaded.map((l) => l.accrualRootId) },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return { payment, ledgerEntries };
    }), `A payment with reference "${input.reference}" already exists.`);

    return result;
  },

  // ================================================================
  // Adjustments
  // ================================================================

  async adjustLedger(actor: Actor, dealRoomId: string, accrualRootId: string, input: AdjustLedgerRequest, context: RequestContext): Promise<{ ledgerEntry: CommissionAccrual; balance: AccrualBalance }> {
    const dealRoom = await loadDealRoom(dealRoomId);

    const decision = can(actor, "ledger.adjust", { type: "commission_accrual", ownerOrgId: null });
    if (!decision.allowed) throw ProblemError.forbidden(decision.reason);

    // Fast, cheap pre-transaction rejection for the common case — the
    // AUTHORITATIVE check is the re-read-inside-the-lock below.
    const chain = await commissionAccrualRepository.listByAccrualRoot(prisma, accrualRootId);
    if (chain.length === 0 || chain[0]!.dealRoomId !== dealRoomId) {
      throw ProblemError.notFound("Accrual not found on this deal room.");
    }
    // Real fix (review): a REVERSED
    // accrual accepts no further adjustment — same "voided is voided"
    // guard as recordPayment above.
    const currentBalance = computeAccrualBalance(chain.map((e) => ({ entryType: e.entryType, direction: e.direction, amountMinor: e.amountMinor })));
    if (currentBalance.status === "REVERSED") {
      throw ProblemError.badRequest(`Accrual ${accrualRootId} has been REVERSED — no further adjustment may be recorded against it.`);
    }
    const amountMinor = parseBigIntMinorUnits(input.amountMinor, "amountMinor");
    if (amountMinor <= 0n) throw ProblemError.badRequest("Adjustment amountMinor must be positive.");

    const result = await withTransaction(async (tx) => {
      // ADVISORY LOCK — same key/reasoning as recordPayment()'s own lock
      // above (an earlier review flagged this exact gap,
      // review: "If
      // adjustLedger is called concurrently on the same accrualRootId,
      // the lack of an advisory lock allows double-spending adjustments
      // beyond the actual balance" — deliberately deferred at the time
      // to this clean-window pass, not silently dropped). Locked on
      // dealRoomId, NOT accrualRootId alone, so this ALSO serializes
      // against a concurrent recordPayment() call touching a DIFFERENT
      // accrual root under the SAME deal room — dealRoomId is the true
      // shared serialization unit for this deal room's ledger (see
      // recordPayment()'s own comment for the full justification).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dealRoomId}))`;

      // Re-read fresh INSIDE the transaction (and now inside the lock) —
      // the established check-then-act race guard: a concurrent
      // payment/adjustment/reversal could have changed this accrual's
      // chain (and therefore its REVERSED status) between the
      // pre-checks above and this transaction actually starting.
      const freshChain = await commissionAccrualRepository.listByAccrualRoot(tx, accrualRootId);
      if (freshChain.length === 0 || freshChain[0]!.dealRoomId !== dealRoomId) {
        throw ProblemError.notFound("Accrual not found on this deal room.");
      }
      const freshRoot = freshChain[0]!;
      const freshBalance = computeAccrualBalance(freshChain.map((e) => ({ entryType: e.entryType, direction: e.direction, amountMinor: e.amountMinor })));
      if (freshBalance.status === "REVERSED") {
        throw ProblemError.badRequest(`Accrual ${accrualRootId} has been REVERSED — no further adjustment may be recorded against it.`);
      }

      const ledgerEntry = await commissionAccrualRepository.create(tx, {
        accrualRootId,
        entryType: "ADJUSTMENT",
        direction: input.direction,
        amountMinor,
        currency: freshRoot.currency,
        dealRoomId,
        revenueEventId: freshRoot.revenueEventId,
        scheduleId: freshRoot.scheduleId,
        scheduleVersion: freshRoot.scheduleVersion,
        componentId: freshRoot.componentId,
        recipientOrgId: freshRoot.recipientOrgId,
        claimId: freshRoot.claimId,
        reason: input.reason,
        approverUserId: actor.userId,
        approverOrgId: actor.organizationId,
        calculationVersion: ECONOMICS_ENGINE_VERSION,
        inputVersions: [`adjustment:${accrualRootId}:${new Date().toISOString()}`],
        computedAt: new Date(),
        privacyClass: "RESTRICTED",
        createdByUserId: actor.userId,
        createdByOrgId: actor.organizationId,
      });

      await auditWriter(context).write(tx, {
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
        subjectOrgId: dealRoom.merchantOrgId,
        action: "commission.adjusted",
        resourceType: "commission_accrual",
        resourceId: ledgerEntry.id,
        afterValue: { accrualRootId, direction: input.direction, amountMinor: amountMinor.toString(), reason: input.reason },
      });
      await timelineWriter(context).write(tx, {
        eventType: "commission.adjusted",
        aggregateType: "deal_room",
        aggregateId: dealRoomId,
        payload: { accrualRootId, direction: input.direction, amountMinor: amountMinor.toString() },
        actorUserId: actor.userId,
        actorOrgId: actor.organizationId,
        actorRole: actor.role,
      });

      return { ledgerEntry, chain: freshChain };
    });

    const updatedChain = [...result.chain, result.ledgerEntry];
    const balance = computeAccrualBalance(updatedChain.map((e) => ({ entryType: e.entryType, direction: e.direction, amountMinor: e.amountMinor })));

    return { ledgerEntry: result.ledgerEntry, balance };
  },
};
