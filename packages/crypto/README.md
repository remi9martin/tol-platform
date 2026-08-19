# packages/crypto — Lockbox Crypto Core

Real cryptography for the Lockbox keystone (P9). Zero runtime dependencies —
every primitive comes from Node's built-in `crypto` module. Pure, zero-DB;
`apps/api`'s lockbox module is the only consumer.

Serves gate(s): P9 Lockbox.

## What's real here

- **AES-256-GCM** (`aes-gcm.ts`) — authenticated encryption via
  `node:crypto`'s `createCipheriv`/`createDecipheriv`. A fresh random
  96-bit IV every call, never reused under the same key. Flipping any
  ciphertext or auth-tag byte makes decryption throw.
- **Envelope encryption** (`envelope.ts`) — a random per-lockbox 256-bit
  Data Encryption Key (DEK) encrypts the payload. The DEK is never
  persisted or logged in plaintext — only its `Shamir` shares, each
  individually wrapped (AES-256-GCM again) under a role-specific key, are
  meant to be persisted.
- **Shamir (2-of-3) threshold secret sharing** (`shamir.ts`, over the
  GF(256) field arithmetic in `gf256.ts`) — the DEK is split across
  `SEALER` / `OPERATOR` / `ESCROW` roles. No single stored share (or its
  wrapping key) can decrypt a sealed payload alone; any 2 of the 3
  reconstruct it exactly. This is what makes ADR-0001's
  "escrowed/threshold release" model literally real, not a policy promise
  layered on top of one key.
- **Signed receipts** (`receipt.ts`) — HMAC-SHA256 over
  `{lockboxId, ciphertextHash, sealerOrgId, sealedAt, state}`,
  independently verifiable, constant-time comparison. An edited or forged
  receipt fails verification.
- **KMS stand-in** (`keys.ts`) — `parseKeyHex()` converts the hex key
  material `@tol/config`'s typed env loader supplies into `Buffer`s. In
  production, this is where a real KMS/HSM client would sit instead
  (see `docs/adr/0009-lockbox-crypto.md`); keys never have a hardcoded
  fallback and fail loud if missing/malformed.

Full design record, threshold-model rationale, and the Shamir-vs-dual-KEK /
HMAC-vs-Ed25519 tradeoffs: ADR-0009 and
`docs/adr/0009-lockbox-crypto.md`.

## Import boundary

Consumers import only from this package's public `src/index.ts` via the
`@tol/crypto` workspace alias. Deep imports into individual source files
(e.g. `@tol/crypto/src/shamir.js`) are forbidden (the spec) even though
they happen to be reachable — `index.ts` re-exports everything a real
caller needs.

## Test coverage

`gf256.test.ts` exhaustively cross-checks the field multiplication table
against an independent reference implementation for all 65,536 byte
pairs. `shamir.test.ts` proves the threshold property directly (every
2-of-3 subset reconstructs; sub-threshold combinations produce wrong
output; a single share is proven consistent with all 256 possible secret
values). `aes-gcm.test.ts` proves IV uniqueness across 10,000 real
encryptions and tamper-evidence by flipping every ciphertext/auth-tag
byte. `envelope.test.ts` exercises the full seal → release path end to
end, including tamper-evidence and AAD-binding through the real public
API. `receipt.test.ts` proves both directions of signature
verification. Run `pnpm --filter @tol/crypto test`.
