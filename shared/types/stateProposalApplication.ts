import type { StateChangeProposal } from "./canonicalState.js";

export type StateProposalApplicationMode = "domain_state" | "ledger_only";

export const STATE_PROPOSAL_APPLICATION_MODES = {
  event_record: "ledger_only",
  information_disclosure: "ledger_only",
  conflict_update: "ledger_only",
  payoff_progression: "ledger_only",
  world_rule_change: "ledger_only",
  book_contract_change: "ledger_only",
  outline_plan_update: "domain_state",
  character_resource_update: "domain_state",
  character_state_update: "domain_state",
  relation_state_update: "domain_state",
} as const satisfies Record<StateChangeProposal["proposalType"], StateProposalApplicationMode>;

export type DomainStateProposalType = {
  [ProposalType in StateChangeProposal["proposalType"]]:
    typeof STATE_PROPOSAL_APPLICATION_MODES[ProposalType] extends "domain_state"
      ? ProposalType
      : never;
}[StateChangeProposal["proposalType"]];

const PROPOSED_CHANGE_PAYLOAD_KEY_ALIASES: Partial<Record<
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

export function getStateProposalApplicationMode(
  proposalType: StateChangeProposal["proposalType"],
): StateProposalApplicationMode {
  return STATE_PROPOSAL_APPLICATION_MODES[proposalType];
}

export function resolveProposedChangePayloadKey(input: {
  proposalType: StateChangeProposal["proposalType"];
  path: string;
  payload: Record<string, unknown>;
}): string | null {
  const terminal = terminalPathSegment(input.path);
  if (!terminal) {
    return null;
  }
  const aliased = PROPOSED_CHANGE_PAYLOAD_KEY_ALIASES[input.proposalType]?.[terminal] ?? terminal;
  if (Object.prototype.hasOwnProperty.call(input.payload, aliased)) {
    return aliased;
  }
  if (aliased !== terminal && Object.prototype.hasOwnProperty.call(input.payload, terminal)) {
    return terminal;
  }
  return null;
}
