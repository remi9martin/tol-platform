// packages/events/src/lockbox-events.ts
//
// the spec names "lockbox.sealed; lockbox.committed; lockbox.withdrawn;
// lockbox.opened" verbatim among its representative domain events — all
// four, and only these four (no "lockbox.frozen"/"lockbox.match_eligible"
// event type exists, matching @tol/domain's lockbox-states.ts header
// comment on why COMMITTED/FROZEN/MATCH_ELIGIBLE/DISPUTED have no
// standalone authorized action this pass). `release`'s atomic cascade
// (SEALED -> COMMITTED -> FROZEN -> OPENED, ADR-0009) emits BOTH
// `lockbox.committed` and `lockbox.opened` from the one call — the
// mid-cascade COMMITTED and FROZEN hops don't get their own separately
// user-triggered timeline entries this pass, but COMMITTED still gets a
// named event (it's in the scope's own list) while FROZEN does not (it
// isn't).
//
// Every payload below is deliberately safe-fields-only — sha256 hashes,
// org IDs, roles, timestamps — NEVER plaintext payload content or any DEK/
// share material (earlier brief acceptance criterion 9, grep-verifiable:
// no field here is named/shaped to hold decrypted content).

import type { DomainEventEnvelope } from "./envelope.js";

export const LOCKBOX_EVENT_TYPES = ["lockbox.sealed", "lockbox.committed", "lockbox.withdrawn", "lockbox.opened"] as const;
export type LockboxEventType = (typeof LOCKBOX_EVENT_TYPES)[number];
export function isLockboxEventType(value: string): value is LockboxEventType {
  return (LOCKBOX_EVENT_TYPES as readonly string[]).includes(value);
}

export interface LockboxSealedPayload {
  sealerOrgId: string;
  relationshipType: string;
  region: string;
  /** sha256(ciphertext), hex — never the plaintext or DEK/share material. */
  ciphertextHash: string;
}

export interface LockboxCommittedPayload {
  ciphertextHash: string;
}

export interface LockboxWithdrawnPayload {
  withdrawReason: string | null;
}

export interface LockboxOpenedPayload {
  recipientOrgId: string;
  conditionRef: string;
  /** e.g. ["OPERATOR", "ESCROW"] — which threshold roles authorized this specific release (ADR-0009). */
  authorizedRoles: string[];
  ciphertextHash: string;
}

/** Discriminated union — a switch over `eventType` narrows `payload` for free at every call site that builds one of these (apps/api's lockbox service). */
export type LockboxTimelineEvent =
  | DomainEventEnvelope<"lockbox.sealed", LockboxSealedPayload>
  | DomainEventEnvelope<"lockbox.committed", LockboxCommittedPayload>
  | DomainEventEnvelope<"lockbox.withdrawn", LockboxWithdrawnPayload>
  | DomainEventEnvelope<"lockbox.opened", LockboxOpenedPayload>;
