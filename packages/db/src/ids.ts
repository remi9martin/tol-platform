// packages/db/src/ids.ts
//
// UUIDv7 generation. the spec: "Primary IDs — UUIDv7 or equivalent
// sortable opaque IDs; never expose sequential DB IDs." Prisma 6's
// traditional PostgreSQL driver has no built-in UUIDv7 default (stock
// postgres:16-alpine has no pg_uuidv7 extension installed), so IDs are
// generated application-side, in the repository layer, before insert.

import { randomBytes } from "node:crypto";

const HEX = (n: number) => n.toString(16).padStart(2, "0");

/**
 * Generates a UUIDv7 per RFC 9562: a 48-bit big-endian Unix millisecond
 * timestamp, a 4-bit version field (0111), and 74 bits of randomness (with
 * the 2-bit variant field set), laid out as:
 *
 *   unix_ts_ms (48 bits) | ver (4 bits) | rand_a (12 bits) | var (2 bits) | rand_b (62 bits)
 *
 * Sortable by creation time (lexicographic string order matches creation
 * order at millisecond resolution) while the random portion remains
 * unguessable — the property the spec asks for ("sortable opaque IDs;
 * never expose sequential DB IDs").
 */
export function newId(): string {
  const unixTsMs = BigInt(Date.now());
  const rand = randomBytes(10);

  const bytes = new Uint8Array(16);

  // bytes 0-5: 48-bit timestamp, big-endian.
  bytes[0] = Number((unixTsMs >> 40n) & 0xffn);
  bytes[1] = Number((unixTsMs >> 32n) & 0xffn);
  bytes[2] = Number((unixTsMs >> 24n) & 0xffn);
  bytes[3] = Number((unixTsMs >> 16n) & 0xffn);
  bytes[4] = Number((unixTsMs >> 8n) & 0xffn);
  bytes[5] = Number(unixTsMs & 0xffn);

  // byte 6: version nibble (0111) + top 4 bits of rand_a.
  bytes[6] = 0x70 | (rand[0]! & 0x0f);
  // byte 7: low 8 bits of rand_a (12-bit rand_a total).
  bytes[7] = rand[1]!;
  // byte 8: variant bits (10) + top 6 bits of rand_b.
  bytes[8] = 0x80 | (rand[2]! & 0x3f);
  // bytes 9-15: remaining 56 bits of rand_b (62-bit rand_b total).
  bytes[9] = rand[3]!;
  bytes[10] = rand[4]!;
  bytes[11] = rand[5]!;
  bytes[12] = rand[6]!;
  bytes[13] = rand[7]!;
  bytes[14] = rand[8]!;
  bytes[15] = rand[9]!;

  let hex = "";
  for (const b of bytes) hex += HEX(b);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
