import type { StateChangeProposal } from "@ai-novel/shared/types/canonicalState";

export type StateProposalDomainErrorReason =
  | "invalid_payload"
  | "missing_character_id"
  | "character_not_found"
  | "duplicate_character"
  | "same_character_relation"
  | "character_outside_novel"
  | "chapter_content_protected";

export interface StateProposalDomainErrorInput {
  proposalType: StateChangeProposal["proposalType"];
  reason: StateProposalDomainErrorReason;
  message: string;
  cause?: unknown;
}

/**
 * A deterministic proposal-data failure that legacy callers may isolate as a
 * rejected row. Transaction safety invariant: every site that throws this
 * error must do so before issuing SQL, or only after preceding SQL statements
 * have completed successfully. Never translate a failed SQL statement into
 * this error, because callers may catch it inside a Prisma transaction and
 * continue using the same transaction client; PostgreSQL would reject those
 * follow-up statements with 25P02 while SQLite could appear to work.
 */
export class StateProposalDomainError extends Error {
  readonly proposalType: StateChangeProposal["proposalType"];
  readonly reason: StateProposalDomainErrorReason;

  constructor(input: StateProposalDomainErrorInput) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "StateProposalDomainError";
    this.proposalType = input.proposalType;
    this.reason = input.reason;
  }
}
