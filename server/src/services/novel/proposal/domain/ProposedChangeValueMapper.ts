import type { StateChangeProposal } from "@ai-novel/shared/types/canonicalState";
import { ChangeProposalError } from "./ChangeProposalError";

const PAYLOAD_KEY_ALIASES: Partial<Record<
  StateChangeProposal["proposalType"],
  Readonly<Record<string, string>>
>> = {
  relation_state_update: {
    trust: "trustScore",
    intimacy: "intimacyScore",
    conflict: "conflictScore",
    dependency: "dependencyScore",
  },
  character_state_update: {
    state: "currentState",
    goal: "currentGoal",
  },
};

function terminalPathSegment(path: string): string {
  return path
    .trim()
    .split(".")
    .at(-1)
    ?.replace(/^\[|\]$/g, "")
    .trim() ?? "";
}

function resolvePayloadKey(input: {
  proposalType: StateChangeProposal["proposalType"];
  path: string;
  payload: Record<string, unknown>;
}): string | null {
  const terminal = terminalPathSegment(input.path);
  if (!terminal) {
    return null;
  }
  const aliased = PAYLOAD_KEY_ALIASES[input.proposalType]?.[terminal] ?? terminal;
  if (Object.prototype.hasOwnProperty.call(input.payload, aliased)) {
    return aliased;
  }
  if (aliased !== terminal && Object.prototype.hasOwnProperty.call(input.payload, terminal)) {
    return terminal;
  }
  return null;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function applyEditedValueToPayload(input: {
  proposalType: StateChangeProposal["proposalType"];
  path: string;
  payload: Record<string, unknown>;
  editedValue: unknown;
}): Record<string, unknown> {
  const payloadKey = resolvePayloadKey(input);
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
  const payloadKey = resolvePayloadKey(input);
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
  const payloadKey = resolvePayloadKey(input);
  if (!payloadKey || !jsonEqual(input.payload[payloadKey], input.editedValue)) {
    throw new ChangeProposalError(
      "invalid_review",
      `Edited value at ${input.path} does not match the executable payload.`,
      { proposalType: input.proposalType, path: input.path, payloadKey },
    );
  }
}
