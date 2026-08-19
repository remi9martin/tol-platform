// apps/api/src/shared/errors.ts
//
// RFC-style problem responses (the spec: "Use RFC-style problem
// responses: code, message, requestId, fieldErrors, retryable, and safe
// details"). ProblemError is what route/service code throws; the error
// handler registered in app.ts is the only place that turns any thrown
// error (ProblemError or otherwise) into an HTTP response — route
// handlers never construct a response body for an error case by hand.

export class ProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors?: Record<string, string[]>;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
    retryable?: boolean;
    details?: unknown;
  }) {
    super(opts.message);
    this.name = "ProblemError";
    this.status = opts.status;
    this.code = opts.code;
    this.fieldErrors = opts.fieldErrors;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }

  static badRequest(message: string, fieldErrors?: Record<string, string[]>): ProblemError {
    return new ProblemError({ status: 400, code: "bad_request", message, fieldErrors });
  }

  static unauthorized(message = "Authentication required"): ProblemError {
    return new ProblemError({ status: 401, code: "unauthorized", message });
  }

  static forbidden(message = "Not permitted", details?: unknown): ProblemError {
    return new ProblemError({ status: 403, code: "forbidden", message, details });
  }

  static notFound(message = "Resource not found"): ProblemError {
    return new ProblemError({ status: 404, code: "not_found", message });
  }

  static conflict(message: string, retryable = false): ProblemError {
    return new ProblemError({ status: 409, code: "conflict", message, retryable });
  }

  static tooManyRequests(message = "Rate limit exceeded"): ProblemError {
    return new ProblemError({ status: 429, code: "rate_limited", message, retryable: true });
  }

  static internal(message = "Internal server error"): ProblemError {
    return new ProblemError({ status: 500, code: "internal_error", message, retryable: true });
  }
}

/**
 * Flattens a Zod SafeParseReturnType's error tree into the flat
 * {field: [messages]} shape ProblemError.fieldErrors expects. Kept here
 * (not in packages/contracts) since it's specifically about turning a
 * validation failure into an HTTP-shaped error, an apps/api concern.
 */
export function zodFieldErrors(issues: { path: PropertyKey[]; message: string }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length ? issue.path.map(String).join(".") : "_root";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
