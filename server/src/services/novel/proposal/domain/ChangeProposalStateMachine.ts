import type { ChangeProposalStatus } from "@ai-novel/shared/types/changeProposal";
import { ChangeProposalError } from "./ChangeProposalError";

const ALLOWED_TRANSITIONS: Readonly<Record<ChangeProposalStatus, readonly ChangeProposalStatus[]>> = {
  draft: ["pending_review", "superseded"],
  pending_review: ["approved", "partially_approved", "rejected", "superseded"],
  approved: ["executed", "superseded"],
  partially_approved: ["executed", "superseded"],
  rejected: ["superseded"],
  executed: [],
  superseded: [],
};

export function assertChangeProposalTransition(
  current: ChangeProposalStatus,
  next: ChangeProposalStatus,
): void {
  if (ALLOWED_TRANSITIONS[current].includes(next)) {
    return;
  }
  throw new ChangeProposalError(
    "invalid_transition",
    `Change proposal cannot transition from ${current} to ${next}.`,
    { current, next },
  );
}

export function assertExpectedProposalVersion(actual: number, expected?: number): void {
  if (expected === undefined || actual === expected) {
    return;
  }
  throw new ChangeProposalError(
    "version_conflict",
    `Change proposal version ${actual} does not match expected version ${expected}.`,
    { actual, expected },
  );
}
