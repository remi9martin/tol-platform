# packages/authz — RBAC/ABAC Policy

Hybrid RBAC + object/purpose-based policy (the spec, p.11, p.27). Exposes `can(actor, action, resource, context)` and `fieldPolicy(actor, resource)`. apps/api's services and apps/web's affordance rendering both call this — the UI never enforces, only reflects.

Serves gate(s): P2 Personas (authority matrix), P4 Auth (tenant isolation), P5 Marketplace (field-tier redaction via the existing `fieldPolicy()`/`redactFields()` mechanism), P6 Passport, P18 Security (authz scans, later).

**Status: implemented.** `can()`, `fieldPolicy()`, the full 10-persona authority matrix (`matrix.ts`), and unit tests proving deny-by-default, tenant isolation, and the disclosure ladder. See the test-evidence record for p4-auth` for how this connects to the end-to-end API proof (this stage).

**earlier addition (P5 Marketplace + P6 Passport):** a new `passport` resource type and `passport.create/read/list/update/verify` actions (own-org maintainer roles create/read/update; PLATFORM_OWNER/MARKETPLACE_OPERATOR/COMPLIANCE_REVIEWER additionally verify cross-org). `opportunity.browse_market`/`capacity.browse_market` — a DELIBERATELY BROADER, blanket cross-org grant to all 10 personas (the spec: "Members can see market depth"), distinct from the existing narrower `opportunity.read`/`capacity.read` grants which still gate the full record. **`fieldPolicy()`/`redactFields()` themselves needed NO code changes** — audited during this stage and found already general enough: the marketplace's server-side redaction requirement is satisfied entirely by tagging each Opportunity/CapacityProfile field with the right `DisclosureClass` at the `apps/api` mapper layer (this stage), the same `FIELD_CLASSES`-constant pattern `organizations/mapper.ts` already established earlier — a non-owner market browser is capped at the existing default `MEMBER_MARKET` ceiling automatically, with no marketplace-specific carve-out needed in this package.

## Why no dependencies

This package has **zero runtime dependencies** — not even on `@tol/db`. It defines its own `PersonaRole`/`DisclosureClass` vocabulary (`roles.ts`) rather than importing Prisma's generated types, kept in sync with `packages/db/prisma/schema.prisma`'s enums of the same name by `roles.consistency.test.ts` (which uses `@tol/db` as a **devDependency**, test-only). A security-critical policy engine should be trivially unit-testable in complete isolation, with the smallest possible transitive attack surface — that's a deliberate architecture choice, not an oversight.

## How the pieces fit together

- **`roles.ts`** — the `PersonaRole` (10 values, the spec) and `DisclosureClass` (6 values, ADR-0005) vocabulary, plus the disclosure ladder ranking.
- **`actions.ts`** — the earlier `Action` vocabulary (scoped to exactly the resources that exist this pass: Organization, OrganizationMembership, Person, AuditEvent) and the `Actor`/`Resource`/`AuthContext` shapes every decision is made against.
- **`matrix.ts`** — the P2 authority matrix: one `RoleGrant` per persona, translated from p.4's "Primary job"/"Special authority" columns. **Deny by default is structural**: a module-load-time check throws if any `PersonaRole` is missing a matrix entry, and `can()` never has an implicit "allow" fallback.
- **`can.ts`** — the P4 gate. Tenant isolation is not bolted on separately; it IS this function's core mechanism (`resource.ownerOrgId !== actor.organizationId` → deny, unless the role has an explicit cross-org grant for that action).
- **`field-policy.ts`** — field-level disclosure by `privacy_class`. Ownership always wins (an org sees 100% of its own data regardless of privacyClass); cross-org viewers are capped by a role-specific ceiling on the six-tier ladder.

## Tests as the P2/P4 evidence

- `can.test.ts` — the core P4 proof (same-role-different-org denied; explicit cross-org grants allowed) plus P2 deny-by-default proof (an unlisted role/action combination is denied, with a reason string saying so).
- `matrix.test.ts` — structural invariants on the matrix itself (every role has exactly one entry, `AUDITOR_READONLY` has zero write actions, `membership.update_role` is PLATFORM_OWNER-only).
- `field-policy.test.ts` — the disclosure ladder and `redactFields()` helper.
- `roles.consistency.test.ts` — cross-checks against `@tol/db`'s Prisma enums so the two vocabularies can never silently drift apart.

The end-to-end version of the P4 proof (an actual HTTP request from Org A's session hitting Org B's data through `apps/api`) lives in `apps/api/tests/integration/` — this package's tests prove the *policy engine* is correct in isolation; the API tests prove it's *actually wired in*.

## Import boundary

Consumers import only from this package's public `src/index.ts` via the `@tol/authz` workspace alias. Deep imports into `@tol/authz/src/...` internals are forbidden (the spec).
