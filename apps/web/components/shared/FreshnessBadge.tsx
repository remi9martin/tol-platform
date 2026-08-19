// apps/web/components/shared/FreshnessBadge.tsx — the spec verbatim
// component name: "FreshnessBadge || .../FreshnessBadge.tsx ||
// Fresh/aging/stale/unknown." Renders @tol/evidence's REAL, server-
// computed FreshnessClass (CapacityProfile via apps/api's
// classifyCapacityFreshness, or a Passport Fact's own freshness) — this
// component never computes freshness itself, only displays a value that
// already arrived over the wire.

import { statusLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  FRESH: "chip-ok",
  AGING: "chip-warn",
  STALE: "chip-red",
  UNKNOWN: "chip-neutral",
};

export function FreshnessBadge({ freshnessClass, className }: { freshnessClass: string; className?: string }) {
  return <span className={cn("chip", TONE[freshnessClass] ?? "chip-neutral", className)}>{statusLabel(freshnessClass)}</span>;
}
