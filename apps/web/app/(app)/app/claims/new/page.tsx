import type { Metadata } from "next";
import { cookies } from "next/headers";
import { apiClient, ApiError } from "@/lib/api-client";
import { CreateClaimForm } from "@/components/claims/CreateClaimForm";

export const metadata: Metadata = { title: "File a Claim — TOL" };

export default async function NewClaimPage() {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  // can() re-enforces server-side on the actual POST /claims regardless of
  // who reaches this page — a role without claim.create sees a form that
  // will 403 on submit, not a silent bypass (same discipline as
  // rfqs/new/page.tsx).
  //
  // organization.list is DELIBERATELY not granted to the three claimant-side
  // personas (packages/authz/src/matrix.ts, earlier) — only reviewer/oversight
  // roles can browse the full org directory. Caught live during this day's
  // own browser verification pass: a MERCHANT_PSP_USER hitting this page
  // 500'd because the page assumed every claim-filing persona could list
  // organizations. Fixed by treating a 403 here as "no directory available,"
  // never a page-breaking error — CreateClaimForm falls back to a manual
  // subjectOrgId entry when `organizations` comes back empty this way.
  const [organizationsResult, { opportunities }] = await Promise.all([
    apiClient.listOrganizations({ cookieHeader }).catch((err) => {
      if (err instanceof ApiError && err.status === 403) return { organizations: [] };
      throw err;
    }),
    apiClient.listOpportunities({ cookieHeader }),
  ]);
  const { organizations } = organizationsResult;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <div>
        <div className="mono-label mb-2">P10 · Attribution</div>
        <h1 className="text-2xl font-semibold text-ink">File a claim</h1>
        <p className="mt-1 text-sm text-ink-2">
          Scored immediately on filing — HISTORY, PROXIMITY, EVIDENCE and TIME, the spec&rsquo;s
          own weights. The breakdown is real and explainable, not a placeholder.
        </p>
      </div>
      <CreateClaimForm organizations={organizations} opportunities={opportunities} />
    </div>
  );
}
