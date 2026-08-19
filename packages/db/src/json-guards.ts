// packages/db/src/json-guards.ts
//
// Runtime shape guards for this package's Json columns, called from each
// repository's create()/write path BEFORE the `as object` cast reaches
// Prisma. Same discipline as the Person.contactChannels fix
// (review "packages/db block", 2026-08-18: "added
// assertValidContactChannels(), called from both create and update") —
// generalized here because this package introduces many more Json fields
// (jurisdictions/mccs/commercialTerms/disclosureSnapshot/terms/
// comparisonSnapshot) than the original helper was scoped for.
//
// review (2026-08-18) correctly flagged every one of these call sites as a
// BLOCKER/MAJOR cluster: casting `unknown`/`unknown[]` straight to
// `object` for a Prisma Json field bypasses validation entirely — a
// malformed value (a function, a circular reference, a bare string where
// an array was expected) would either throw a raw, confusing Prisma/
// JSON-serialization error deep inside a repository call, or — worse —
// silently persist a shape downstream readers don't expect. This is
// deliberately a SEPARATE, defense-in-depth layer from
// @tol/contracts' zod schemas (this stage) — the same "belt and suspenders"
// reasoning as @tol/domain's money.ts guards: contracts validates the
// wire REQUEST shape; these guards validate whatever a caller actually
// hands a repository function, which is not always a freshly-zod-parsed
// value (e.g. a service reconstructing a comparisonSnapshot from
// several already-loaded Quote rows).

export class JsonShapeError extends TypeError {
  constructor(message: string) {
    super(`invalid Json field shape: ${message}`);
    this.name = "JsonShapeError";
  }
}

/**
 * Same set @tol/authz's field-policy.ts already defends `redactFields()`
 * with — reused here as a second, independent choke point (review raised a prototype-pollution
 * concern against `PassportActions.tsx`'s `JSON.parse(...)` call on a
 * Fact's free-form value; not actually exploitable via the current call
 * chain — nothing in this codebase ever `Object.assign`s/spreads a
 * client-submitted `normalizedValue` into a shared live object, which is
 * the actual mechanism prototype pollution requires — but rejecting
 * these three key names here is cheap, consistent with this codebase's
 * existing belt-and-suspenders philosophy, and closes the gap for good
 * regardless of how this value is ever consumed in the future).
 */
const DANGEROUS_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** For fields like Opportunity.jurisdictions/mccs, CapacityProfile.mccsAccepted/mccsExcluded — a flat array of short code strings. */
export function assertStringArray(value: unknown, fieldName: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new JsonShapeError(`${fieldName} must be an array, got ${typeof value}`);
  }
  for (const [i, item] of value.entries()) {
    if (typeof item !== "string") {
      throw new JsonShapeError(`${fieldName}[${i}] must be a string, got ${typeof item}`);
    }
  }
}

/**
 * For structured object fields (CapacityProfile.commercialTerms,
 * RFQVersion.disclosureSnapshot, Quote.terms, DealDecision.
 * comparisonSnapshot) — earlier does not enforce each object's FULL nested
 * shape here (that is @tol/contracts' zod schema's job once this stage
 * exists, and a caller can legitimately hand this a superset of
 * documented fields). This function only rejects the class of value that
 * would silently corrupt or crash: non-plain-objects, and — critically —
 * checks recursively for values JSON cannot represent at all (functions,
 * bigint, undefined-in-arrays, circular references) so a bad value fails
 * LOUDLY here with a clear field path, instead of failing deep inside
 * Prisma's own JSON serialization with a much less legible error, or
 * (for `undefined`, which JSON.stringify silently drops from objects)
 * not failing at all and quietly writing a shape short of what the
 * caller intended.
 */
export function assertJsonSafePlainObject(value: unknown, fieldName: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JsonShapeError(`${fieldName} must be a plain object, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
  }
  assertJsonSerializable(value, fieldName, new Set());
}

/**
 * earlier addition — for fields like ClaimDispute.evidence (p.13: an array
 * of evidence-item objects, embedded rather than joined to ClaimEvidence
 * — see packages/db/prisma/schema.prisma's ClaimDispute comment). Same
 * "reject what would silently corrupt or crash" scope as
 * assertJsonSafePlainObject above, applied per-array-element with the
 * offending index in the error path.
 */
export function assertJsonSafeObjectArray(value: unknown, fieldName: string): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new JsonShapeError(`${fieldName} must be an array, got ${typeof value}`);
  }
  for (const [i, item] of value.entries()) {
    assertJsonSafePlainObject(item, `${fieldName}[${i}]`);
  }
}

/**
 * earlier addition — for `Fact.normalizedValue` (the spec: a Fact's
 * value is polymorphic — a string, number, boolean, or small object
 * depending on `fieldKey` — unlike every other Json column in this
 * codebase so far, which is always either a plain object
 * (assertJsonSafePlainObject) or a string array (assertStringArray)).
 * `null`/`undefined` are rejected here — an absent Fact value is
 * represented by the FACT ROW ITSELF being absent (no row for that
 * fieldKey), never a present row holding a null value, so the readiness
 * engine's "does a required fact have a value" check
 * (packages/evidence) can stay a simple row-existence check rather than
 * also needing a null-check on top of it.
 */
export function assertJsonSerializableValue(value: unknown, fieldName: string): void {
  if (value === null || value === undefined) {
    throw new JsonShapeError(`${fieldName} must not be null/undefined — omit the Fact entirely instead of writing a null value`);
  }
  assertJsonSerializable(value, fieldName, new Set());
}

function assertJsonSerializable(value: unknown, path: string, seen: Set<unknown>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new JsonShapeError(`${path} must be a finite number, got ${value}`);
    return;
  }
  if (typeof value === "bigint") {
    throw new JsonShapeError(`${path} is a bigint — JSON cannot represent it; convert to a Number or String before building this object`);
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") {
    throw new JsonShapeError(`${path} is a ${typeof value}, which is not JSON-representable`);
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new JsonShapeError(`${path} contains a circular reference`);
    }
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, i) => assertJsonSerializable(item, `${path}[${i}]`, seen));
    } else {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (DANGEROUS_JSON_KEYS.has(key)) {
          throw new JsonShapeError(`${path}.${key} uses a reserved key name ("__proto__"/"constructor"/"prototype") — not permitted in a persisted Json value`);
        }
        assertJsonSerializable(item, `${path}.${key}`, seen);
      }
    }
    seen.delete(value);
    return;
  }
}
