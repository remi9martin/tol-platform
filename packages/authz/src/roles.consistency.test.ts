// Guards against packages/authz's own PersonaRole/DisclosureClass copies
// (kept dependency-free on purpose — see README.md) drifting away from
// packages/db/prisma/schema.prisma's enums of the same name. This is the
// ONLY file in packages/authz that imports @tol/db or @prisma/client, and
// both are devDependencies used purely for this cross-check — no runtime
// authz code (can.ts, field-policy.ts, matrix.ts, roles.ts) depends on
// either package.

import { describe, expect, it } from "vitest";
// Prisma's generator emits enums as top-level runtime const objects
// (`{ PLATFORM_OWNER: "PLATFORM_OWNER", ... }`), not nested under the
// `Prisma` namespace export — verified directly against the generated
// client rather than assumed, since that shape isn't obvious from the
// schema alone.
import { PersonaRole as PrismaPersonaRole, DisclosureClass as PrismaDisclosureClass } from "@prisma/client";
import { PERSONA_ROLES, DISCLOSURE_CLASSES } from "./roles.js";

describe("PersonaRole / DisclosureClass stay in sync with packages/db's Prisma schema", () => {
  it("PERSONA_ROLES matches Prisma's PersonaRole enum exactly (same members, order-independent)", () => {
    const prismaRoles = Object.values(PrismaPersonaRole).sort();
    expect([...PERSONA_ROLES].sort()).toEqual(prismaRoles);
  });

  it("DISCLOSURE_CLASSES matches Prisma's DisclosureClass enum exactly (order matters here — it's a ladder)", () => {
    const prismaClasses = Object.values(PrismaDisclosureClass);
    // Order matters for authz's ladder semantics (disclosureRank), so this
    // check is intentionally NOT sorted before comparing, unlike the
    // PersonaRole check above (persona order carries no ranking meaning).
    expect(prismaClasses).toEqual(["PUBLIC_MARKET", "MEMBER_MARKET", "MATCH_SUMMARY", "DEAL_ROOM", "RESTRICTED", "SECRET"]);
    expect([...DISCLOSURE_CLASSES]).toEqual(prismaClasses);
  });
});
