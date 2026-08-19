// packages/matching/src/errors.ts
//
// Two distinct error classes (one per stage — eligibility vs ranking),
// same split as @tol/attribution's ClaimScoringInputError /
// ClaimRankingInputError. Both extend TypeError, matching every other
// "fail loud on malformed input" guard in this codebase
// (@tol/domain/money.ts's MoneyInvariantError, @tol/attribution's own
// two error classes).

export class EligibilityInputError extends TypeError {
  constructor(message: string) {
    super(`invalid eligibility input: ${message}`);
    this.name = "EligibilityInputError";
  }
}

export class RankingInputError extends TypeError {
  constructor(message: string) {
    super(`invalid ranking input: ${message}`);
    this.name = "RankingInputError";
  }
}
