// packages/crypto/src/keys.ts
//
// KMS stand-in (acceptance criterion 8). In production, every Lockbox KEK
// and the receipt-signing key would live in a real KMS/HSM (AWS KMS, GCP
// Cloud KMS, HashiCorp Vault) and never touch application process memory
// as raw bytes except transiently inside that KMS's own unwrap call. This
// file is the explicitly-documented stand-in for that: apps/api's lockbox
// module reads raw hex strings from @tol/config's typed env loader
// (packages/config/src/env.ts's `lockboxKekSealer`/`lockboxKekOperator`/
// `lockboxKekEscrow`/`lockboxReceiptHmacKey`) and converts them to Buffers
// here, once, at service construction — never hardcoded, fails loud (see
// MissingKeyMaterialError) if missing or malformed rather than silently
// falling back to a weaker default.
//
// This package stays dependency-free on @tol/config itself (parseKeyHex
// takes a plain string, not a config object) so @tol/crypto remains pure
// and independently testable — the wiring from env var to this function
// lives in apps/api, one layer up.

import { MissingKeyMaterialError } from "./errors.js";

const KEY_HEX_LENGTH = 64; // 32 bytes, hex-encoded

/**
 * Parses a 64-hex-char (32-byte) key string — the format required for
 * every Lockbox KEK and the receipt HMAC key. `label` is used only in the
 * thrown error's message (e.g. `"LOCKBOX_KEK_SEALER"`) so a
 * misconfiguration is diagnosable without the raw value ever appearing in
 * an error message, log line, or error tracker.
 */
export function parseKeyHex(hex: string | undefined, label: string): Buffer {
  if (!hex) {
    throw new MissingKeyMaterialError(
      `${label} is missing — required 32-byte key material (${KEY_HEX_LENGTH} hex chars) was not found in config`,
    );
  }
  // Trimmed before validation — .env files routinely pick up a trailing
  // newline/space from copy-paste or an editor's "insert final newline"
  // setting; rejecting an otherwise-correct 64-char key over incidental
  // whitespace is a real footgun (a human reads "malformed", assumes the
  // key itself is wrong, and starts second-guessing the actual secret)
  // for zero security benefit — whitespace was never part of the key
  // space this format accepts.
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new MissingKeyMaterialError(
      `${label} is malformed — expected exactly ${KEY_HEX_LENGTH} hex characters (32 bytes), got ${trimmed.length} character(s)`,
    );
  }
  return Buffer.from(trimmed, "hex");
}
