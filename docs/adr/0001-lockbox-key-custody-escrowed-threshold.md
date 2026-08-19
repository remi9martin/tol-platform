# ADR-0001: Lockbox key custody is escrowed / threshold release

**Status:** Accepted (custody MODEL — see supersession note below for one superseded implementation detail)
**Date:** 2026-08-18
**Decision owner:** Product (product/legal/trust claim — not an engineering default)

> **PARTIALLY SUPERSEDED BY ADR-0009** (`docs/adr/0009-lockbox-crypto.md`, D9 in
> `DECISIONS.md`). This ADR's core DECISION — escrowed/threshold custody, not
> submitter-retained-only — is still the live, correct, accepted decision and is
> unchanged by this note. What's superseded is narrower: the Consequences section
> below states, as an illustrative sketch, that "a per-submission DEK wraps the
> plaintext client-side (Web Crypto AES-GCM)." **That specific detail is factually
> wrong about the actual build.** ADR-0009 decided, and earlier actually implemented,
> **server-side** encryption (`packages/crypto`, called from `apps/api`'s lockbox
> service, Node's built-in `crypto` module) — never browser Web Crypto. See
> ADR-0009 for the full reasoning (testability, and D1's own custody model not
> needing the "server never sees plaintext" property client-side sealing would
> exist to provide) and the gate table's P9 row for the as-built status.
> This banner exists so a reader of THIS ADR alone never walks away with a wrong
> mental model of where encryption actually runs — read ADR-0009 for the
> mechanism; this ADR still governs the custody/release MODEL.

## Context

The scope offers two Lockbox custody models without picking one:

1. Submitter-retained release key — "TOL cannot decrypt until the submitter performs
   Release."
2. Envelope encryption with threshold/escrowed release for production.

The scope explicitly warns this is a marketing-claim risk, not just an engineering
choice — page 27's "LOCKBOX CLAIM TEST" callout:

> "If operations personnel can retrieve a unilateral master key and decrypt sealed
> submissions, marketing must not claim that TOL is technically unable to open them."

Page 32's deliberately-deferred list also names "Production threshold key escrow beyond
the selected MVP custody mode" — implying the scope itself
expects *some* escrow/threshold shape even at MVP, with the *production-grade* version
of it (e.g. multi-party HSM-backed threshold schemes) deferred, not the concept itself.

## Decision

Lockbox key custody is **escrowed / threshold release**: TOL, or a threshold of defined
parties, can release a sealed submission's key under documented controls (e.g. dual
authorization, audit-logged release event, defined release conditions). This is not
submitter-retained-only custody.

## Consequences

- `packages/crypto` is designed around envelope encryption: a per-submission DEK wraps
  the plaintext ~~client-side (Web Crypto AES-GCM)~~ **[SUPERSEDED BY ADR-0009 — this
  ran server-side (Node `crypto`), never in the browser, in the actual earlier build; the
  line below is preserved verbatim as the ORIGINAL illustrative sketch this ADR started
  from, not the as-built mechanism — see the banner at the top of this file]**, and the
  DEK itself is wrapped again under a `KeyEnvelope` whose unwrap path requires the
  threshold/escrow control, not a single submitter-held secret.
- Every key release is an audited `ReleaseEvent` (the spec) — who released, why, under
  what authorization — feeding gate **P16 Audit**.
- **Marketing/product copy must never claim TOL is technically unable to decrypt sealed
  Lockbox submissions.** The honest claim is "controlled, threshold-gated release with
  full audit trail," not "we cannot see it." This constrains investor decks, the sales
  site, and any Lockbox-related copy — flag any draft that implies unilateral submitter
  control for correction before it ships.
- MVP implements the *mechanism* (envelope encryption + a defined release-authorization
  path); full production-grade multi-party/HSM threshold escrow is deferred per scope
  p.32, consistent with "deliberately deferred" framing there.
- Gate affected: **P9 — Lockbox** (`Ciphertext/receipt/withdraw/release evidence`).
