// apps/worker/src/shared/transaction.ts — mirrors apps/api/src/shared/
// transaction.ts exactly. Added as part of the concurrency-locking fix
// below: every this stage job that performs a state transition or a ledger
// mutation now opens a real transaction, takes an advisory lock on the
// aggregate id FIRST (see lock.ts), then re-reads fresh — same pattern
// apps/api/src/modules/claims/service.ts's fileDispute()/decide() already
// prove works, applied here since a background job racing another
// background job (or racing an apps/api request) on the SAME aggregate is
// exactly the concurrent-mutation shape P17 exists to rule out.

import { prisma, type Prisma } from "@tol/db";

export function withTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn);
}
