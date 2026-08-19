# packages/contracts — Zod DTOs

Zod DTOs + generated OpenAPI schemas (the spec, p.11). Single source of truth for request/response shapes; apps/web's API client and apps/api's route validation both derive from here.

Serves gate(s): supports P4 Auth, P2 Personas (all earlier apps/api routes) — not itself a numbered gate, but p.8's "typed contracts, no ad hoc fetch parsing" rule requires it exist before apps/web can be spec-compliant.

**Status: implemented for exactly the resources** — auth (login/session/switch-org), organizations, memberships, audit events. Zod schemas double as runtime request validators (`apps/api`) and as the type source (`z.infer`) both `apps/api`'s mappers and `apps/web`'s API client import.

**Not built this pass:** OpenAPI generation + CI breaking-change checks (the spec: "OpenAPI is generated from @tol/contracts and checked in CI"). That needs a CI pipeline (`.github/workflows`) which earlier doesn't stand up, and a surface stable enough to be worth generating a spec from. Tracked as an open item.

## Import boundary

Consumers import only from `src/index.ts` via the `@tol/contracts` workspace alias.
