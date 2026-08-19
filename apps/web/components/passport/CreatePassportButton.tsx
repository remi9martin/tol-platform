"use client";

// A real client-side mutation, matching every other earlier phases mutation's
// pattern exactly (readCsrfTokenFromCookie + apiClient, never a Server
// Action) — a server-to-server fetch from a Server Action would NOT
// carry the browser's session cookie the way `credentials: "include"`
// does for a browser-initiated fetch, so this must run client-side like
// every other mutation in this codebase.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";

export function CreatePassportButton() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setError(null);
    const token = readCsrfTokenFromCookie();
    if (!token) {
      setError("Session expired — please sign in again.");
      return;
    }
    setBusy(true);
    try {
      const created = await apiClient.createPassport({}, token);
      router.push(`/app/passport/${created.organizationId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Creating the Passport failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" disabled={busy} className="btn btn-go self-start" onClick={create}>
        {busy ? "Creating…" : "+ Create Passport"}
      </button>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
