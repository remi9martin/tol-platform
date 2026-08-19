// apps/api/src/shared/session.ts
//
// Session token generation/hashing (ADR-0007 — see the build log
// earlier note: session-cookie auth against seeded users, magic-link/Google
// OAuth deferred). The raw token lives ONLY in the cookie; the DB
// (Session.tokenHash, packages/db) stores an HMAC of it, so a database
// read alone can never yield a token usable to forge a session (scope
// p.27: "Session cookies are HttpOnly, Secure, SameSite appropriate").

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig } from "@tol/config";

const SESSION_COOKIE_NAME = "tol_session";
const CSRF_COOKIE_NAME = "tol_csrf";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h — short-lived on purpose for earlier; refresh/remember-me is a later-day concern.

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashSessionToken(rawToken: string): string {
  return createHmac("sha256", getConfig().sessionSecret).update(rawToken).digest("hex");
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Constant-time comparison for the CSRF double-submit check — a plain
 * `===` on secret-adjacent values is a timing side-channel in principle,
 * and the fix costs nothing.
 */
export function csrfTokensMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function sessionExpiryFromNow(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}

export const SESSION_COOKIE = {
  name: SESSION_COOKIE_NAME,
  options(secure: boolean) {
    return {
      httpOnly: true,
      secure,
      sameSite: "lax" as const,
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    };
  },
};

export const CSRF_COOKIE = {
  name: CSRF_COOKIE_NAME,
  options(secure: boolean) {
    return {
      httpOnly: false, // apps/web's client JS must be able to read this to echo it back in the X-CSRF-Token header (double-submit pattern).
      secure,
      sameSite: "lax" as const,
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    };
  },
};
