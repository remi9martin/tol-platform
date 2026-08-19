"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { SessionResponse } from "@tol/contracts";
import { apiClient } from "@/lib/api-client";
import { readCsrfTokenFromCookie } from "@/lib/csrf-client";
import { OrgSwitcher } from "./OrgSwitcher";

export function TopBar({
  navOpen,
  onToggleNav,
  session,
}: {
  navOpen: boolean;
  onToggleNav: () => void;
  session: SessionResponse;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleSignOut() {
    const csrfToken = readCsrfTokenFromCookie();
    startTransition(async () => {
      if (csrfToken) {
        await apiClient.logout(csrfToken).catch(() => {
          /* best-effort: even if the network call fails, redirect to sign-in below still gets the user out of the stale UI */
        });
      }
      router.push("/sign-in");
      router.refresh();
    });
  }

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-edge bg-ground/95 backdrop-blur">
      <div className="mx-auto flex h-full max-w-[1600px] items-center gap-3 px-4 md:px-6">
        <button
          type="button"
          onClick={onToggleNav}
          aria-label="Toggle navigation"
          aria-expanded={navOpen}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge text-ink-2 md:hidden"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
          </svg>
        </button>

        <Link
          href="/app"
          className="flex shrink-0 items-baseline gap-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink"
        >
          <b className="font-bold">TOL</b>
          <span className="text-red">—</span>
          <span className="hidden sm:inline">Trust Online</span>
        </Link>

        <span className="mono-label hidden truncate lg:inline">Institutional Marketplace</span>

        <div className="ml-auto flex items-center gap-3">
          <span className="chip chip-neutral hidden sm:inline-flex">{session.user.email}</span>
          <OrgSwitcher session={session} />
          <button type="button" onClick={handleSignOut} disabled={isPending} className="btn btn-ghost text-xs">
            {isPending ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
    </header>
  );
}
