import type { SessionResponse } from "@tol/contracts";

export function MembershipList({ session }: { session: SessionResponse }) {
  return (
    <div className="panel p-5">
      <h2 className="mono-label mb-3">Your Memberships</h2>
      {session.memberships.length === 0 ? (
        <p className="text-sm text-ink-3">No organization memberships yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {session.memberships.map((m) => {
            const isActive = m.organizationId === session.activeOrganizationId;
            return (
              <li
                key={m.membershipId}
                className={
                  "flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm " +
                  (isActive ? "border-red/40 bg-[rgba(255,36,54,0.08)]" : "border-edge")
                }
              >
                <div className="min-w-0">
                  <div className="truncate text-ink">{m.organizationDisplayName}</div>
                  <div className="mono-label mt-0.5">{m.role}</div>
                </div>
                <span className={"chip " + (m.status === "ACTIVE" ? "chip-ok" : "chip-neutral")}>{m.status}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
