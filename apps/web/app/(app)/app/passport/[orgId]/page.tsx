import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getServerSession } from "@/lib/session";
import { apiClient, ApiError } from "@/lib/api-client";
import { StatusChip } from "@/components/shared/StatusChip";
import { ReadinessMeter } from "@/components/passport/ReadinessMeter";
import { PassportActions } from "@/components/passport/PassportActions";
import { CreatePassportButton } from "@/components/passport/CreatePassportButton";
import { formatDateTime, shortId } from "@/lib/format";

// Next.js 16: dynamic-route `params` is a Promise.
interface Props {
  params: Promise<{ orgId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgId } = await params;
  return { title: `Passport ${shortId(orgId)} — TOL` };
}

const MAINTAINER_ROLES = new Set(["CONTRIBUTOR_AGENT", "MERCHANT_PSP_USER", "ACQUIRER_PROVIDER_USER", "PLATFORM_OWNER"]);
const VERIFIER_ROLES = new Set(["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "COMPLIANCE_REVIEWER"]);
const CROSS_ORG_READ_ROLES = new Set(["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "PARTNERSHIP_LEAD", "UNDERWRITING_ANALYST", "COMPLIANCE_REVIEWER", "AUDITOR_READONLY"]);

const SECTION_LABELS: Record<string, string> = {
  IDENTITY: "Identity",
  RELATIONSHIP_HISTORY: "Relationship history",
  PROCESSING_METRICS: "Processing metrics",
  RISK: "Risk",
  COMMERCIAL: "Commercial",
  TECHNICAL: "Technical",
};

/** the spec route, verbatim: "/app/passport/[orgId] || TOL Passport || Reusable institutional evidence profile." P6 gate exit condition: "Readiness/provenance/freshness works." */
export default async function PassportPage({ params }: Props) {
  const { orgId } = await params;
  const session = await getServerSession();
  if (!session) throw new Error("PassportPage rendered without a session — AppLayout's guard should prevent this.");

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  const isOwnOrg = session.activeOrganizationId === orgId;
  const canCreate = isOwnOrg && MAINTAINER_ROLES.has(session.activeRole ?? "");

  let detail;
  try {
    detail = await apiClient.getPassportByOrg(orgId, { cookieHeader });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="flex flex-col gap-6">
          <div>
            <div className="mono-label mb-2">P6 · Passport</div>
            <h1 className="text-2xl font-semibold text-ink">No Passport yet</h1>
            <p className="mt-1 max-w-[62ch] text-sm text-ink-2">
              This organization has not started a Passport — the spec&rsquo;s reusable
              institutional evidence graph. {canCreate ? "Create one to begin." : "Only this organization's own members can create it."}
            </p>
          </div>
          {canCreate && <CreatePassportButton />}
        </div>
      );
    }
    if (err instanceof ApiError && err.status === 403) {
      return (
        <div className="panel p-6">
          <p className="field-error">{err.problem.message}</p>
        </div>
      );
    }
    throw err;
  }

  const { passport, facts, evidence, readiness } = detail;
  const canUpdate = session.activeOrganizationId === passport.organizationId && MAINTAINER_ROLES.has(session.activeRole ?? "");
  const canVerify = VERIFIER_ROLES.has(session.activeRole ?? "") && passport.status === "READY";
  const canSeeEvidenceList = canUpdate || CROSS_ORG_READ_ROLES.has(session.activeRole ?? "");

  const factsBySection = new Map<string, typeof facts>();
  for (const fact of facts) {
    const list = factsBySection.get(fact.sectionType) ?? [];
    list.push(fact);
    factsBySection.set(fact.sectionType, list);
  }

  const evidenceOptions = evidence.map((e) => ({ id: e.id, label: `${e.type} — ${e.objectRef}` }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="mono-label mb-2">P6 · Passport</div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-ink">Institutional Passport</h1>
            <StatusChip status={passport.status} />
          </div>
          <p className="mt-1 text-sm text-ink-2">
            Organization {shortId(passport.organizationId)} · updated {formatDateTime(passport.updatedAt)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <ReadinessMeter readiness={readiness} />

          <div className="panel p-5">
            <h2 className="mono-label mb-3">Facts ({facts.length})</h2>
            {facts.length === 0 ? (
              <p className="text-sm text-ink-3">No facts filed yet.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {[...factsBySection.entries()].map(([section, sectionFacts]) => (
                  <div key={section}>
                    <h3 className="mono-label mb-2">{SECTION_LABELS[section] ?? section}</h3>
                    <ul className="flex flex-col gap-2">
                      {sectionFacts.map((f) => (
                        <li key={f.id} className="rounded-md border border-edge px-3 py-2 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-ink">{f.fieldKey}</span>
                            <span className="chip chip-neutral">{f.verification}</span>
                          </div>
                          <p className="mt-1 text-[12px] text-ink-3">
                            {typeof f.normalizedValue === "object" ? JSON.stringify(f.normalizedValue) : String(f.normalizedValue)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>

          {canSeeEvidenceList && (
            <div className="panel p-5">
              <h2 className="mono-label mb-3">Evidence ({evidence.length})</h2>
              {evidence.length === 0 ? (
                <p className="text-sm text-ink-3">No evidence on file.</p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {evidence.map((item) => (
                    <li key={item.id} className="rounded-md border border-edge px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="chip chip-neutral">{item.type}</span>
                        {item.expiresAt && <span className="mono-label">expires {formatDateTime(item.expiresAt)}</span>}
                      </div>
                      <p className="mt-1.5 text-ink-2">{item.objectRef}</p>
                      {item.issuer && <p className="mt-1 text-[11px] text-ink-3">Issuer: {item.issuer}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <PassportActions passportId={passport.id} canUpdate={canUpdate} canVerify={canVerify} evidenceOptions={evidenceOptions} />
        </div>
      </div>
    </div>
  );
}

