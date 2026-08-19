import type { DisclosureClass, Person, SourceType, VerificationStatus } from "@prisma/client";
import { newId } from "../ids.js";
import type { DbClient } from "./types.js";

export interface ContactChannel {
  type: "email" | "phone" | "other";
  value: string;
}

/**
 * Runtime guard for the Json-typed contactChannels column. TypeScript's
 * `ContactChannel[]` type only protects well-typed callers — anything
 * reaching this repository from a deserialized HTTP body (before
 * packages/contracts Zod validation runs, or if a future caller skips
 * that layer) is `unknown` at runtime. Added after review
 * (packages/db block, 2026-08-18) flagged the previous unchecked
 * `as object` cast as a real "malformed input corrupts stored JSON" gap.
 */
function assertValidContactChannels(value: ContactChannel[]): void {
  if (!Array.isArray(value)) {
    throw new TypeError("contactChannels must be an array");
  }
  for (const entry of value) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as ContactChannel).value !== "string" ||
      !["email", "phone", "other"].includes((entry as ContactChannel).type)
    ) {
      throw new TypeError('each contactChannels entry must be { type: "email"|"phone"|"other", value: string }');
    }
  }
}

export interface CreatePersonInput {
  name: string;
  title?: string | null;
  organizationId: string;
  contactChannels?: ContactChannel[];
  verificationStatus?: VerificationStatus;
  sensitivity?: DisclosureClass;
  userId?: string | null;
  createdByUserId?: string | null;
  createdByOrgId?: string | null;
  sourceType?: SourceType;
}

export const personRepository = {
  async findById(db: DbClient, id: string): Promise<Person | null> {
    return db.person.findUnique({ where: { id } });
  },

  async findByUserId(db: DbClient, userId: string): Promise<Person | null> {
    return db.person.findUnique({ where: { userId } });
  },

  async listByOrganization(db: DbClient, organizationId: string): Promise<Person[]> {
    return db.person.findMany({
      where: { organizationId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });
  },

  async create(db: DbClient, input: CreatePersonInput): Promise<Person> {
    const contactChannels = input.contactChannels ?? [];
    assertValidContactChannels(contactChannels);
    return db.person.create({
      data: {
        id: newId(),
        name: input.name,
        title: input.title ?? null,
        organizationId: input.organizationId,
        contactChannels: contactChannels as object,
        verificationStatus: input.verificationStatus ?? "UNVERIFIED",
        sensitivity: input.sensitivity ?? "MEMBER_MARKET",
        userId: input.userId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdByOrgId: input.createdByOrgId ?? null,
        sourceType: input.sourceType ?? "PLATFORM",
      },
    });
  },

  async update(
    db: DbClient,
    id: string,
    patch: Partial<Pick<CreatePersonInput, "name" | "title" | "contactChannels" | "sensitivity">>,
    updatedByUserId: string | null,
  ): Promise<Person> {
    if (patch.contactChannels !== undefined) assertValidContactChannels(patch.contactChannels);
    return db.person.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.contactChannels !== undefined ? { contactChannels: patch.contactChannels as object } : {}),
        ...(patch.sensitivity !== undefined ? { sensitivity: patch.sensitivity } : {}),
        updatedByUserId,
        version: { increment: 1 },
      },
    });
  },
};
