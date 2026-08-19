// apps/web/lib/csrf-client.ts — client-side CSRF cookie read. Safe by
// design: the tol_csrf cookie is deliberately non-HttpOnly specifically
// so this can read it (double-submit pattern, see
// apps/api/src/shared/session.ts's CSRF_COOKIE comment) — no secret is
// exposed by this file that isn't already meant to be readable by our
// own origin's JS.
"use client";

export function readCsrfTokenFromCookie(): string | undefined {
  const match = document.cookie.match(/(?:^|;\s*)tol_csrf=([^;]+)/);
  return match?.[1];
}
