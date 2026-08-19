// apps/api/src/modules/passport/routes.ts
//
// the spec (P6 gate). 6 actions -> 6 routes, matching earlier phases's
// route-naming convention (no /v1 prefix). create/fact-upsert/evidence-
// add go through withIdempotency (a retried POST really would create a
// second Passport / double-apply a Fact write / add a second Evidence
// row under a second id); verify does NOT (same reasoning as Lockbox's
// release / Claim's decide — @tol/domain's state machine already makes
// a retried verify a clean 409, no separate idempotency layer needed).

import type { FastifyPluginAsync } from "fastify";
import {
  CreateEvidenceRequestSchema,
  CreatePassportRequestSchema,
  UpsertFactRequestSchema,
  VerifyPassportRequestSchema,
  type EvidenceDTO,
  type FactDTO,
  type ListPassportsResponse,
  type PassportDetailResponse,
  type PassportDTO,
} from "@tol/contracts";
import { prisma } from "@tol/db";
import { passportService } from "./service.js";
import { toEvidenceDTO, toFactDTO, toPassportDetailResponse, toPassportDTO } from "./mapper.js";
import { ProblemError, zodFieldErrors } from "../../shared/errors.js";
import { withIdempotency } from "../../shared/idempotency.js";

const passportRoutes: FastifyPluginAsync = async (app) => {
  app.get("/passports", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const passports = await passportService.list(request.actor!);
    const body: ListPassportsResponse = { passports: passports.map(toPassportDTO) };
    return reply.code(200).send(body);
  });

  app.get<{ Params: { id: string } }>("/passports/:id", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const detail = await passportService.getById(request.actor!, request.params.id);
    const body: PassportDetailResponse = toPassportDetailResponse(detail.passport, detail.facts, detail.evidence, detail.readiness);
    return reply.code(200).send(body);
  });

  // Primary UI lookup — the spec's route `/app/passport/[orgId]` is
  // keyed by ORGANIZATION id, not Passport id (see schema.prisma's
  // Passport model comment on the 1:1 cardinality this reflects).
  app.get<{ Params: { orgId: string } }>(
    "/passports/by-org/:orgId",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const detail = await passportService.getByOrganizationId(request.actor!, request.params.orgId);
      const body: PassportDetailResponse = toPassportDetailResponse(detail.passport, detail.facts, detail.evidence, detail.readiness);
      return reply.code(200).send(body);
    },
  );

  app.post("/passports", { preHandler: [app.requireAuth, app.requireCsrf] }, async (request, reply) => {
    const parsed = CreatePassportRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw ProblemError.badRequest("Invalid passport creation request.", zodFieldErrors(parsed.error.issues));
    }

    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    const dto = await withIdempotency(
      prisma,
      {
        key: idempotencyKey,
        scope: "passport.create",
        method: request.method,
        path: request.url,
        body: request.body,
        organizationId: request.actor!.organizationId,
        userId: request.actor!.userId,
      },
      async (): Promise<PassportDTO> => {
        const created = await passportService.create(request.actor!, request.context);
        return toPassportDTO(created);
      },
    );

    return reply.code(201).send(dto);
  });

  app.post<{ Params: { id: string } }>(
    "/passports/:id/facts",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = UpsertFactRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid fact submission.", zodFieldErrors(parsed.error.issues));
      }

      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const dto = await withIdempotency(
        prisma,
        {
          key: idempotencyKey,
          scope: "passport.upsert_fact",
          method: request.method,
          path: request.url,
          body: request.body,
          organizationId: request.actor!.organizationId,
          userId: request.actor!.userId,
        },
        async (): Promise<FactDTO> => {
          const { fact } = await passportService.upsertFact(request.actor!, request.params.id, parsed.data, request.context);
          return toFactDTO(fact);
        },
      );

      return reply.code(200).send(dto);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/passports/:id/evidence",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = CreateEvidenceRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid evidence submission.", zodFieldErrors(parsed.error.issues));
      }

      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const dto = await withIdempotency(
        prisma,
        {
          key: idempotencyKey,
          scope: "passport.add_evidence",
          method: request.method,
          path: request.url,
          body: request.body,
          organizationId: request.actor!.organizationId,
          userId: request.actor!.userId,
        },
        async (): Promise<EvidenceDTO> => {
          const evidence = await passportService.addEvidence(request.actor!, request.params.id, parsed.data, request.context);
          return toEvidenceDTO(evidence);
        },
      );

      return reply.code(201).send(dto);
    },
  );

  // DELIBERATELY NOT wrapped in withIdempotency — same reasoning as
  // Lockbox's release / Claim's decide (earlier phases): @tol/domain's
  // assertValidPassportTransition already makes a retried verify() on an
  // already-verified (or no-longer-READY) passport a clean 409.
  app.post<{ Params: { id: string } }>(
    "/passports/:id/verify",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = VerifyPassportRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid verify request.", zodFieldErrors(parsed.error.issues));
      }

      const updated = await passportService.verify(request.actor!, request.params.id, parsed.data, request.context);
      return reply.code(200).send(toPassportDTO(updated));
    },
  );
};

export default passportRoutes;
