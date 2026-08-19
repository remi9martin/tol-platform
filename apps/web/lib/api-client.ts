// apps/web/lib/api-client.ts
//
// the spec: "All API calls use typed contracts from @tol/contracts; no
// ad hoc fetch response parsing." Every function here returns a type
// imported from @tol/contracts, not a hand-shaped inline interface —
// apps/web and apps/api share the exact same DTO definitions.
//
// apps/web and apps/api run on different origins in local dev (18300 vs
// 18400) — every fetch needs `credentials: "include"` for the session/
// CSRF cookies to flow, and apps/api's CORS config (this stage) is what
// allows it. This file is the ONLY place that constructs those fetch
// calls; components never call fetch() against the API directly.

import type {
  LoginRequest,
  ProblemDetails,
  SessionResponse,
  OrganizationDTO,
  ListOrganizationsResponse,
  SwitchOrgRequest,
  UpdateOrganizationRequest,
  // ---- earlier: P13 RFQ + P14 Deal Room ----
  OpportunityDTO,
  CreateOpportunityRequest,
  ListOpportunitiesResponse,
  CapacityProfileDTO,
  CreateCapacityProfileRequest,
  ListCapacityProfilesResponse,
  RFQDTO,
  CreateRfqRequest,
  DeclineRfqRequest,
  SubmitQuoteRequest,
  SelectQuoteRequest,
  QuoteDTO,
  RFQRecipientDTO,
  ListRfqsResponse,
  DealRoomDTO,
  ListDealRoomsResponse,
  PostConditionRequest,
  ResolveConditionRequest,
  RecordDecisionRequest,
  DealConditionDTO,
  DealDecisionDTO,
  TimelineResponse,
  // ---- earlier: Lockbox ----
  LockboxDTO,
  ListLockboxesResponse,
  LockboxReceiptDTO,
  SealLockboxRequest,
  WithdrawLockboxRequest,
  ReleaseLockboxRequest,
  ReleaseLockboxResponse,
  // ---- earlier: Attribution ----
  ClaimDTO,
  ClaimDecisionDTO,
  ClaimDetailResponse,
  ClaimDisputeDTO,
  CreateClaimRequest,
  DecideClaimRequest,
  FileClaimDisputeRequest,
  ListClaimsResponse,
  // ---- earlier: Passport (P6) + Marketplace (P5) + VolumeSlice (P7) ----
  PassportDTO,
  PassportDetailResponse,
  ListPassportsResponse,
  CreatePassportRequest,
  UpsertFactRequest,
  FactDTO,
  CreateEvidenceRequest,
  EvidenceDTO,
  VerifyPassportRequest,
  ListMarketplaceCapacityResponse,
  ListMarketplaceOpportunitiesResponse,
  ReplaceVolumeSlicesRequest,
  VolumeSlicesResponse,
  // ---- earlier: Matching (P11 Eligibility + P12 Ranking) ----
  EvaluateMatchesRequest,
  EvaluateMatchesResponse,
  ListMatchesResponse,
  // ---- earlier: Economics (P15) ----
  CreateScheduleRequest,
  ListSchedulesResponse,
  CommissionScheduleDetailDTO,
  RecordRevenueEventRequest,
  RecordRevenueEventResponse,
  ListRevenueEventsResponse,
  LedgerResponse,
  RecordPaymentRequest,
  RecordPaymentResponse,
  AdjustLedgerRequest,
  AdjustLedgerResponse,
} from "@tol/contracts";

function apiBaseUrl(): string {
  const url = process.env["NEXT_PUBLIC_API_URL"];
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_API_URL is not set — apps/web cannot reach apps/api without it (see .env.example).",
    );
  }
  return url;
}

const FALLBACK_PROBLEM = (status: number): ProblemDetails => ({
  code: "unparseable_response",
  message: `The server returned a ${status} response that wasn't valid JSON.`,
  requestId: "unknown",
  retryable: status >= 500,
});

export class ApiError extends Error {
  /** Always populated — see the constructor for how a null/unparseable input is coalesced into a real fallback, so every OTHER call site in this codebase can rely on `err.problem.message` without its own null check. */
  public problem: ProblemDetails;

