# apps/web — Member/Operator UI

Next.js App Router UI. Renders screens and calls `@tol/contracts`; never reimplements scoring, access control or state transitions (the spec).

Serves gate(s): P5 Marketplace, P6 Passport, P9 Lockbox (client-side seal UI), P13 RFQ, P14 Deal Room, P15 Economics (view), P19 Pilot — all later days. earlier serves the P4 Auth exit evidence's UI half ("Two organizations sign in").

**Status: implemented** — route groups `(public)/(auth)/(app)` per the spec, real session-cookie auth (no fake "viewing as" context), sign-in screen, and an authenticated dashboard calling `apps/api` for the actor's session + active organization profile.

## Local setup

```bash
# from repo root — apps/api and postgres must already be running
pnpm --filter @tol/web run dev
```

Requires `apps/web/.env.local` with `NEXT_PUBLIC_API_URL` pointing at a running `apps/api` (see `.env.example` at the repo root — Next.js loads env files relative to `apps/web/`, not the monorepo root, so the value has to be mirrored there).

Sign in with any seeded user from `packages/db/README.md` (e.g. `alice@meridian-acquiring.example` / `TolSeed!2026-Dev`).

## What's ported from the prototype, and what isn't

Per `../'s reuse guidance:

- **Ported near-verbatim**: `app/globals.css`'s crimson/black theme tokens, the `AppShell`/`TopBar`/`Sidebar` responsive-drawer structure and Tailwind component classes (`.panel`, `.chip-*`, `.btn-*`).
- **Rebuilt, not ported**: `OrgSwitcher` now calls a real `POST /auth/switch-org` (authz-checked, audited) instead of mutating a client-only React Context. `Sidebar` shows only the real route (`/app`) as a live link — the prototype linked to real Next.js routes that rendered a generic `StubScreen`; this build shows the same future-IA labels as plain non-clickable text instead, since building placeholder pages for entities that don't exist yet (Opportunity, Capacity, Lockbox…) would race ahead of the scope.
- **Not ported at all**: every screen under `/organizations`, `/passport`, `/match`, `/lockbox`, `/rfq`, `/deal-room`, `/attribution`, `/operator` — all earlier+ once their backing entities exist.

## Design notes

- `tsconfig.json` does NOT `extend` the monorepo's `tsconfig.base.json` — Next.js apps need `moduleResolution: "bundler"` and different `target`/`module` settings than the Node.js backend packages use. `strict`/`noImplicitAny`/`noUncheckedIndexedAccess` are still set explicitly to satisfy the spec's TypeScript rule.
- No `packages/ui` extraction this pass — earlier has exactly one consumer of the design system (this app). Extracting a shared package with only one caller is premature abstraction; revisit once a second app genuinely needs the same components.
- `proxy.ts` (Next.js 16 renamed the `middleware.ts` convention — see its own header comment) and `(app)/layout.tsx` are both UX conveniences, not the security boundary — see their own doc comments. The actual boundary is `apps/api`'s auth plugin + `packages/authz`'s `can()` on every route.

## Import boundary

Consumers import only from `@tol/contracts`'s public surface for API shapes — no ad hoc inline response types (the spec).
