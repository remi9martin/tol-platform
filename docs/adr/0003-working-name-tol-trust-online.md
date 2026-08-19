# ADR-0003: "TOL / Trust Online" is a working name pending trademark/domain clearance

**Status:** Accepted (provisional)
**Date:** 2026-08-18
**Decision owner:** Product

## Context

Neither the build spec nor the business plan (`TOL_Extensive_Business_Plan.html`)
ever expands what "TOL" stands for — both documents write "TOL Marketplace" / "TOL"
throughout without defining the acronym anywhere. "TOL — Trust Online" is exclusively an
invention of the already-built prototype and explainer site (`package.json` description,
`README.md`, `BUILD_NOTES.md` in the prototype repo, and the prototype's own
explainer-site header) — it has zero
authoritative backing from either new source document.

An established "TOL" already exists in logistics (TNT/Toll) — a real collision risk for
trademark and search visibility if this name goes public without clearance.

## Decision

Keep "TOL / Trust Online" as the **working name** through earlier phases so naming does not
block engineering. This is provisional, not final.

**A trademark + domain clearance check is required before any public-facing or
investor-facing use** — decks, the sales/marketing site, page titles, metadata, or any
copy a counterparty or investor will see.

## Consequences

- Internal code, package names (`@tol/*`), repo name (`tol-platform`), and internal docs
  may continue using "TOL" without waiting on clearance — none of that is public-facing.
- Before any of the following ship, clearance must complete or the name must change:
  investor deck, public sales site, App Store/domain registration, press mentions,
  signed counterparty agreements referencing the brand name.
- If clearance fails, expect a rename pass across `@tol/*` package scopes, the repo
  itself, and all public copy — flagged here so that pass isn't a surprise later.
- Gate affected: **P1 — Ownership** (`Repo/accounts/IP boundary documented`) — this ADR
  is part of that documentation.
