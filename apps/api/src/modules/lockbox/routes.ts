// apps/api/src/modules/lockbox/routes.ts
//
// the spec's REST shape (POST /v1/lockbox/submissions, .../commit,
// .../withdraw, .../release) adapted to this earlier build's 4-action scope
// (seal/getReceipt/withdraw/release — no standalone commit endpoint this
// pass, see @tol/domain/src/lockbox-states.ts's header comment) and this
// codebase's existing route-naming convention (no /v1 prefix, matching
// every other module).

import type { FastifyPluginAsync } from "fastify";
import {
  ReleaseLockboxRequestSchema,
  SealLockboxRequestSchema,
  WithdrawLockboxRequestSchema,
  type ListLockboxesResponse,
  type ReleaseLockboxResponse,
} from "@tol/contracts";
import { prisma } from "@tol/db";
import { lockboxService } from "./service.js";
import { toLockboxDTO, toLockboxReceiptDTO, toLockboxReleaseEvidenceDTO } from "./mapper.js";
import { ProblemError, zodFieldErrors } from "../../shared/errors.js";
import { withIdempotency } from "../../shared/idempotency.js";

const lockboxRoutes: FastifyPluginAsync = async (app) => {
  app.get("/lockbox", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const lockboxes = await lockboxService.list(request.actor!);
    const body: ListLockboxesResponse = { lockboxes: lockboxes.map(toLockboxDTO) };
    return reply.code(200).send(body);
  });

  app.get<{ Params: { id: string } }>("/lockbox/:id", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const lockbox = await lockboxService.getById(request.actor!, request.params.id);
    return reply.code(200).send(toLockboxDTO(lockbox));
  });

  // "getReceipt" — proof-of-existence only (hash/version/sealed-date/
  // signature), structurally distinct from ever reading contents (earlier
  // brief) — there is no equivalent /lockbox/:id/contents route anywhere
  // in this file.
  app.get<{ Params: { id: string } }>("/lockbox/:id/receipt", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const receipt = await lockboxService.getReceipt(request.actor!, request.params.id);
    return reply.code(200).send(toLockboxReceiptDTO(receipt));
  });

  // the spec: Idempotency-Key — a retried seal must not encrypt and
  // persist the same payload twice under two different DEKs/lockbox ids.
  app.post("/lockbox", { preHandler: [app.requireAuth, app.requireCsrf] }, async (request, reply) => {
    const parsed = SealLockboxRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ProblemError.badRequest("Invalid Lockbox seal request.", zodFieldErrors(parsed.error.issues));
    }

    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    const dto = await withIdempotency(
      prisma,
      {
        key: idempotencyKey,
        scope: "lockbox.seal",
        method: request.method,
        path: request.url,
        body: request.body,
        organizationId: request.actor!.organizationId,
        userId: request.actor!.userId,
      },
      async () => {
        const lockbox = await lockboxService.seal(request.actor!, parsed.data, request.context);
        return toLockboxDTO(lockbox);
      },
    );

    return reply.code(201).send(dto);
  });

  app.post<{ Params: { id: string } }>(
    "/lockbox/:id/withdraw",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = WithdrawLockboxRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid Lockbox withdraw request.", zodFieldErrors(parsed.error.issues));
      }
      const updated = await lockboxService.withdraw(request.actor!, request.params.id, parsed.data, request.context);
      return reply.code(200).send(toLockboxDTO(updated));
    },
  );

  // DELIBERATELY NOT wrapped in withIdempotency — real review finding
  // (review), confirmed and fixed:
  // withIdempotency persists its handler's RETURN VALUE verbatim into
  // `idempotency_keys.response_body` (a Json column) so a retried request
  // can replay it — but this endpoint's response includes
  // `disclosedPayload`, the real decrypted plaintext. Wrapping it would
  // have created a SECOND place plaintext gets persisted to the
  // database, directly violating acceptance criterion 9 ("no plaintext
  // payload is ever persisted... grep-verifiable"). Unlike `seal` (a
  // genuine duplicate-network-retry risk — a retried POST really would
  // create a second Lockbox under a second DEK) and `withdraw` (also
  // unwrapped, same reasoning), `release` doesn't actually NEED
  // idempotency protection to be safe: the underlying state machine
  // already makes a second call a clean no-op — @tol/domain's
  // `assertValidLockboxReleaseCascade` throws (mapped to a clean 400
  // `invalid_state_transition` by app.ts's central handler) the instant a
  // retry targets an already-OPENED Lockbox, proven directly in
  // apps/api/tests/integration/lockbox.test.ts's "releasing an
  // already-OPENED Lockbox again fails cleanly" test.
  app.post<{ Params: { id: string } }>(
    "/lockbox/:id/release",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (request, reply) => {
      const parsed = ReleaseLockboxRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw ProblemError.badRequest("Invalid Lockbox release request.", zodFieldErrors(parsed.error.issues));
      }

      const result = await lockboxService.release(request.actor!, request.params.id, parsed.data, request.context);
      const body: ReleaseLockboxResponse = {
        lockbox: toLockboxDTO(result.lockbox),
        releaseEvidence: toLockboxReleaseEvidenceDTO(result.releaseEvidence),
        disclosedPayload: result.disclosedPayload,
      };

      return reply.code(200).send(body);
    },
  );
};

export default lockboxRoutes;
