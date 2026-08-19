import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient, ApiError } from "@/lib/api-client";
import { StatusChip } from "@/components/shared/StatusChip";
import { LockboxActions } from "@/components/lockbox/LockboxActions";
import { formatDateTime, shortId } from "@/lib/format";

interface Props {
  params: Promise<{ lockboxId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lockboxId } = await params;
  return { title: `Lockbox ${shortId(lockboxId)} — TOL` };
}

/**
 * the spec UI acceptance: "before sealing, user sees what is public
 * metadata vs encrypted payload; after sealing, receipt/hash/status is
 * visible." This is that "after sealing" view — the receipt panel proves
 * existence (independently verifiable via @tol/crypto's verifyReceipt,
 * see apps/api/tests/integration/lockbox.test.ts) without ever showing
 * contents; contents only ever appear via LockboxActions' release flow.
 *
 * `canWithdraw`/`canRelease` mirror packages/authz's matrix (DECISIONS.md
 * D1/D9) at the UI-affordance layer ONLY — apps/api's own can() calls are
 * what actually enforce this; a session that reaches this page without
 * either simply sees neither action, and a direct API call would still
 * 403 regardless of what this page renders.
 */
export default async function LockboxDetailPage({ params }: Props) {
  const { lockboxId } = await params;
  const session = await getServerSession();
  if (!session) throw new Error("LockboxDetailPage rendered without a session — AppLayout's guard should prevent this.");

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  let lockbox;
  try {
    lockbox = await apiClient.getLockbox(lockboxId, { cookieHeader });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      return (
        <div className="panel p-6">
          <p className="field-error">{err.problem.message}</p>
        </div>
      );
    }
    throw err;
  }

  const receipt = await apiClient.getLockboxReceipt(lockboxId, { cookieHeader }).catch(() => null);

  const isSealer = session.activeOrganizationId === lockbox.sealerOrgId;
  const WITHDRAWABLE_STATUSES = new Set(["SEALED", "COMMITTED", "MATCH_ELIGIBLE", "DISPUTED"]);
  const canWithdraw = isSealer && WITHDRAWABLE_STATUSES.has(lockbox.status);

  const RELEASE_ROLES = new Set(["PLATFORM_OWNER", "MARKETPLACE_OPERATOR"]);
  const RELEASABLE_STATUSES = new Set(["SEALED", "COMMITTED", "FROZEN"]);
  const canRelease = session.activeRole !== null && RELEASE_ROLES.has(session.activeRole) && RELEASABLE_STATUSES.has(lockbox.status);

  const { organizations } = canRelease ? await apiClient.listOrganizations({ cookieHeader }) : { organizations: [] };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mono-label mb-2">Lockbox {shortId(lockbox.id)}</div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-ink">{lockbox.metadataSummary ?? lockbox.relationshipType}</h1>
          <StatusChip status={lockbox.status} />
        </div>
        <p className="mt-1 text-xs text-ink-3">
          {isSealer ? "You sealed this Lockbox." : "Sealed by another organization."} Region: {lockbox.region}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="panel p-5">
            <h2 className="mono-label mb-3">Receipt — proof of existence</h2>
            {receipt ? (
              <div className="panel-2 grid grid-cols-1 gap-x-4 gap-y-3 p-4 text-[12.5px] sm:grid-cols-2">
                <Fact label="Ciphertext hash (sha256)" value={receipt.ciphertextHash} mono />
                <Fact label="Version" value={`v${receipt.version}`} mono />
                <Fact label="Sealed" value={formatDateTime(receipt.sealedAt)} />
                <Fact label="Algorithm" value={receipt.algorithm} mono />
                <Fact label="Signature" value={`${receipt.signature.slice(0, 32)}…`} mono />
              </div>
            ) : (
              <p className="text-sm text-ink-3">Receipt not available to this viewer.</p>
            )}
          </div>

          <div className="panel p-5">
            <h2 className="mono-label mb-3">Take action</h2>
            <LockboxActions lockbox={lockbox} organizations={organizations} canWithdraw={canWithdraw} canRelease={canRelease} />
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <div className="panel p-5">
            <h2 className="mono-label mb-3">What&rsquo;s encrypted</h2>
            <p className="text-[12.5px] leading-relaxed text-ink-3">
              This Lockbox&rsquo;s sealed contents (counterparty, evidence, prior deal history) are
              AES-256-GCM ciphertext at rest, split three ways (Shamir 2-of-3 threshold —
              SEALER/OPERATOR/ESCROW). No single stored value can decrypt it alone. Only
              {isSealer ? " you (the sealer) and " : " "}
              the platform operator can trigger release, and release requires a controlled
              condition plus the threshold shares — see ADR-0001/ADR-0009.
            </p>
          </div>

          {lockbox.withdrawnAt && (
            <div className="panel p-5">
              <h2 className="mono-label mb-3">Withdrawn</h2>
              <Fact label="Withdrawn" value={formatDateTime(lockbox.withdrawnAt)} />
              {lockbox.withdrawReason && <p className="mt-2 text-[12.5px] text-ink-3">{lockbox.withdrawReason}</p>}
            </div>
          )}

          {lockbox.releasedAt && (
            <div className="panel p-5">
              <h2 className="mono-label mb-3">Released</h2>
              <div className="flex flex-col gap-2">
                <Fact label="Released" value={formatDateTime(lockbox.releasedAt)} />
                {lockbox.recipientOrgId && <Fact label="Recipient org" value={shortId(lockbox.recipientOrgId)} mono />}
                {lockbox.conditionRef && <Fact label="Condition reference" value={shortId(lockbox.conditionRef)} mono />}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="mono-label mb-0.5">{label}</div>
      <div className={mono ? "truncate font-mono text-[12px] text-ink" : "text-[13px] text-ink"} title={value}>
        {value}
      </div>
    </div>
  );
}
