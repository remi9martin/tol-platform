"use client";

import { useState, type ReactNode } from "react";
import type { SessionResponse } from "@tol/contracts";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * Ported look from ../../../the prototype repo/components/shell/AppShell.tsx
 * (DISCREPANCY_REPORT.md §7 reuse guidance) — same responsive-drawer
 * structure, but wired to a REAL `session` prop (fetched server-side via
 * lib/session.ts against apps/api's actual auth) instead of the
 * prototype's client-only OrgSwitcherProvider fake "viewing as" context.
 */
export function AppShell({ children, session }: { children: ReactNode; session: SessionResponse }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="tol-ground min-h-screen">
      <TopBar navOpen={navOpen} onToggleNav={() => setNavOpen((v) => !v)} session={session} />
      <div className="mx-auto flex max-w-[1600px]">
        <Sidebar mobileOpen={navOpen} onNavigate={() => setNavOpen(false)} session={session} />
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
