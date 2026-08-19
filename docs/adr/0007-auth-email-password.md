# ADR-0007: Initial auth is email+password against seeded users; magic-link/Google OAuth deferred

**Status:** Accepted
**Date:** 2026-08-18
**Decision owner:** Product (via the build's own explicit instruction: "auth
(session/JWT — a real login, even if seeded users)")

## Context

The spec specifies the eventual MVP-wide authentication mechanism: "Email magic-link
and Google OAuth for MVP; MFA required for operator/admin and configurable for
institutional users." An earlier, narrower-scoped build task explicitly authorized a
seeded-user login instead: "auth (session/JWT — a real login, even if seeded users)."

Building the scope's literal mechanism this pass would have required:
- **Magic-link email delivery** — needs a working SMTP integration. `docker-compose.yml`
  already runs Mailpit for local dev, so this is a real but *cheap* follow-up, not
  fundamentally blocked.
- **Google OAuth** — needs a real registered Google Cloud OAuth application with a live
  client ID/secret. Not available to provision during this build.

Shipping neither and calling auth "done" would violate the no-placeholder standard this
build is held to. Shipping a fake/stubbed login (e.g. a client-side "pretend you're
logged in" toggle, which is exactly what the prototype's `OrgSwitcherContext` already
was) would fail the P4
gate outright, since "tenant isolation proven" requires a REAL session boundary to prove
isolation across.

## Decision

This ADR ships **real, complete email+password authentication** against database-seeded
users, as the actual (not stubbed) auth mechanism for this phase:

- `packages/db`'s `User.passwordHash` — bcrypt, 12 salt rounds, next to the `User` model
  it serves (`packages/db/src/password.ts`).
- `apps/api/src/modules/auth/service.ts` — `POST /auth/login` verifies credentials,
  issues a DB-backed, revocable session (HMAC-signed opaque token, `Session` table),
  never stores or logs the raw token or password.
- Session cookies: `HttpOnly`, `Secure` in production, `SameSite=Lax`, per the spec
  verbatim.
- CSRF: double-submit cookie pattern, verified on every cookie-authenticated mutation.
- Rate limiting: 10 attempts/minute on `/auth/login` specifically (stricter than the
  300/minute global default), per the spec's "stricter limits for auth... endpoints."
- Identical, generic failure message on "no such user" and "wrong password" (a standard
  user-enumeration mitigation), plus a dummy-hash comparison on the no-such-user path so
  the two cases' response-time profile stays close (documented as a *partial* mitigation,
  not oversold as complete — see the code comment in `auth/service.ts`).

None of this is a stub — it's the real, load-bearing auth mechanism, verified by the P4
tenant-isolation proof (the test-evidence record for p4-auth) which depends on a genuine session
boundary existing.

Magic-link and Google OAuth are **explicitly deferred, not silently dropped.**

## Consequences

- `User.passwordHash` remains a permanent, load-bearing column — magic-link/OAuth, when
  added, become ADDITIONAL ways to establish the same `Session` primitive this ADR
  builds, not a replacement for it. Password auth stays valid (useful for
  seeded/operator/service accounts even after magic-link ships for end users).
- `User.mfaEnabled` exists as a schema field (so `packages/authz` can eventually require
  it for operator-tier roles) but has no enrollment/challenge flow yet — also deferred,
  also named explicitly rather than left for a reviewer to discover by absence.
- A later ADR should record the magic-link/OAuth implementation when it lands, per this
  file's own precedent — don't silently extend `auth/service.ts` without a paper trail
  for a decision this consequential.
- Gates affected: **P4 — Auth** (this IS the mechanism the tenant-isolation proof runs
  against — DONE, see the test-evidence record for p4-auth). **P18 — Security** (MFA
  enrollment is a real open item for that gate, not yet started).
