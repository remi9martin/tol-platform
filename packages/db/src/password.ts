// packages/db/src/password.ts
//
// Password hashing lives next to the User model it serves (not in
// packages/crypto, which the spec/ADR-0001 scope specifically to
// Lockbox envelope encryption — a different, cryptographically unrelated
// concern) and not duplicated in apps/api, so packages/db's own seed
// script and apps/api's login/auth service hash and verify against
// exactly the same algorithm and cost factor. Pure-JS bcryptjs (not a
// native-binding bcrypt) is used deliberately — it needs no node-gyp/
// Visual Studio build toolchain, which keeps `pnpm install` reliable on a
// plain Windows dev machine.

import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
