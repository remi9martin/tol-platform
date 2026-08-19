import type { Metadata } from "next";
import "./globals.css";

// "TOL — Trust Online" is a WORKING NAME ONLY (ADR-0003) —
// trademark/domain clearance required before any public/investor-facing
// use. Kept through earlier phases so nothing blocks on naming.
export const metadata: Metadata = {
  title: "TOL — Trust Online",
  description: "Institutional marketplace platform: visible market, private deal. Working name — see ADR-0003.",
};

// Deliberately minimal — the (public)/(auth)/(app) route groups (p.8)
// each own their own chrome. AppShell (TopBar/Sidebar) wraps ONLY the
// (app) group's layout, not this root one, since the public landing page
// and sign-in screen must not show authenticated-app navigation.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="tol-ground">{children}</body>
    </html>
  );
}
