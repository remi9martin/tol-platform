// packages/attribution/src/tier.ts
//
// UI-facing label for a claim's total score — independent of the claim's
// actual workflow `status` on purpose (same design as the reuse-reference
// prototype's own attributionTier: a claim can score "strong" and still
// be under active DISPUTE; the score is an input to a reviewer's
// decision, never the decision itself — the spec: "Scoring ranks
// competing claims for operator review; it does not automatically
// rewrite pre-existing legal rights.").

import { ATTRIBUTION_CONFIG } from "./config.js";

export const ATTRIBUTION_TIERS = ["strong", "moderate", "negligible"] as const;
export type AttributionTier = (typeof ATTRIBUTION_TIERS)[number];

export function attributionTier(total: number): AttributionTier {
  const { tierThresholds } = ATTRIBUTION_CONFIG;
  if (total >= tierThresholds.strong) return "strong";
  if (total >= tierThresholds.moderate) return "moderate";
  return "negligible";
}
