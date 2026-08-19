import type { Metadata } from "next";
import { getServerSession } from "@/lib/session";
import { SealSubmissionForm } from "@/components/lockbox/SealSubmissionForm";

export const metadata: Metadata = { title: "Seal a Lockbox — TOL" };

export default async function NewLockboxPage() {
  const session = await getServerSession();
  if (!session) throw new Error("NewLockboxPage rendered without a session — AppLayout's guard should prevent this.");

  const sealerOrgName =
    session.memberships.find((m) => m.organizationId === session.activeOrganizationId)?.organizationDisplayName ??
    "your organization";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <div className="mono-label mb-2">P9 · Lockbox</div>
        <h1 className="text-2xl font-semibold text-ink">Seal a relationship</h1>
        <p className="mt-1 text-sm text-ink-2">
          Real AES-256-GCM encryption runs the instant you submit — see the panel below for exactly
          what stays public and what gets encrypted.
        </p>
      </div>
      <SealSubmissionForm sealerOrgName={sealerOrgName} />
    </div>
  );
}
