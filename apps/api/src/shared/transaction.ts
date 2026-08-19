// apps/api/src/shared/transaction.ts
//
// Thin wrapper so services never import `prisma` from @tol/db directly
// just to call $transaction — they import withTransaction from here,
// keeping "which client talks to Postgres" fully inside @tol/db's own
// export surface plus this one call site (the spec: "Services open
// transactions, invoke domain rules and repositories").

import { prisma, type Prisma } from "@tol/db";

export function withTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn);
}
