// apps/web/lib/session.ts — SERVER-SIDE session resolution. Reads the
// incoming request's cookies (next/headers) and forwards them to
// apps/api's GET /auth/session — this file never verifies a session
// itself (the spec: apps/web renders and calls contracts, it does not
// reimplement access control). The (app) route group's layout.tsx is the
// only caller that treats a null return as "redirect to sign-in".

import { cookies } from "next/headers";
import { apiClient, ApiError } from "./api-client";
import type { SessionResponse } from "@tol/contracts";

export async function getServerSession(): Promise<SessionResponse | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  try {
    return await apiClient.getSession({ cookieHeader });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** The CSRF cookie is deliberately non-HttpOnly (double-submit pattern) — server components can read it the same way client components do, for building server-rendered forms that still need to submit a matching header. */
export async function getServerCsrfToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get("tol_csrf")?.value;
}
