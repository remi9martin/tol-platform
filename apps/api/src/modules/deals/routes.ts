import type { FastifyPluginAsync } from "fastify";
import {
  PostConditionRequestSchema,
  RecordDecisionRequestSchema,
  ResolveConditionRequestSchema,
  type ListDealRoomsResponse,
  type TimelineResponse,
} from "@tol/contracts";
import { dealsService } from "./service.js";
import { toDealConditionDTO, toDealDecisionDTO, toDealRoomDTO, toTimelineEventDTO } from "./mapper.js";
import { ProblemError, zodFieldErrors } from "../../shared/errors.js";

const dealRoutes: FastifyPluginAsync = async (app) => {
  app.get("/deals", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const deals = await dealsService.list(request.actor!);
    const body: ListDealRoomsResponse = { deals: deals.map((d) => toDealRoomDTO(d, {})) };
    return reply.code(200).send(body);
  });

  app.get<{ Params: { id: string } }>("/deals/:id", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const detail = await dealsService.getById(request.actor!, request.params.id);
    return reply.code(200).send(
      toDealRoomDTO(detail.dealRoom, {
        participants: detail.participants,
        conditions: detail.conditions,
        decisions: detail.decisions,
      }),
    );
  });

  app.get<{ Params: { id: string } }>(
    "/deals/:id/timeline",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const events = await dealsService.getTimeline(request.actor!, request.params.id);
      const body: TimelineResponse = { events: events.map(toTimelineEventDTO) };
      return reply.code(200).send(body);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/deals/:id/conditions",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = PostConditionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid condition request.", zodFieldErrors(parsed.error.issues));
      }
      const created = await dealsService.postCondition(request.actor!, request.params.id, parsed.data, request.context);
      return reply.code(201).send(toDealConditionDTO(created));
    },
  );

  app.patch<{ Params: { id: string; conditionId: string } }>(
    "/deals/:id/conditions/:conditionId",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = ResolveConditionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid condition resolution request.", zodFieldErrors(parsed.error.issues));
      }
      const updated = await dealsService.resolveCondition(
        request.actor!,
        request.params.id,
        request.params.conditionId,
        parsed.data,
        request.context,
      );
      return reply.code(200).send(toDealConditionDTO(updated));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/deals/:id/decisions",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = RecordDecisionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid decision request.", zodFieldErrors(parsed.error.issues));
      }
      const created = await dealsService.recordDecision(request.actor!, request.params.id, parsed.data, request.context);
      return reply.code(201).send(toDealDecisionDTO(created));
    },
  );
};

export default dealRoutes;
