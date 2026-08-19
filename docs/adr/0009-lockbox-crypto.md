# ADR-0009: Lockbox crypto implementation — server-side AES-256-GCM, Shamir (2-of-3) threshold, HMAC receipts

**Status:** Accepted
**Date:** 2026-08-18
**Decision owner:** Product, within the bounds of ADR-0001 (escrowed/threshold custody, the product/legal decision — not reopened here) and
the original build brief's explicit crypto acceptance criteria (1–9).

## Context

ADR-0001 (D1) decided the custody *model*: TOL, or a threshold of parties, can release
a sealed Lockbox submission — not submitter-retained-only custody. It did not decide
the concrete cryptographic mechanism, and one of its own stated consequences ("a
per-submission DEK wraps the plaintext client-side (Web Crypto AES-GCM)") was written
as an illustrative sketch of the MVP model the scope itself offers as one of two
options (p.17: "Browser generates a random 256-bit data-encryption key... encrypts
payload/files with AES-GCM using Web Crypto"), not a binding implementation
requirement — the scope's OTHER named option, and the one D1 actually picked, is
"envelope encryption with threshold/escrowed release authorization" (p.17), which this
ADR implements. Four concrete design questions had to be resolved to build it for
real, not simulated:

1. Where does the AES-GCM encryption actually run — the browser (Web Crypto) or the
   server (Node `crypto`)?
2. How is "no single stored value can decrypt a sealed payload alone" (the earlier brief's
   acceptance criterion 3) made cryptographically real, not just an access-control
   convention layered on top of one key?
3. What signs the receipt, and under what scheme?
4. How does the threshold get exercised at release time — who supplies what, and how
   many parties does "≥2 authorizations" concretely mean?

## Decision

### 1. Server-side Node `crypto`, not browser Web Crypto

`packages/crypto` runs entirely server-side, called from `apps/api`'s lockbox service.
`apps/web`'s `SealSubmissionForm` collects plaintext form fields and POSTs them over
the existing HTTPS/session/CSRF-protected channel; encryption happens inside the API
request handler, immediately, before the payload is persisted.

This is a deliberate deviation from ADR-0001's illustrative client-side sketch, for
three concrete reasons:

- **D1 already rejected the strongest client-side justification.** Client-side Web
  Crypto is what makes the scope's OTHER MVP option ("submitter retains the release
  key locally... TOL cannot decrypt until the submitter performs Release," p.17)
  meaningfully different from server-side encryption — but D1 explicitly chose the
  escrowed/threshold model instead, under which the platform (with the threshold's
  cooperation) can decrypt regardless of where encryption originally happened. Doing
  the encryption client-side would add real implementation complexity (key generation
  in the browser, safely transporting Shamir shares or wrapped-DEK material back to
  the server, browser-crypto/Node-crypto interop testing) for a security property (the
  server never sees plaintext EVEN TRANSIENTLY) that D1's own chosen model doesn't
  claim or need — the "LOCKBOX CLAIM TEST" (p.27) already requires this system to be
  honest that operations personnel, under the threshold's controls, CAN decrypt.
- **Testability.** Every acceptance criterion (1–9) needs a real, executed test —
  `packages/crypto`'s 72-test suite runs entirely in Node, against the exact code path
  `apps/api` calls in production, with zero jsdom/browser-environment shimming. A
  client-side implementation would either need browser-environment tests (heavier,
  slower, less exhaustively provable within the available time) or would leave a gap
  between what's unit-tested and what actually runs in a real browser.
- **`packages/crypto`'s own package.json/README already scoped it this way going into
  earlier** ("Browser + server crypto helpers" — this build keeps the description
  accurate by implementing the server half for real and leaving a browser-side
  Web Crypto variant as a documented future option, not by pretending both exist).

**Consequence:** the payload is plaintext in the API process's memory for the
duration of one request handler (standard for any server that must validate/transform
a payload before storage) — never logged, never written to any table or event payload
in that form (acceptance criterion 9, grep-verifiable). A future day wanting the
stronger "server never sees plaintext even transiently" property would add a
browser-side Web Crypto sealing path as an ADDITIONAL option alongside this one, not a
replacement — the DB schema (wrapped shares keyed by role, not by "where encryption
happened") does not need to change to support that later.

### 2. Shamir (2-of-3) threshold secret sharing over the DEK, not dual-KEK wrapping

The earlier brief offered two options for acceptance criterion 3: Shamir t-of-n secret
sharing (marked "preferred — makes 'threshold' literally real"), or dual-KEK wrapping.
Shamir was chosen, implemented from scratch over GF(256) field arithmetic
(`packages/crypto/src/gf256.ts`, `shamir.ts`) using **zero external dependencies** —
every primitive (the field arithmetic, the polynomial split/combine) is a
standard, textbook-specified algorithm (Shamir, 1979 — the same one HashiCorp Vault's
`shamir` package and the classic `ssss` tool implement), not a novel or home-rolled
cryptographic primitive; the actual confidentiality/integrity work is 100% Node's
built-in AES-256-GCM (`aes-gcm.ts`). Reasons for Shamir over dual-KEK:

- **Information-theoretic, not just computationally-hard, secrecy for a single share.**
  A dual-KEK scheme's security rests on "you don't have the second key" — an assumption
  that is only as strong as key-management discipline. A single Shamir share (below
  threshold) provably reveals **zero** information about the DEK regardless of
  computational power, a property proven constructively in `shamir.test.ts` (for every
  one of the 256 possible secret-byte values, there exists a polynomial consistent with
  a single observed share — the share alone doesn't narrow the possibilities at all).
- **Avoiding an external dependency for something this security-sensitive.** A
  well-vetted third-party Shamir package (e.g. an audited npm library) was considered,
  but implementing the algorithm directly — a small, exhaustively-testable, dependency-
  free module — was judged lower-risk than adding a supply-chain dependency for a
  single-day build, especially since correctness here is independently, exhaustively
  verifiable: `gf256.test.ts` cross-checks the field multiplication table against an
  independently-written reference implementation for **all 65,536 byte pairs**, and
  `shamir.test.ts` proves round-tripping across every 2-of-3 subset, sub-threshold
  failure, and the perfect-secrecy property directly.
- **Three named roles, not two.** `SEALER` / `OPERATOR` / `ESCROW`, threshold 2-of-3
  (`packages/crypto/src/envelope.ts`'s `LOCKBOX_SHARE_ROLES`/`LOCKBOX_SHARE_THRESHOLD`).
  Any 2 of the 3 roles' shares reconstruct the DEK; each share is ADDITIONALLY wrapped
  (AES-256-GCM again) under its own role-specific KEK before being persisted — so
  acceptance criterion 2's "the DEK is wrapped, never persisted in plaintext" is
  satisfied at the storage layer independently of the Shamir split itself (defense in
  depth: even a raw DB dump yields only wrapped, role-scoped ciphertext blobs, not raw
  shares — an attacker needs BOTH ≥2 valid KEKs AND ≥2 corresponding wrapped shares).
  A single fixed dual-KEK pair was considered and rejected as materially weaker: it
  would make "threshold" a binary fact (both-or-nothing) rather than genuinely
  `n`-choose-`t` (any pair among 3), and would not naturally accommodate the sealer's
  own share existing at all — which matters because ADR-0001's model needs the
  sealer's cooperation to be POSSIBLE (a valid release combination) without being
  REQUIRED (the escrowed path, operator+escrow, works without it).

**Why these three roles, specifically:** `SEALER` represents the org that sealed the
submission (its share is what withdraw destroys — see acceptance criterion 6 below).
`OPERATOR` and `ESCROW` are both platform-custodied roles; in this MVP's single-process
deployment (per the spec's own explicit deferral: "Production threshold key escrow
beyond the selected MVP custody mode" is out of scope), both roles' KEKs are read from
the same `apps/api` process's config — the real security boundary in THIS deployment is
therefore the Shamir split itself (2 distinct shares required, not 1) plus
application-layer authorization (`packages/authz`'s `lockbox.release` action, gated to
operator personas), not yet genuinely-separated key custody per role. That upgrade
(each role's KEK held by a physically/organizationally distinct party or KMS principal)
is additive to this data model, not a rewrite — flagged here so it's a conscious,
visible gap rather than an implied-but-untrue stronger claim.

**Release in practice** combines `OPERATOR` + `ESCROW` shares — no fresh cooperation
from the sealer is required, matching D1's core framing ("TOL... can release"). The
brief's own illustrative example ("release requires the threshold, e.g. sealer +
operator") is also fully supported and tested (`envelope.test.ts` proves ALL THREE
pairwise combinations reconstruct identically) — a future cooperative-release workflow
that collects the sealer's explicit consent as one of the two shares is a pure addition
to `apps/api`'s service layer, not a change to `packages/crypto`.

### 3. HMAC-SHA256 receipts, not Ed25519

Node's `crypto` module supports both. HMAC-SHA256 was chosen because the receipt is a
**single-issuer** signature — the platform signs at seal time, and the platform (or
anyone the platform explicitly shares the HMAC key with for verification, e.g. an
auditor tool) verifies. Ed25519 asymmetric signing earns its complexity when an
INDEPENDENT third party needs to verify a signature without ever holding a secret the
issuer also holds (e.g. a publicly-verifiable, non-repudiable claim) — not needed for
this MVP's receipt, which functions as tamper-evident proof-of-existence within the
platform's own trust boundary, not a public cryptographic attestation. Revisit if a
future requirement needs externally, independently verifiable receipts (e.g. for a
regulator or counterparty who must verify without trusting the platform's own API).

### 4. Canonical encoding for the signed payload

`receipt.ts`'s `canonicalJson` recursively sorts object keys before signing, so
verification can't be defeated by object-key reordering and two different logical
payloads can never canonicalize to the same string. `undefined` values map explicitly
to the JSON `null` token (a deliberate, tested choice — see the project history's
review triage for the review finding this closed).

## Consequences

- `packages/crypto` has **zero runtime dependencies** — every primitive (AES-256-GCM,
  HMAC-SHA256, SHA-256, CSPRNG) comes from Node's built-in `crypto` module; the Shamir
  and GF(256) modules are original, from-scratch, exhaustively-tested implementations
  of standard algorithms, not external packages. This matches `packages/domain`'s and
  `packages/authz`'s existing "zero runtime dependencies" discipline in this monorepo.
- Keys (3 role KEKs + 1 receipt HMAC key, each 32 bytes/64 hex chars) are read from
  `packages/config`'s typed env loader and converted to `Buffer`s via
  `packages/crypto/src/keys.ts`'s `parseKeyHex` — never hardcoded, fails loud (throws
  `MissingKeyMaterialError`) if missing or malformed, per acceptance criterion 8.
  `keys.ts`'s own doc comment documents this as an explicit KMS/HSM stand-in: production
  would source these from a real KMS (AWS KMS, GCP Cloud KMS, HashiCorp Vault) with
  per-role IAM-scoped access, not a shared process env.
- The Lockbox `status` enum (`packages/domain/src/lockbox-states.ts`) models
  the scope's full canonical state machine (`DRAFT → SEALED → COMMITTED → FROZEN →
  OPENED → MATCH_ELIGIBLE`; `WITHDRAWN`/`DISPUTED` side states, p.5) even though
  the API surface so far only wires the 4 actions the brief names (seal /
  read-receipt / withdraw / release) — matching the same "thin but honest" discipline
  ADR-0008 part 2 established for `Opportunity`/`CapacityProfile`. `release`
  performs the `SEALED → COMMITTED → FROZEN → OPENED` cascade atomically in one
  transaction (same precedent as ADR-0008 part 5's "no separate `deal.open` action" — opening
  a DealRoom is a side effect of `rfq.select_quote`, not its own authorized action);
  `COMMITTED`/`FROZEN`/`DISPUTED`'s own standalone triggering actions (a general-purpose
  commit/reveal batch workflow, the spec) are modeled in the domain layer for
  completeness but have no API endpoint yet — flagged in the build log for
  a future pass to pick up P9's remaining richness.
- Every Lockbox mutation's `AuditEvent`/`DomainEvent` payload carries `ciphertextHash`
  (sha256 hex) only — never `payload`, `plaintext`, `dek`, or `shares` fields. This is
  grep-verifiable (acceptance criterion 9) and checked directly in
  `apps/api`'s integration tests, not just asserted here.
- Gate affected: **P9 — Lockbox** (`Ciphertext/receipt/withdraw/release evidence`) —
  this ADR documents the mechanism P9's DONE status depends on; see
  the test-evidence record for p9-lockbox for the actual evidence. Also touches **P16 — Audit**
  (every lockbox action writes both an `AuditEvent` and a `DomainEvent`) and **P3 —
  Data** (Lockbox's tables are the first of the scope's remaining ~60-entity model
  built since earlier).
