# apps/api — REST/OpenAPI Service

Fastify service. route -> service -> repository layering; services open transactions, invoke domain rules and repositories, enqueue outbox events (the spec). Never calls Prisma directly — that's @tol/db's job.

Serves gate(s): P3 Data, P4 Auth, P7 Opportunity, P9 Lockbox, P13 RFQ, P16 Audit.

Status: placeholder only. No implementation yet — see the build log and the gate table at repo root.
