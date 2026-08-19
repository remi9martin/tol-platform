"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SessionResponse } from "@tol/contracts";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  href: string;
  match: (pathname: string) => boolean;
}

/**
 * earlier shipped just the authenticated dashboard as a real route; earlier
 * adds RFQ Workspace (P13) and Deal Room (P14) — both the spec routes,
 * now real (`/app/rfqs`, deal rooms are reached via an RFQ's own
 * "select quote" action rather than a standalone "/app/deals" index this
 * pass, matching how a deal room only ever comes into existence as the
 * effect of a quote selection, never a cold-start destination — see
 * ADR-0008). earlier adds Lockbox (P9, `/app/lockbox`) — moved out
 * of the "later" roadmap list below, now a real route. earlier adds
 * Attribution Claims (P10, `/app/claims` — the spec's own route name
 * verbatim). earlier adds Marketplace (P5, `/app/market`) and Passport
 * (P6, `/app/passport/[orgId]`, keyed to the signed-in actor's OWN
 * active org — session.activeOrganizationId, never a hardcoded/example
 * id) — both real routes now, moved out of the "later" list below. earlier
 * adds Matches (P11 Eligibility + P12 Ranking, `/app/matches`) — scope
 * p.6 only names the `[opportunityId]` detail route, so `/app/matches`
 * is a light opportunity-picker list page built specifically to give
 * this nav entry somewhere to land (see that page's own header comment);
 * also moved out of the "later" list below. earlier adds Economics (P15,
 * `/app/economics` — the spec's own route name verbatim) — same
 * light-picker-then-detail shape as Matches (that page's own header
 * comment). The remaining the spec nav groups (Supply, Demand,
 * Evidence) stay non-clickable "later" labels — their entities don't
 * exist yet, later days' scope.
 */
function buildNavItems(session: SessionResponse): NavItem[] {
  const items: NavItem[] = [
    { label: "Dashboard", href: "/app", match: (p) => p === "/app" },
    { label: "Marketplace", href: "/app/market", match: (p) => p.startsWith("/app/market") },
  ];
  if (session.activeOrganizationId) {
    const orgId = session.activeOrganizationId;
    items.push({ label: "Passport", href: `/app/passport/${orgId}`, match: (p) => p.startsWith("/app/passport") });
  }
  items.push(
    { label: "RFQ Workspace", href: "/app/rfqs", match: (p) => p.startsWith("/app/rfqs") },
    { label: "Lockbox", href: "/app/lockbox", match: (p) => p.startsWith("/app/lockbox") },
    { label: "Attribution Claims", href: "/app/claims", match: (p) => p.startsWith("/app/claims") },
    { label: "Matches", href: "/app/matches", match: (p) => p.startsWith("/app/matches") },
    { label: "Economics", href: "/app/economics", match: (p) => p.startsWith("/app/economics") },
  );
  return items;
}

const FUTURE_LABELS = ["Supply", "Demand", "Evidence"];

export function Sidebar({
  mobileOpen,
  onNavigate,
  session,
}: {
  mobileOpen: boolean;
  onNavigate: () => void;
  session: SessionResponse;
}) {
  const pathname = usePathname();
  const navItems = buildNavItems(session);

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onNavigate}
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
        />
      )}
      <nav
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-72 shrink-0 overflow-y-auto border-r border-edge bg-ground px-4 py-5 transition-transform duration-200 md:sticky md:top-14 md:z-0 md:h-[calc(100vh-56px)] md:w-64 md:translate-x-0 md:border-r md:bg-transparent md:px-3 md:py-6",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="mb-6">
          <div className="mono-label mb-2 flex items-center gap-2 px-2">
            <span className="text-red">01</span>
            <span>Command</span>
          </div>
          <ul className="space-y-0.5">
            {navItems.map((item) => {
              const active = item.match(pathname ?? "");
              return (
                <li key={item.label}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2.5 py-2 text-[13.5px] leading-tight transition-colors",
                      active
                        ? "bg-[rgba(255,36,54,0.12)] text-ink"
                        : "text-ink-2 hover:bg-[rgba(255,80,80,0.06)] hover:text-ink",
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", active ? "bg-red" : "bg-edge-2")} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="mb-6">
          <div className="mono-label mb-2 flex items-center gap-2 px-2">
            <span className="text-red">—</span>
            <span>Roadmap</span>
          </div>
          <ul className="space-y-0.5">
            {FUTURE_LABELS.map((label) => (
              <li key={label}>
                <span className="flex items-center justify-between gap-2 rounded-md px-2.5 py-2 text-[13.5px] leading-tight text-ink-3">
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-edge-2" />
                    {label}
                  </span>
                  <span className="mono-label shrink-0 rounded border border-edge px-1.5 py-0.5 text-[9px]">
                    later
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-8 rounded-lg border border-dashed border-edge-2 px-3 py-3">
          <p className="text-[12px] leading-relaxed text-ink-3">
            earlier build: RFQ + Deal Room live. Signed in as{" "}
            <span className="text-ink-2">{session.activeRole ?? "no active role"}</span> at{" "}
            <span className="text-ink-2">
              {session.memberships.find((m) => m.organizationId === session.activeOrganizationId)
                ?.organizationDisplayName ?? "no organization"}
            </span>
            .
          </p>
        </div>
      </nav>
    </>
  );
}
