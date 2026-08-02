export type PaymentDomainErrorCode =
  | "wager_already_exists"
  | "active_game_exists"
  | "insufficient_user_balance"
  | "insufficient_bot_coverage"
  | "wager_not_found"
  | "wager_expired"
  | "wager_not_active"
  | "wager_not_settleable"
  | "wager_requester_mismatch"
  | "payout_out_of_range"
  | "settlement_outcome_mismatch"
  | "settlement_request_id_missing"
  | "settlement_requires_persisted_decision"
  | "settlement_requires_new_reply";

export class PaymentDomainError extends Error {
  constructor(readonly code: PaymentDomainErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaymentDomainError";
  }
}

export function paymentError(code: PaymentDomainErrorCode, message: string, options?: ErrorOptions) {
  return new PaymentDomainError(code, message, options);
}

export function isPaymentDomainError(error: unknown): error is PaymentDomainError {
  return error instanceof PaymentDomainError;
}