  constructor(
    public status: number,
    // Accepts null on input because the response body can genuinely be
    // null when it wasn't valid JSON (e.g. a raw infrastructure 502/504
    // HTML page, not apps/api's own problem+json handler) — fixed after
    // review (apps/web this stage) flagged that reading
    // `problem.message` would throw INSIDE this constructor in that
    // case, replacing a meaningful status code with a confusing "Cannot
    // read properties of null" error instead.
    problemInput: ProblemDetails | null,
  ) {
    const problem = problemInput ?? FALLBACK_PROBLEM(status);
    super(problem.message);
    this.name = "ApiError";
    this.problem = problem;
  }
}

/**
 * Shared fetch wrapper. `cookieHeader` is only ever passed from
 * server-side callers (Server Components forwarding the incoming
 * request's cookies via next/headers) — client-side callers rely on the
 * browser attaching cookies automatically via `credentials: "include"`.
 */
async function apiFetch<T>(
  path: string,
  init: RequestInit & { cookieHeader?: string; csrfToken?: string } = {},
): Promise<T> {
  const { cookieHeader, csrfToken, headers, ...rest } = init;
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...rest,
    credentials: "include",
    cache: "no-store",
    headers: {
      // Content-Type: application/json ONLY when there's actually a body
      // — caught live during this stage browser testing: apps/api's Fastify
      // instance correctly rejects a request that claims a JSON
      // content-type but sends zero bytes (FST_ERR_CTP_EMPTY_JSON_BODY),
      // which is exactly what a bodyless call like logout() was sending
      // when this header was set unconditionally. Sign-out failed with a
      // 400 in the real browser even though every server-side test
      // (curl, vitest's .inject()) happened to only ever exercise
      // endpoints that DO send a body, so this never surfaced there.
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body as ProblemDetails);
  }
  return body as T;
}

