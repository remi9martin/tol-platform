import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient } from "@/lib/api-client";
import { StatusChip } from "@/components/shared/StatusChip";
import { formatDateTime, shortId } from "@/lib/format";

export const metadata: Metadata = { title: "Lockbox — TOL" };

/**
 * the spec: "/app/lockbox — Lockbox — Sealed deposits, receipts, release
 * state." P9 gate exit condition: "Ciphertext/receipt/withdraw/release
 * evidence." The keystone thesis below is required verbatim by the earlier
 * build brief and is ported directly from the reuse-reference
 * prototype's own LockboxView.tsx, which already carried this exact
 * copy — this build replaces that view's `mockSealHash()` fake with real
 * AES-256-GCM + Shamir threshold cryptography (ADR-0001/ADR-0009)
 * underneath the identical thesis.
 */
export default async function LockboxListPage() {
  const session = await getServerSession();
  if (!session) throw new Error("LockboxListPage rendered without a session — AppLayout's guard should prevent this.");

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  const { lockboxes } = await apiClient.listLockboxes({ cookieHeader });

  // the spec Journey A + packages/authz's matrix: CONTRIBUTOR_AGENT,
  // MERCHANT_PSP_USER, and ACQUIRER_PROVIDER_USER can seal their own
  // relationships; PLATFORM_OWNER can too (broadest authority). The
  // server independently re-enforces via can() regardless of this UI
  // gate — same discipline as rfqs/page.tsx's canCreate.
  const canSeal =
    session.activeRole === "CONTRIBUTOR_AGENT" ||
    session.activeRole === "MERCHANT_PSP_USER" ||
    session.activeRole === "ACQUIRER_PROVIDER_USER" ||
    session.activeRole === "PLATFORM_OWNER";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="mono-label mb-2">P9 · Lockbox</div>
          <h1 className="text-2xl font-semibold text-ink">Lockbox</h1>
          <p className="mt-1 max-w-[62ch] text-sm text-ink-2">
            A sealed container for a relationship — not a transfer of it. The introducer keeps the
            relationship; the network can still put it to work under terms the introducer controls.
          </p>
        </div>
        {canSeal && (
          <Link href="/app/lockbox/new" className="btn btn-go shrink-0">
            + Seal a relationship
          </Link>
        )}
      </div>

      <div className="panel border-[rgba(255,36,54,0.38)] p-6 sm:p-8">
        <p className="font-serif text-[1.25rem] italic leading-snug text-ink sm:text-[1.45rem]">
          &ldquo;Your relationships are already assets. Sealing one does not mean handing it over —
          it means putting it to work.&rdquo;
        </p>
      </div>

      <div className="panel scrollx">
        {lockboxes.length === 0 ? (
          <p className="p-5 text-sm text-ink-3">No Lockboxes yet.</p>
        ) : (
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-edge text-left">
                <th className="mono-label px-4 py-3 font-normal">Type</th>
                <th className="mono-label px-4 py-3 font-normal">Region</th>
                <th className="mono-label px-4 py-3 font-normal">Status</th>
                <th className="mono-label px-4 py-3 font-normal">Sealed</th>
                <th className="mono-label px-4 py-3 font-normal">Ciphertext hash</th>
                <th className="mono-label px-4 py-3 font-normal" />
              </tr>
            </thead>
            <tbody>
              {lockboxes.map((lockbox) => (
                <tr key={lockbox.id} className="border-b border-edge last:border-0 hover:bg-[rgba(255,80,80,0.04)]">
                  <td className="px-4 py-3">
                    <div className="text-ink">{lockbox.metadataSummary ?? lockbox.relationshipType}</div>
                    <div className="mono-label mt-0.5">Lockbox {shortId(lockbox.id)}</div>
                  </td>
                  <td className="px-4 py-3 text-ink-2">{lockbox.region}</td>
                  <td className="px-4 py-3">
                    <StatusChip status={lockbox.status} />
                  </td>
                  <td className="px-4 py-3 text-ink-2">{formatDateTime(lockbox.sealedAt)}</td>
                  <td className="px-4 py-3">
                    <span className="mono-label truncate" title={lockbox.ciphertextHash}>
                      {lockbox.ciphertextHash.slice(0, 16)}…
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/app/lockbox/${lockbox.id}`} className="btn btn-ghost">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
