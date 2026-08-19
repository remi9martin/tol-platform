# packages/ui — Shared Design System

Shared design system consumed by apps/web (AppShell, DataGrid, MarketCard, ProvenanceChip, FreshnessBadge, etc., per the spec). Reference seed: the prototype's Tailwind theme/component classes () — port as visual reference, not lift-and-shift.

Serves gate(s): P5 Marketplace (cross-cutting apps/web presentation layer).

Status: placeholder only. No implementation yet — see the build log and the gate table at repo root.

Import boundary: consumers import only from this package's public `src/index.ts` (once it exists) via the `@tol/ui` workspace alias. Deep imports into `@tol/ui/src/internal/...` are forbidden (the spec).
