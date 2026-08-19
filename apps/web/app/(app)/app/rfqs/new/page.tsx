import type { Metadata } from "next";
import { cookies } from "next/headers";
import { apiClient } from "@/lib/api-client";
import { CreateRfqForm } from "@/components/rfq/CreateRfqForm";

export const metadata: Metadata = { title: "New RFQ — TOL" };

export default async function NewRfqPage() {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  // can() re-enforces server-side on the actual POST /rfqs regardless of
  // who reaches this page — a MERCHANT_PSP_USER navigating here directly
  // sees a form that will 403 on submit, not a silent bypass.
  const [{ opportunities }, { capacityProfiles }] = await Promise.all([
    apiClient.listOpportunities({ cookieHeader }),
    apiClient.listCapacityProfiles({ cookieHeader }),
  ]);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">New RFQ</h1>
        <p className="mt-1 text-sm text-ink-2">Send a versioned disclosure packet to one or more invited providers.</p>
      </div>
      <CreateRfqForm opportunities={opportunities} capacityProfiles={capacityProfiles} />
    </div>
  );
}
