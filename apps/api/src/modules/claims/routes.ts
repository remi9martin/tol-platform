// apps/api/src/modules/claims/routes.ts
//
// the spec/p.18 (P10 gate). 5 actions -> 5 routes, matching earlier phases's
// route-naming convention (no /v1 prefix). create/fileDispute go through
// withIdempotency (genuine duplicate-network-retry risk — a retried POST
// really would file a second claim/dispute under a second id);
// decide does NOT (same reasoning as Lockbox's release — @tol/domain's
// state machine already makes a retried decide a clean 409, no separate
// idempotency layer needed).

import type { FastifyPluginAsync } from "fastify";
import {
  CreateClaimRequestSchema,
  DecideClaimRequestSchema,
  FileClaimDisputeRequestSchema,
  type ClaimDetailResponse,
  type ClaimDecisionDTO,
  type ClaimDisputeDTO,
  type ListClaimsResponse,
} from "@tol/contracts";
import { prisma } from "@tol/db";
import { claimsService } from "./service.js";
import { toClaimDTO, toClaimDecisionDTO, toClaimDisputeDTO, toClaimEvidenceDTO, toClaimRankEntryDTO } from "./mapper.js";
import { ProblemError, zodFieldErrors } from "../../shared/errors.js";
import { withIdempotency } from "../../shared/idempotency.js";

const claimRoutes: FastifyPluginAsync = async (app) => {
  app.get("/claims", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const claims = await claimsService.list(request.actor!);
    const body: ListClaimsResponse = { claims: claims.map(toClaimDTO) };
    return reply.code(200).send(body);
  });

  app.get<{ Params: { id: string } }>("/claims/:id", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const detail = await claimsService.getById(request.actor!, request.params.id);
    const body: ClaimDetailResponse = {
      claim: toClaimDTO(detail.claim),
      evidence: detail.evidence.map(toClaimEvidenceDTO),
      decisions: detail.decisions.map(toClaimDecisionDTO),
      disputes: detail.disputes.map(toClaimDisputeDTO),
      rank: detail.rank ? toClaimRankEntryDTO(detail.rank) : null,
    };
    return reply.code(200).send(body);
  });

  // the spec: Idempotency-Key — a retried file-claim must not score and
  // persist the same claim twice under two different ids.
  app.post("/claims", { preHandler: [app.requireAuth, app.requireCsrf] }, async (request, reply) => {
    const parsed = CreateClaimRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ProblemError.badRequest("Invalid claim filing request.", zodFieldErrors(parsed.error.issues));
    }

    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    const dto = await withIdempotency(
      prisma,
      {
        key: idempotencyKey,
        scope: "claim.create",
        method: request.method,
        path: request.url,
        body: request.body,
        organizationId: request.actor!.organizationId,
        userId: request.actor!.userId,
      },
      async () => {
        const claim = await claimsService.create(request.actor!, parsed.data, request.context);
        return toClaimDTO(claim);
      },
    );

    return reply.code(201).send(dto);
  });

  app.post<{ Params: { id: string } }>(
    "/claims/:id/disputes",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = FileClaimDisputeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid dispute request.", zodFieldErrors(parsed.error.issues));
      }

      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const dto = await withIdempotency(
        prisma,
        {
          key: idempotencyKey,
          scope: "claim.dispute",
          method: request.method,
          path: request.url,
          body: request.body,
          organizationId: request.actor!.organizationId,
          userId: request.actor!.userId,
        },
        async (): Promise<ClaimDisputeDTO> => {
          const dispute = await claimsService.fileDispute(request.actor!, request.params.id, parsed.data, request.context);
          return toClaimDisputeDTO(dispute);
        },
      );

      return reply.code(201).send(dto);
    },
  );

  // DELIBERATELY NOT wrapped in withIdempotency — same reasoning as
  // Lockbox's release route (earlier): @tol/domain's assertValidClaimTransition
  // already makes a retried decide() on an already-decided claim a clean
  // 400/409, so a second idempotency layer would add persistence-write
  // surface (idempotency_keys.response_body) without closing a real gap.
  app.post<{ Params: { id: string } }>(
    "/claims/:id/decisions",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = DecideClaimRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid decision request.", zodFieldErrors(parsed.error.issues));
      }

      const decision = await claimsService.decide(request.actor!, request.params.id, parsed.data, request.context);
      const body: ClaimDecisionDTO = toClaimDecisionDTO(decision);
      return reply.code(201).send(body);
    },
  );
};

export default claimRoutes;
