import type { OrganizationMembership } from "@tol/db";
import type { MembershipDTO } from "@tol/contracts";

export function toMembershipDTO(m: OrganizationMembership): MembershipDTO {
  return {
    id: m.id,
    organizationId: m.organizationId,
    userId: m.userId,
    role: m.role,
    status: m.status,
    invitationSource: m.invitationSource,
    effectiveFrom: m.effectiveFrom.toISOString(),
    effectiveTo: m.effectiveTo ? m.effectiveTo.toISOString() : null,
  };
}