export const apiClient = {
  login(payload: LoginRequest): Promise<SessionResponse> {
    return apiFetch<SessionResponse>("/auth/login", { method: "POST", body: JSON.stringify(payload) });
  },

  logout(csrfToken: string): Promise<void> {
    return apiFetch<void>("/auth/logout", { method: "POST", csrfToken });
  },

  getSession(opts: { cookieHeader?: string } = {}): Promise<SessionResponse> {
    return apiFetch<SessionResponse>("/auth/session", { cookieHeader: opts.cookieHeader });
  },

  switchOrg(payload: SwitchOrgRequest, csrfToken: string): Promise<SessionResponse> {
    return apiFetch<SessionResponse>("/auth/switch-org", {
      method: "POST",
      body: JSON.stringify(payload),
      csrfToken,
    });
  },

  listOrganizations(opts: { cookieHeader?: string } = {}): Promise<ListOrganizationsResponse> {
    return apiFetch<ListOrganizationsResponse>("/organizations", { cookieHeader: opts.cookieHeader });
  },
  getOrganization(id: string, opts: { cookieHeader?: string } = {}): Promise<OrganizationDTO> {
    return apiFetch<OrganizationDTO>(`/organizations/${id}`, { cookieHeader: opts.cookieHeader });
  },

  updateOrganization(id: string, payload: UpdateOrganizationRequest, csrfToken: string): Promise<OrganizationDTO> {
    return apiFetch<OrganizationDTO>(`/organizations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
      csrfToken,
    });
  },

  // ================================================================
  // earlier: P13 RFQ + P14 Deal Room
  // ================================================================

  listOpportunities(opts: { cookieHeader?: string } = {}): Promise<ListOpportunitiesResponse> {
    return apiFetch<ListOpportunitiesResponse>("/opportunities", { cookieHeader: opts.cookieHeader });
  },
  getOpportunity(id: string, opts: { cookieHeader?: string } = {}): Promise<OpportunityDTO> {
    return apiFetch<OpportunityDTO>(`/opportunities/${id}`, { cookieHeader: opts.cookieHeader });
  },
  createOpportunity(payload: CreateOpportunityRequest, csrfToken: string): Promise<OpportunityDTO> {
    return apiFetch<OpportunityDTO>("/opportunities", { method: "POST", body: JSON.stringify(payload), csrfToken });
  },

  listCapacityProfiles(opts: { cookieHeader?: string } = {}): Promise<ListCapacityProfilesResponse> {
    return apiFetch<ListCapacityProfilesResponse>("/capacity-profiles", { cookieHeader: opts.cookieHeader });
  },
  createCapacityProfile(payload: CreateCapacityProfileRequest, csrfToken: string): Promise<CapacityProfileDTO> {
    return apiFetch<CapacityProfileDTO>("/capacity-profiles", { method: "POST", body: JSON.stringify(payload), csrfToken });
  },

  listRfqs(opts: { cookieHeader?: string } = {}): Promise<ListRfqsResponse> {
    return apiFetch<ListRfqsResponse>("/rfqs", { cookieHeader: opts.cookieHeader });
  },
  getRfq(id: string, opts: { cookieHeader?: string } = {}): Promise<RFQDTO> {
    return apiFetch<RFQDTO>(`/rfqs/${id}`, { cookieHeader: opts.cookieHeader });
  },
  createRfq(payload: CreateRfqRequest, csrfToken: string): Promise<RFQDTO> {
    return apiFetch<RFQDTO>("/rfqs", { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  declineRfq(id: string, payload: DeclineRfqRequest, csrfToken: string): Promise<RFQRecipientDTO> {
    return apiFetch<RFQRecipientDTO>(`/rfqs/${id}/decline`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  submitQuote(id: string, payload: SubmitQuoteRequest, csrfToken: string): Promise<QuoteDTO> {
    return apiFetch<QuoteDTO>(`/rfqs/${id}/quotes`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  withdrawQuote(id: string, quoteId: string, csrfToken: string): Promise<QuoteDTO> {
    return apiFetch<QuoteDTO>(`/rfqs/${id}/quotes/${quoteId}/withdraw`, { method: "POST", csrfToken });
  },
  selectQuote(id: string, payload: SelectQuoteRequest, csrfToken: string): Promise<DealRoomDTO> {
    return apiFetch<DealRoomDTO>(`/rfqs/${id}/select`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },

  listDeals(opts: { cookieHeader?: string } = {}): Promise<ListDealRoomsResponse> {
    return apiFetch<ListDealRoomsResponse>("/deals", { cookieHeader: opts.cookieHeader });
  },
  getDeal(id: string, opts: { cookieHeader?: string } = {}): Promise<DealRoomDTO> {
    return apiFetch<DealRoomDTO>(`/deals/${id}`, { cookieHeader: opts.cookieHeader });
  },
  getDealTimeline(id: string, opts: { cookieHeader?: string } = {}): Promise<TimelineResponse> {
    return apiFetch<TimelineResponse>(`/deals/${id}/timeline`, { cookieHeader: opts.cookieHeader });
  },
  postCondition(dealId: string, payload: PostConditionRequest, csrfToken: string): Promise<DealConditionDTO> {
    return apiFetch<DealConditionDTO>(`/deals/${dealId}/conditions`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  resolveCondition(dealId: string, conditionId: string, payload: ResolveConditionRequest, csrfToken: string): Promise<DealConditionDTO> {
    return apiFetch<DealConditionDTO>(`/deals/${dealId}/conditions/${conditionId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
      csrfToken,
    });
  },
  recordDecision(dealId: string, payload: RecordDecisionRequest, csrfToken: string): Promise<DealDecisionDTO> {
    return apiFetch<DealDecisionDTO>(`/deals/${dealId}/decisions`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },

  // ================================================================
  // earlier: Lockbox (P9)
  // ================================================================

  listLockboxes(opts: { cookieHeader?: string } = {}): Promise<ListLockboxesResponse> {
    return apiFetch<ListLockboxesResponse>("/lockbox", { cookieHeader: opts.cookieHeader });
  },
  getLockbox(id: string, opts: { cookieHeader?: string } = {}): Promise<LockboxDTO> {
    return apiFetch<LockboxDTO>(`/lockbox/${id}`, { cookieHeader: opts.cookieHeader });
  },
  /** "getReceipt" — proof-of-existence only; NEVER returns sealed contents. See @tol/contracts/src/lockbox.ts's own header comment. */
  getLockboxReceipt(id: string, opts: { cookieHeader?: string } = {}): Promise<LockboxReceiptDTO> {
    return apiFetch<LockboxReceiptDTO>(`/lockbox/${id}/receipt`, { cookieHeader: opts.cookieHeader });
  },
  sealLockbox(payload: SealLockboxRequest, csrfToken: string): Promise<LockboxDTO> {
    return apiFetch<LockboxDTO>("/lockbox", { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  withdrawLockbox(id: string, payload: WithdrawLockboxRequest, csrfToken: string): Promise<LockboxDTO> {
    return apiFetch<LockboxDTO>(`/lockbox/${id}/withdraw`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  /** The one call whose response ever carries real plaintext (`disclosedPayload`) — see ReleaseLockboxResponseSchema's own doc comment in @tol/contracts. */
  releaseLockbox(id: string, payload: ReleaseLockboxRequest, csrfToken: string): Promise<ReleaseLockboxResponse> {
    return apiFetch<ReleaseLockboxResponse>(`/lockbox/${id}/release`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },

  // ================================================================
  // earlier: Attribution (P10)
  // ================================================================

  listClaims(opts: { cookieHeader?: string } = {}): Promise<ListClaimsResponse> {
    return apiFetch<ListClaimsResponse>("/claims", { cookieHeader: opts.cookieHeader });
  },
  /** Full detail: the claim row, its evidence, its decision history, its disputes, and (reviewer-tier callers only — see apps/api's claims service) its rank among competing claims. */
  getClaim(id: string, opts: { cookieHeader?: string } = {}): Promise<ClaimDetailResponse> {
    return apiFetch<ClaimDetailResponse>(`/claims/${id}`, { cookieHeader: opts.cookieHeader });
  },
  /** Files AND scores a claim in one call — the response already carries the real, explainable @tol/attribution breakdown (never a bare total). */
  createClaim(payload: CreateClaimRequest, csrfToken: string): Promise<ClaimDTO> {
    return apiFetch<ClaimDTO>("/claims", { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  fileClaimDispute(id: string, payload: FileClaimDisputeRequest, csrfToken: string): Promise<ClaimDisputeDTO> {
    return apiFetch<ClaimDisputeDTO>(`/claims/${id}/disputes`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  decideClaim(id: string, payload: DecideClaimRequest, csrfToken: string): Promise<ClaimDecisionDTO> {
    return apiFetch<ClaimDecisionDTO>(`/claims/${id}/decisions`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },

  // ================================================================
  // earlier: Passport (P6)
  // ================================================================

  listPassports(opts: { cookieHeader?: string } = {}): Promise<ListPassportsResponse> {
    return apiFetch<ListPassportsResponse>("/passports", { cookieHeader: opts.cookieHeader });
  },
  getPassport(id: string, opts: { cookieHeader?: string } = {}): Promise<PassportDetailResponse> {
    return apiFetch<PassportDetailResponse>(`/passports/${id}`, { cookieHeader: opts.cookieHeader });
  },
  /** Primary UI lookup — the spec's route `/app/passport/[orgId]` is keyed by organization id (see @tol/contracts' PassportDTO comment on the 1:1 cardinality). */
  getPassportByOrg(orgId: string, opts: { cookieHeader?: string } = {}): Promise<PassportDetailResponse> {
    return apiFetch<PassportDetailResponse>(`/passports/by-org/${orgId}`, { cookieHeader: opts.cookieHeader });
  },
  createPassport(payload: CreatePassportRequest, csrfToken: string): Promise<PassportDTO> {
    return apiFetch<PassportDTO>("/passports", { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  upsertPassportFact(passportId: string, payload: UpsertFactRequest, csrfToken: string): Promise<FactDTO> {
    return apiFetch<FactDTO>(`/passports/${passportId}/facts`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  addPassportEvidence(passportId: string, payload: CreateEvidenceRequest, csrfToken: string): Promise<EvidenceDTO> {
    return apiFetch<EvidenceDTO>(`/passports/${passportId}/evidence`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  verifyPassport(passportId: string, payload: VerifyPassportRequest, csrfToken: string): Promise<PassportDTO> {
    return apiFetch<PassportDTO>(`/passports/${passportId}/verify`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },

  // ================================================================
  // earlier: Marketplace (P5) — always REDACTED cards; see
  // apps/api/src/modules/marketplace/mapper.ts for the server-side
  // enforcement this client merely renders the result of.
  // ================================================================

  listMarketCapacity(opts: { cookieHeader?: string } = {}): Promise<ListMarketplaceCapacityResponse> {
    return apiFetch<ListMarketplaceCapacityResponse>("/market/capacity", { cookieHeader: opts.cookieHeader });
  },
  listMarketOpportunities(opts: { cookieHeader?: string } = {}): Promise<ListMarketplaceOpportunitiesResponse> {
    return apiFetch<ListMarketplaceOpportunitiesResponse>("/market/opportunities", { cookieHeader: opts.cookieHeader });
  },

  // ================================================================
  // earlier: P7 VolumeSlice + volume reconciliation
  // ================================================================

  getVolumeSlices(opportunityId: string, opts: { cookieHeader?: string } = {}): Promise<VolumeSlicesResponse> {
    return apiFetch<VolumeSlicesResponse>(`/opportunities/${opportunityId}/volume-slices`, { cookieHeader: opts.cookieHeader });
  },
  replaceVolumeSlices(opportunityId: string, payload: ReplaceVolumeSlicesRequest, csrfToken: string): Promise<VolumeSlicesResponse> {
    return apiFetch<VolumeSlicesResponse>(`/opportunities/${opportunityId}/volume-slices`, { method: "PUT", body: JSON.stringify(payload), csrfToken });
  },

  // ================================================================
  // earlier: Matching (P11 Eligibility + P12 Ranking)
  // ================================================================

  /** Every field optional — EvaluateMatchesRequestSchema's own comment: a bare `{}` runs a full evaluation against every active candidate capacity. */
  evaluateMatches(opportunityId: string, payload: EvaluateMatchesRequest, csrfToken: string): Promise<EvaluateMatchesResponse> {
    return apiFetch<EvaluateMatchesResponse>(`/opportunities/${opportunityId}/matches/evaluate`, {
      method: "POST",
      body: JSON.stringify(payload),
      csrfToken,
    });
  },
  listMatches(opportunityId: string, opts: { cookieHeader?: string } = {}): Promise<ListMatchesResponse> {
    return apiFetch<ListMatchesResponse>(`/opportunities/${opportunityId}/matches`, { cookieHeader: opts.cookieHeader });
  },

  // ================================================================
  // earlier: Economics (P15) — every endpoint nested under one deal room.
  // ================================================================

  createSchedule(dealRoomId: string, payload: CreateScheduleRequest, csrfToken: string): Promise<CommissionScheduleDetailDTO> {
    return apiFetch<CommissionScheduleDetailDTO>(`/deals/${dealRoomId}/economics/schedules`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  listSchedules(dealRoomId: string, opts: { cookieHeader?: string } = {}): Promise<ListSchedulesResponse> {
    return apiFetch<ListSchedulesResponse>(`/deals/${dealRoomId}/economics/schedules`, { cookieHeader: opts.cookieHeader });
  },
  recordRevenueEvent(dealRoomId: string, payload: RecordRevenueEventRequest, csrfToken: string): Promise<RecordRevenueEventResponse> {
    return apiFetch<RecordRevenueEventResponse>(`/deals/${dealRoomId}/economics/revenue-events`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  listRevenueEvents(dealRoomId: string, opts: { cookieHeader?: string } = {}): Promise<ListRevenueEventsResponse> {
    return apiFetch<ListRevenueEventsResponse>(`/deals/${dealRoomId}/economics/revenue-events`, { cookieHeader: opts.cookieHeader });
  },
  getLedger(dealRoomId: string, opts: { cookieHeader?: string } = {}): Promise<LedgerResponse> {
    return apiFetch<LedgerResponse>(`/deals/${dealRoomId}/economics/ledger`, { cookieHeader: opts.cookieHeader });
  },
  recordPayment(dealRoomId: string, payload: RecordPaymentRequest, csrfToken: string): Promise<RecordPaymentResponse> {
    return apiFetch<RecordPaymentResponse>(`/deals/${dealRoomId}/economics/payments`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
  adjustLedger(dealRoomId: string, accrualRootId: string, payload: AdjustLedgerRequest, csrfToken: string): Promise<AdjustLedgerResponse> {
    return apiFetch<AdjustLedgerResponse>(`/deals/${dealRoomId}/economics/ledger/${accrualRootId}/adjust`, { method: "POST", body: JSON.stringify(payload), csrfToken });
  },
};
