// packages/domain/src/transition-error.ts
//
// Common base class for every "invalid state transition" error this
// package throws (InvalidOpportunityTransitionError, InvalidRfqTransitionError,
// InvalidDealTransitionError) — added so apps/api's central error handler
// (app.ts) can catch exactly this class with ONE instanceof check and
// turn it into a clean problem+json 400, instead of letting it fall
// through to the generic "unexpected error -> 500" branch. A client
// attempting an invalid transition (e.g. submitting a quote after
// declining) is a CLIENT error, not a server bug — this base class is
// what makes that distinction catchable centrally rather than requiring
// every service call site to wrap every assertValid*Transition call in
// its own try/catch.
export class DomainTransitionError extends Error {}
