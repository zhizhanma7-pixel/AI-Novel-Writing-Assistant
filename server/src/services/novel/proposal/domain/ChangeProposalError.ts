export type ChangeProposalErrorCode =
  | "not_found"
  | "invalid_transition"
  | "version_conflict"
  | "stale_proposal"
  | "invalid_review"
  | "no_approved_changes"
  | "unsupported_change";

const STATUS_BY_CODE: Record<ChangeProposalErrorCode, number> = {
  not_found: 404,
  invalid_transition: 409,
  version_conflict: 409,
  stale_proposal: 409,
  invalid_review: 400,
  no_approved_changes: 409,
  unsupported_change: 409,
};

export class ChangeProposalError extends Error {
  readonly code: ChangeProposalErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ChangeProposalErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ChangeProposalError";
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = details;
  }
}
