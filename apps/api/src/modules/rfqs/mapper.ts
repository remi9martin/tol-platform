// apps/api/src/modules/rfqs/mapper.ts
//
// the spec (verbatim): "Providers never see competing quotes or
// merchant's maximum willingness to pay unless an explicit auction model
// is later approved." This is the concrete earlier application of that
// rule — filterQuotesForViewer() is COLLECTION-level redaction (which
// Quote rows appear at all), a different shape from the
// organizations/mapper.ts field-level redactFields() (which fields of
// ONE row appear) — both are real disclosure mechanisms, just operating
// at different granularities for different resources.

import type { Actor } from "@tol/authz";
import type { Organization, Quote, RFQ, RFQRecipient, RFQVersion } from "@tol/db";
import type { QuoteDTO, RFQDTO, RFQRecipientDTO, RFQVersionDTO } from "@tol/contracts";

const CROSS_ORG_RFQ_ROLES = new Set(["PLATFORM_OWNER", "MARKETPLACE_OPERATOR", "COMPLIANCE_REVIEWER", "AUDITOR_READONLY"]);

export function toRfqVersionDTO(version: RFQVersion): RFQVersionDTO {
  return {
    id: version.id,
    rfqId: version.rfqId,
    versionNumber: version.versionNumber,
    packetType: version.packetType,
    disclosureSnapshot: version.disclosureSnapshot as RFQVersionDTO["disclosureSnapshot"],
    changeSummary: version.changeSummary,
    createdAt: version.createdAt.toISOString(),
  };
}

export function toRfqRecipientDTO(recipient: RFQRecipient, providerOrg?: Organization): RFQRecipientDTO {
  return {
    id: recipient.id,
    rfqId: recipient.rfqId,
    providerOrgId: recipient.providerOrgId,
    providerDisplayName: providerOrg?.displayName,
    state: recipient.state,
    acknowledgedAt: recipient.acknowledgedAt ? recipient.acknowledgedAt.toISOString() : null,
    declineReason: recipient.declineReason,
  };
}

export function toQuoteDTO(quote: Quote): QuoteDTO {
  return {
    id: quote.id,
    rfqId: quote.rfqId,
    rfqRecipientId: quote.rfqRecipientId,
    providerOrgId: quote.providerOrgId,
    quoteVersion: quote.quoteVersion,
    currency: quote.currency,
    status: quote.status,
    validUntil: quote.validUntil.toISOString(),
    submittedAt: quote.submittedAt.toISOString(),
    terms: quote.terms as QuoteDTO["terms"],
  };
}

/**
 * `merchantOrgId` is the OWNING org of the RFQ (opportunity.ownerOrgId) —
 * passed explicitly rather than re-derived here, since the mapper has no
 * database access (same "mapper never queries" discipline as the
 * organizations/mapper.ts).
 */
export function filterQuotesForViewer(actor: Actor, merchantOrgId: string, quotes: Quote[]): Quote[] {
  const seesEverything = actor.organizationId === merchantOrgId || (actor.role !== null && CROSS_ORG_RFQ_ROLES.has(actor.role));
  if (seesEverything) return quotes;
  return quotes.filter((q) => q.providerOrgId === actor.organizationId);
}

/**
 * Does NOT take `merchantOrgId`/`actor` — quote VISIBILITY is decided
 * separately by filterQuotesForViewer() above, called by the route
 * BEFORE building `opts.quotes`, so this function stays a pure "shape
 * whatever quotes you already decided are visible" mapper, the same
 * division of labor as every other mapper in this codebase (services
 * decide access/scope, mappers only shape the result).
 */
export function toRfqDTO(
  rfq: RFQ,
  opts: {
    version?: RFQVersion;
    recipients?: RFQRecipient[];
    quotes?: Quote[];
  },
): RFQDTO {
  return {
    id: rfq.id,
    opportunityId: rfq.opportunityId,
    status: rfq.status,
    dueAt: rfq.dueAt.toISOString(),
    currentVersionNumber: rfq.currentVersionNumber,
    currentVersion: opts.version ? toRfqVersionDTO(opts.version) : undefined,
    recipients: opts.recipients ? opts.recipients.map((r) => toRfqRecipientDTO(r)) : undefined,
    quotes: opts.quotes ? opts.quotes.map(toQuoteDTO) : undefined,
    privacyClass: rfq.privacyClass,
  };
}
