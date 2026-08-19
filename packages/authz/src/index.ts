// packages/authz — public surface. Consumers import ONLY from here via
// the @tol/authz workspace alias, never a deep path (the spec).

export {
  PERSONA_ROLES,
  DISCLOSURE_CLASSES,
  PERSONA_LABELS,
  isPersonaRole,
  isDisclosureClass,
  disclosureRank,
} from "./roles.js";
export type { PersonaRole, DisclosureClass } from "./roles.js";

export { ACTIONS } from "./actions.js";
export type { Action, Actor, Resource, AuthContext, AuthDecision } from "./actions.js";

export { AUTHORITY_MATRIX } from "./matrix.js";
export type { RoleGrant } from "./matrix.js";

export { can, canBool } from "./can.js";

export { fieldPolicy, isFieldVisible, redactFields } from "./field-policy.js";
export type { FieldPolicyResult } from "./field-policy.js";
