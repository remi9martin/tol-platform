"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SessionResponse } from "@tol/contracts";
import { apiClient, ApiError } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";

/**
 * Real replacement for the prototype's OrgSwitcher (which mutated a
 * client-side React Context — "viewing as", no server boundary at all).
 * This one calls POST /auth/switch-org through apps/api, which validates
 * the target org against a real ACTIVE OrganizationMembership row before
 * updating the session (apps/api/src/modules/auth/service.ts
 * switchOrg()) — switching is a real, authz-checked, audited action, not
 * a local state flip.
 */
export function OrgSwitcher({ session }: { session: SessionResponse }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (session.memberships.length === 0) {
    return <span className="mono-label">No organizations</span>;
  }

  return (
    <label className="flex items-center gap-2">
      <span className="mono-label hidden sm:inline">Acting as</span>
      <select
        value={session.activeOrganizationId ?? ""}
        disabled={isPending}
        onChange={(e) => {
          const organizationId = e.target.value;
          setError(null);
          const csrfToken = readCsrfTokenFromCookie();
          if (!csrfToken) {
            setError("Session expired — please sign in again.");
            return;
          }
          startTransition(async () => {
            try {
              await apiClient.switchOrg({ organizationId }, csrfToken);
              router.refresh();
            } catch (err) {
              setError(err instanceof ApiError ? err.problem.message : "Failed to switch organization.");
            }
          });
        }}
        aria-label="Switch active organization"
        className="max-w-[150px] truncate rounded-md border border-edge bg-panel px-2.5 py-1.5 text-xs text-ink transition-colors focus:border-red focus:outline-none disabled:opacity-60 sm:max-w-[220px] sm:text-[13px]"
      >
        {session.memberships.map((m) => (
          <option key={m.membershipId} value={m.organizationId}>
            {m.organizationDisplayName} — {m.role}
          </option>
        ))}
      </select>
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
