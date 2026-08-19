# ADR-0005: Canonical DisclosureClass enum is page 12's six-value list

**Status:** Accepted
**Date:** 2026-08-18
**Decision owner:** Product

## Context

The scope states the disclosure-tier enum three different ways across three pages — an
internal scope inconsistency, not a scope-vs-business-plan conflict. Verified
directly against the spec during earlier grounding:

- **p.4** (personas/authority table, line 126): `PUBLIC_MARKET, MEMBER_MARKET,
  MATCH_SUMMARY, DEAL_ROOM, RESTRICTED_OPERATOR, SECRET`
- **p.12** (canonical data model, "Data class" row, line 312): `PUBLIC_MARKET /
  MEMBER_MARKET / MATCH_SUMMARY / DEAL_ROOM / RESTRICTED / SECRET` — note `RESTRICTED`,
  not `RESTRICTED_OPERATOR`.
- **p.22** (Deal Room disclosure-tiers table, lines 649–656): `MATCH_SUMMARY,
  QUALIFIED_RFQ, DUE_DILIGENCE, RESTRICTED` — a different four-value list introducing
  `QUALIFIED_RFQ` and `DUE_DILIGENCE` (seen nowhere else), dropping `PUBLIC_MARKET`/
  `MEMBER_MARKET`/`DEAL_ROOM`/`SECRET` entirely.

Someone had to pick the one true list, or explicitly define how p.22's tiers map onto
p.4/p.12's classes, before `packages/authz`'s `fieldPolicy()` could be written.

## Decision

**p.12's six-value list is canonical:** `PUBLIC_MARKET`, `MEMBER_MARKET`,
`MATCH_SUMMARY`, `DEAL_ROOM`, `RESTRICTED`, `SECRET`.

Mapping for the other two pages' variants:

| Scope variant | Canonical value | Rationale |
|---|---|---|
| p.4 `RESTRICTED_OPERATOR` | `RESTRICTED` | Same tier; p.4 is describing which *persona* (operator role) can access it, not defining a seventh class. |
| p.22 `MATCH_SUMMARY` | `MATCH_SUMMARY` | Direct match. |
| p.22 `QUALIFIED_RFQ` | Sub-tier / packet type within `DEAL_ROOM` | "Named entity + normalized opportunity + selected evidence" (p.22) — a disclosure *packet shape* once a Deal Room is open, not a top-level privacy class. |
| p.22 `DUE_DILIGENCE` | Sub-tier / packet type within `RESTRICTED` | "UBO, detailed processing evidence, documents" (p.22) — the most sensitive named packet shape, governed by `RESTRICTED`'s access rules. |
| p.22 `RESTRICTED` | `RESTRICTED` | Direct match. |

## Consequences

- `packages/authz`'s `DisclosureClass` type has exactly six values, matching p.12
  verbatim.
- `QUALIFIED_RFQ` and `DUE_DILIGENCE` are not deleted from the product vocabulary — they
  become named `DisclosureGrant.packetType` (or equivalent field) values scoped under
  `DEAL_ROOM` / `RESTRICTED` respectively, so Deal Room UI copy in `apps/web` can still
  say "Qualified RFQ packet" / "Due Diligence packet."
- Any future scope re-read that surfaces a fourth conflicting list should be resolved by
  amending this ADR with a new dated entry, not by silently picking a different one in
  code.
- Gates affected: **P2 — Personas** (authority matrix references disclosure classes),
  **P13 — RFQ** (`QUALIFIED_RFQ` packet), **P14 — Deal Room** (`DUE_DILIGENCE` packet),
  **P18 — Security** (`fieldPolicy()` enforcement).
