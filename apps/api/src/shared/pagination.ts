// apps/api/src/shared/pagination.ts — minimal cursor-pagination query
// parsing. the list endpoints (organizations, memberships, audit
// events) are all small collections seeded with single-digit row counts,
// so this is intentionally thin — enough structure that a real
// cursor-paginated client-facing endpoint can be wired to it later
// without a breaking response-shape change, not a fully general
// pagination engine.

import { ProblemError } from "./errors.js";

export interface PageQuery {
  limit: number;
  cursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function parsePageQuery(query: Record<string, unknown>): PageQuery {
  let limit = DEFAULT_LIMIT;
  if (typeof query["limit"] === "string" && query["limit"] !== "") {
    const parsed = Number.parseInt(query["limit"], 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw ProblemError.badRequest("`limit` must be a positive integer", { limit: ["must be a positive integer"] });
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }
  const cursor = typeof query["cursor"] === "string" && query["cursor"] !== "" ? query["cursor"] : undefined;
  return { limit, cursor };
}
