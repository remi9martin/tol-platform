import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Every repository function accepts a DbClient instead of importing
 * `prisma` directly, so services can pass either the top-level client or
 * an in-flight `Prisma.TransactionClient` (from `prisma.$transaction`)
 * and the repository behaves identically either way. Multi-step
 * orchestration (e.g. "revoke old membership row, create new one") is a
 * SERVICE-layer concern (apps/api) that opens the transaction and calls
 * repository functions inside it — repositories themselves stay
 * single-statement and minimal on purpose (the spec: "Services open
 * transactions, invoke domain rules and repositories").
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Node's `Buffer` types as `Uint8Array<ArrayBufferLike>` under recent
 * `@types/node` (24.x), while Prisma's generated client types every
 * `Bytes` column as `Uint8Array<ArrayBuffer>` specifically — a narrower
 * generic that `ArrayBufferLike` (which also covers `SharedArrayBuffer`)
 * doesn't structurally satisfy. This is a type-level-only mismatch, not a
 * runtime one: every `Buffer` this codebase ever constructs (from
 * `node:crypto`'s `randomBytes`/`createCipheriv` output, never from a
 * `SharedArrayBuffer`-backed source) genuinely IS a `Uint8Array<
 * ArrayBuffer>` at runtime. `toBytesInput`/`toBytesInputOrNull` narrow the
 * type at the one boundary that needs it (a Prisma `data: {...}` call)
 * rather than weakening either side's real type more broadly — used only
 * by the earlier Lockbox repositories, the first ones in this codebase to
 * persist a `Bytes` column.
 */
export function toBytesInput(buf: Buffer): Uint8Array<ArrayBuffer> {
  return buf as unknown as Uint8Array<ArrayBuffer>;
}
export function toBytesInputOrNull(buf: Buffer | null | undefined): Uint8Array<ArrayBuffer> | null {
  return buf ? toBytesInput(buf) : null;
}
