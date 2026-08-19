// apps/web/proxy.ts
//
// Next.js 16 renamed the middleware.ts file convention to proxy.ts (the
// exported function is now named `proxy`, not `middleware`) — this file
// was built as middleware.ts, hit the framework's own deprecation
// warning on first build, and was renamed immediately rather than
// shipping fresh earlier code on a convention the framework itself flags
// as deprecated. See https://nextjs.org/docs/messages/middleware-to-proxy.
//
// UX-ONLY fast path — checks for the mere PRESENCE of the tol_session
// cookie, not its validity (this layer can't call apps/api without
// adding real latency to every request, and re-verifying here would
// still not be authoritative — see (app)/layout.tsx's comment). This
// exists purely so an obviously-signed-out visitor hitting /app gets
// redirected before a server render even starts, instead of after.
//
// The REAL security boundary is apps/api's auth plugin + authz.can() on
// every route (the spec: apps/web never reimplements access control) —
// (app)/layout.tsx does the actual (still-not-authoritative-on-its-own)
// session check by calling GET /auth/session; this file is one layer
// earlier than that, nothing more.

import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const hasSessionCookie = request.cookies.has("tol_session");
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/app") && !hasSessionCookie) {
    const signInUrl = new URL("/sign-in", request.url);
    return NextResponse.redirect(signInUrl);
  }

  if (pathname === "/sign-in" && hasSessionCookie) {
    return NextResponse.redirect(new URL("/app", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*", "/sign-in"],
};
