// apps/api/src/modules/economics/routes.ts
//
// the spec/P15. Nested under a deal room (the spec's own
// `/app/economics` surface reads a deal's schedules/ledger — every
// endpoint here is scoped to exactly one DealRoom, same "sub-resource
// through its parent" convention as RFQ/DealRoom's own children).
// EVERY mutating endpoint (schedules/revenue-events/payments/adjust) is
// wrapped in withIdempotency — a retried network call recording revenue
// or a payment TWICE would be a real, silent double-counted-money bug,
// the highest-severity risk category this day's own build instructions
// name. Reads are plain GETs, no idempotency layer needed.

import type { FastifyPluginAsync } from "fastify";
import {
  AdjustLedgerRequestSchema,
  CreateScheduleRequestSchema,
  RecordPaymentRequestSchema,
  RecordRevenueEventRequestSchema,
  type AdjustLedgerResponse,
  type LedgerResponse,
  type ListRevenueEventsResponse,
  type ListSchedulesResponse,
  type RecordPaymentResponse,
  type RecordRevenueEventResponse,
} from "@tol/contracts";
import { prisma } from "@tol/db";
import { economicsService } from "./service.js";
import { toAccrualBalanceDTO, toAccrualDTO, toCommissionAccrualDTO, toCommissionPaymentDTO, toCommissionScheduleDetailDTO, toReconciliationDTO, toRevenueEventDTO } from "./mapper.js";
import { ProblemError, zodFieldErrors } from "../../shared/errors.js";
import { withIdempotency } from "../../shared/idempotency.js";

const economicsRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { dealRoomId: string } }>(
    "/deals/:dealRoomId/economics/schedules",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = CreateScheduleRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid schedule request.", zodFieldErrors(parsed.error.issues));
      }
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const body = await withIdempotency(
        prisma,
        {
          key: idempotencyKey,
          scope: "economics.schedule_create",
          method: request.method,
          path: request.url,
          body: request.body,
          organizationId: request.actor!.organizationId,
          userId: request.actor!.userId,
        },
        async () => toCommissionScheduleDetailDTO(await economicsService.createSchedule(request.actor!, request.params.dealRoomId, parsed.data, request.context)),
      );
      return reply.code(201).send(body);
    },
  );

  app.get<{ Params: { dealRoomId: string } }>(
    "/deals/:dealRoomId/economics/schedules",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const details = await economicsService.listSchedules(request.actor!, request.params.dealRoomId);
      const body: ListSchedulesResponse = { schedules: details.map(toCommissionScheduleDetailDTO) };
      return reply.code(200).send(body);
    },
  );

  app.post<{ Params: { dealRoomId: string } }>(
    "/deals/:dealRoomId/economics/revenue-events",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = RecordRevenueEventRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid revenue event request.", zodFieldErrors(parsed.error.issues));
      }
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const body = await withIdempotency(
        prisma,
        {
          key: idempotencyKey,
          scope: "economics.revenue_event_record",
          method: request.method,
          path: request.url,
          body: request.body,
          organizationId: request.actor!.organizationId,
          userId: request.actor!.userId,
        },
        async (): Promise<RecordRevenueEventResponse> => {
          const result = await economicsService.recordRevenueEvent(request.actor!, request.params.dealRoomId, parsed.data, request.context);
          return {
            revenueEvent: toRevenueEventDTO(result.revenueEvent),
            ledgerEntries: result.ledgerEntries.map(toCommissionAccrualDTO),
            reconciliation: toReconciliationDTO(result.reconciliation),
          };
        },
      );
      return reply.code(201).send(body);
    },
  );

  app.get<{ Params: { dealRoomId: string } }>(
    "/deals/:dealRoomId/economics/revenue-events",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const revenueEvents = await economicsService.listRevenueEvents(request.actor!, request.params.dealRoomId);
      const body: ListRevenueEventsResponse = { revenueEvents: revenueEvents.map(toRevenueEventDTO) };
      return reply.code(200).send(body);
    },
  );

  app.get<{ Params: { dealRoomId: string } }>(
    "/deals/:dealRoomId/economics/ledger",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const accruals = await economicsService.getLedger(request.actor!, request.params.dealRoomId);
      const body: LedgerResponse = { accruals: accruals.map(toAccrualDTO) };
      return reply.code(200).send(body);
    },
  );

  app.post<{ Params: { dealRoomId: string } }>(
    "/deals/:dealRoomId/economics/payments",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = RecordPaymentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid payment request.", zodFieldErrors(parsed.error.issues));
      }
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const body = await withIdempotency(
        prisma,
        {
          key: idempotencyKey,
          scope: "economics.payment_record",
          method: request.method,
          path: request.url,
          body: request.body,
          organizationId: request.actor!.organizationId,
          userId: request.actor!.userId,
        },
        async (): Promise<RecordPaymentResponse> => {
          const result = await economicsService.recordPayment(request.actor!, request.params.dealRoomId, parsed.data, request.context);
          return { payment: toCommissionPaymentDTO(result.payment), ledgerEntries: result.ledgerEntries.map(toCommissionAccrualDTO) };
        },
      );
      return reply.code(201).send(body);
    },
  );

  app.post<{ Params: { dealRoomId: string; accrualRootId: string } }>(
    "/deals/:dealRoomId/economics/ledger/:accrualRootId/adjust",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = AdjustLedgerRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid adjustment request.", zodFieldErrors(parsed.error.issues));
      }
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const body = await withIdempotency(
        prisma,
        {
          key: idempotencyKey,
          scope: "economics.ledger_adjust",
          method: request.method,
          path: request.url,
          body: request.body,
          organizationId: request.actor!.organizationId,
          userId: request.actor!.userId,
        },
        async (): Promise<AdjustLedgerResponse> => {
          const result = await economicsService.adjustLedger(request.actor!, request.params.dealRoomId, request.params.accrualRootId, parsed.data, request.context);
          return { ledgerEntry: toCommissionAccrualDTO(result.ledgerEntry), balance: toAccrualBalanceDTO(result.balance) };
        },
      );
      return reply.code(201).send(body);
    },
  );
};

export default economicsRoutes;
