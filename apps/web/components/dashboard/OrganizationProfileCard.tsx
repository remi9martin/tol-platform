import type { OrganizationDTO } from "@tol/contracts";

/**
 * Renders exactly the fields present on the DTO — never assumes a field
 * exists. Fields absent because packages/authz's fieldPolicy() redacted
 * them (e.g. registrationId for a cross-org, non-privileged viewer) are
 * genuinely omitted from the response object, not sent as null — the UI
 * reflects that by simply not rendering the row, which is the visible
 * proof this screen doubles as: field-level disclosure is a REAL
 * property of the API response, not a client-side display choice.
 */
export function OrganizationProfileCard({ organization }: { organization: OrganizationDTO | null }) {
  if (!organization) {
    return (
      <div className="panel p-5">
        <h2 className="mono-label mb-3">Organization Profile</h2>
        <p className="text-sm text-ink-3">No active organization selected.</p>
      </div>
    );
  }

  const rows: Array<[string, string | undefined]> = [
    ["Legal name", organization.legalName],
    ["Display name", organization.displayName],
    ["Entity type", organization.entityType],
    ["Country", organization.country],
    ["Registration ID", organization.registrationId],
    ["Website", organization.website],
    ["Verification", organization.verificationStatus],
  ];

  return (
    <div className="panel p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="mono-label">Organization Profile</h2>
        <span className="chip chip-neutral">{organization.privacyClass}</span>
      </div>
      <dl className="divide-y divide-edge">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 py-2 text-sm">
            <dt className="text-ink-3">{label}</dt>
            <dd className="truncate text-right text-ink">
              {value ?? <span className="text-ink-3 italic">restricted</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
