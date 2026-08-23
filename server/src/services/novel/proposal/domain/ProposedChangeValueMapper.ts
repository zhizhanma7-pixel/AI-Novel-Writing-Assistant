import type { StateChangeProposal } from "@ai-novel/shared/types/canonicalState";
import { resolveProposedChangePayloadKey } from "@ai-novel/shared/types/stateProposalApplication";
import { ChangeProposalError } from "./ChangeProposalError";

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function applyEditedValueToPayload(input: {
  proposalType: StateChangeProposal["proposalType"];
  path: string;
  payload: Record<string, unknown>;
  editedValue: unknown;
}): Record<string, unknown> {
  const payloadKey = resolveProposedChangePayloadKey(input);
  if (!payloadKey) {
    throw new ChangeProposalError(
      "invalid_review",
      `Edited value at ${input.path} cannot be mapped to the executable payload. Send editedPayload instead.`,
      { proposalType: input.proposalType, path: input.path },
    );
  }
  return {
    ...input.payload,
    [payloadKey]: input.editedValue,
  };
}

export function resolveEditedValueFromPayload(input: {
  proposalType: StateChangeProposal["proposalType"];
  path: string;
  payload: Record<string, unknown>;
}): { mapped: true; value: unknown } | { mapped: false } {
  const payloadKey = resolveProposedChangePayloadKey(input);
  return payloadKey
    ? { mapped: true, value: input.payload[payloadKey] }
    : { mapped: false };
}

export function assertEditedValueMatchesPayload(input: {
  proposalType: StateChangeProposal["proposalType"];
  path: string;
  payload: Record<string, unknown>;
  editedValue: unknown;
}): void {
  const payloadKey = resolveProposedChangePayloadKey(input);
  if (!payloadKey || !jsonEqual(input.payload[payloadKey], input.editedValue)) {
    throw new ChangeProposalError(
      "invalid_review",
      `Edited value at ${input.path} does not match the executable payload.`,
      { proposalType: input.proposalType, path: input.path, payloadKey },
    );
  }
}
