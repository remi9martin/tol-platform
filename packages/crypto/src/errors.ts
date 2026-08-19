// packages/crypto/src/errors.ts
//
// Typed error classes for @tol/crypto. Every failure mode a caller needs
// to distinguish (tamper detected vs. insufficient shares vs. missing key
// material) gets its own class so apps/api's lockbox service can catch
// exactly what it needs and turn it into the right problem+json status —
// the same discipline packages/domain uses for DomainTransitionError.

export class CryptoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CryptoError";
  }
}

/**
 * AES-GCM auth-tag verification failed — the ciphertext, IV, authTag, or
 * AAD was tampered with, OR the key used to decrypt was wrong (e.g. a DEK
 * reconstructed from fewer than `threshold` valid Shamir shares). This one
 * error class deliberately covers BOTH "someone tampered with the
 * ciphertext" (acceptance criterion 4) and "someone tried to reconstruct
 * the DEK without enough shares" (acceptance criterion 3): GCM's
 * authenticated decryption cannot distinguish "wrong key" from "tampered
 * ciphertext" at the algorithm level, and for this system's threat model
 * it doesn't need to — both cases MUST fail closed the same way, with no
 * plaintext or partial plaintext ever returned.
 */
export class TamperOrWrongKeyError extends CryptoError {
  constructor(context?: string, options?: ErrorOptions) {
    super(
      `AES-GCM authentication failed — ciphertext/IV/authTag mismatch or wrong key${context ? ` (${context})` : ""}`,
      options,
    );
    this.name = "TamperOrWrongKeyError";
  }
}

/**
 * Thrown by Shamir combine()/envelope release() when fewer than 2 shares
 * (or shares with colliding x-coordinates) are supplied — a structural
 * input error, checked BEFORE any cryptographic work runs. Distinct from
 * TamperOrWrongKeyError, which fires downstream once a wrong-but
 * well-formed DEK has already been reconstructed and handed to AES-GCM.
 */
export class InsufficientSharesError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientSharesError";
  }
}

/**
 * Required key material missing or malformed from @tol/config's env
 * loader — fails at first use, loud, never silently falls back to a
 * weaker default (acceptance criterion 8). The error message intentionally
 * includes only the config key's NAME, never the raw value, so a
 * misconfiguration is diagnosable without leaking partial key material
 * into logs/error trackers.
 */
export class MissingKeyMaterialError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = "MissingKeyMaterialError";
  }
}
