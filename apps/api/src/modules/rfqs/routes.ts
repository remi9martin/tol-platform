import type { FastifyPluginAsync } from "fastify";
import {
  CreateRfqRequestSchema,
  DeclineRfqRequestSchema,
  SelectQuoteRequestSchema,
  SubmitQuoteRequestSchema,
  type ListRfqsResponse,
} from "@tol/contracts";
import { prisma } from "@tol/db";
import { rfqsService } from "./service.js";
import { filterQuotesForViewer, toQuoteDTO, toRfqDTO, toRfqRecipientDTO } from "./mapper.js";
import { toDealRoomDTO } from "../deals/mapper.js";
import { ProblemError, zodFieldErrors } from "../../shared/errors.js";
import { withIdempotency } from "../../shared/idempotency.js";

const rfqRoutes: FastifyPluginAsync = async (app) => {
  app.get("/rfqs", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const rfqs = await rfqsService.list(request.actor!);
    const body: ListRfqsResponse = { rfqs: rfqs.map((rfq) => toRfqDTO(rfq, {})) };
    return reply.code(200).send(body);
  });

  app.get<{ Params: { id: string } }>("/rfqs/:id", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const detail = await rfqsService.getById(request.actor!, request.params.id);
    const visibleQuotes = filterQuotesForViewer(request.actor!, detail.merchantOrgId, detail.quotes);
    return reply.code(200).send(
      toRfqDTO(detail.rfq, {
        version: detail.version ?? undefined,
        recipients: detail.recipients,
        quotes: visibleQuotes,
      }),
    );
  });

  // the spec: Idempotency-Key — a retried create must not send two
  // RFQs (and double-notify providers) for the same logical request.
  app.post("/rfqs", { preHandler: [app.requireAuth, app.requireCsrf] }, async (request, reply) => {
    const parsed = CreateRfqRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ProblemError.badRequest("Invalid RFQ creation request.", zodFieldErrors(parsed.error.issues));
    }

    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    const dto = await withIdempotency(
      prisma,
      {
        key: idempotencyKey,
        scope: "rfq.create",
        method: request.method,
        path: request.url,
        body: request.body,
        organizationId: request.actor!.organizationId,
        userId: request.actor!.userId,
      },
      async () => {
        const detail = await rfqsService.create(request.actor!, parsed.data, request.context);
        return toRfqDTO(detail.rfq, { version: detail.version ?? undefined, recipients: detail.recipients, quotes: [] });
      },
    );

    return reply.code(201).send(dto);
  });

  app.post<{ Params: { id: string } }>(
    "/rfqs/:id/decline",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = DeclineRfqRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid decline request.", zodFieldErrors(parsed.error.issues));
      }
      const updated = await rfqsService.decline(request.actor!, request.params.id, parsed.data, request.context);
      return reply.code(200).send(toRfqRecipientDTO(updated));
    },
  );

  // Idempotency-Key: a retried submit must not create two quote versions.
  app.post<{ Params: { id: string } }>(
    "/rfqs/:id/quotes",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = SubmitQuoteRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid quote submission request.", zodFieldErrors(parsed.error.issues));
      }

      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const dto = await withIdempotency(
        prisma,
        {
          key: idempotencyKey,
          scope: "rfq.submit_quote",
          method: request.method,
          path: request.url,
          body: request.body,
          organizationId: request.actor!.organizationId,
          userId: request.actor!.userId,
        },
        async () => {
          const quote = await rfqsService.submitQuote(request.actor!, request.params.id, parsed.data, request.context);
          return toQuoteDTO(quote);
        },
      );

      return reply.code(201).send(dto);
    },
  );

  app.post<{ Params: { id: string; quoteId: string } }>(
    "/rfqs/:id/quotes/:quoteId/withdraw",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const updated = await rfqsService.withdrawQuote(
        request.actor!,
        request.params.id,
        request.params.quoteId,
        request.context,
      );
      return reply.code(200).send(toQuoteDTO(updated));
    },
  );

  // Idempotency-Key: a retried select must not open two deal rooms.
  app.post<{ Params: { id: string } }>(
    "/rfqs/:id/select",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = SelectQuoteRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid quote selection request.", zodFieldErrors(parsed.error.issues));
      }

      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const dto = await withIdempotency(
        prisma,
        {
          key: idempotencyKey,
          scope: "rfq.select_quote",
          method: request.method,
          path: request.url,
          body: request.body,
          organizationId: request.actor!.organizationId,
          userId: request.actor!.userId,
        },
        async () => {
          const dealRoom = await rfqsService.selectQuote(request.actor!, request.params.id, parsed.data, request.context);
          return toDealRoomDTO(dealRoom, {});
        },
      );

      return reply.code(201).send(dto);
    },
  );
};

export default rfqRoutes;
