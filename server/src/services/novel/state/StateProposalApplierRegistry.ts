import type { StateChangeProposal } from "@ai-novel/shared/types/canonicalState";
import { characterResourceUpdatePayloadSchema } from "@ai-novel/shared/types/characterResource";
import type { Prisma } from "@prisma/client";
import { characterResourceLedgerService } from "../characterResource/CharacterResourceLedgerService";
import { applyCharacterRelationStateProposal } from "../dynamics/characterRelationStateMutation";

export type StateProposalApplicationMode = "domain_state" | "ledger_only";

interface StateProposalApplierDefinition {
  mode: StateProposalApplicationMode;
  apply?: (tx: Prisma.TransactionClient, proposal: StateChangeProposal) => Promise<void>;
}

function compactText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const STATE_PROPOSAL_APPLIERS: Record<
  StateChangeProposal["proposalType"],
  StateProposalApplierDefinition
> = {
  event_record: { mode: "ledger_only" },
  information_disclosure: { mode: "ledger_only" },
  conflict_update: { mode: "ledger_only" },
  payoff_progression: { mode: "ledger_only" },
  world_rule_change: { mode: "ledger_only" },
  book_contract_change: { mode: "ledger_only" },
  character_resource_update: {
    mode: "domain_state",
    apply: async (tx, proposal) => {
      const payload = characterResourceUpdatePayloadSchema.parse(proposal.payload);
      await characterResourceLedgerService.applyCommittedUpdate(tx, {
        novelId: proposal.novelId,
        chapterId: proposal.chapterId ?? null,
        chapterOrder: typeof payload.chapterOrder === "number" ? payload.chapterOrder : null,
        payload,
        evidence: proposal.evidence,
        validationNotes: proposal.validationNotes,
        riskLevel: proposal.riskLevel,
      });
    },
  },
  character_state_update: {
    mode: "domain_state",
    apply: async (tx, proposal) => {
      const payload = parseJsonRecord(proposal.payload);
      const characterId = compactText(payload.characterId);
      if (!characterId) {
        throw new Error("Character state proposal is missing characterId.");
      }
      const updated = await tx.character.updateMany({
        where: { id: characterId, novelId: proposal.novelId },
        data: {
          ...(payload.currentState !== undefined
            ? { currentState: compactText(payload.currentState) || null }
            : {}),
          ...(payload.currentGoal !== undefined
            ? { currentGoal: compactText(payload.currentGoal) || null }
            : {}),
          lastEvolvedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        throw new Error("Character state proposal references a missing character.");
      }
    },
  },
  relation_state_update: {
    mode: "domain_state",
    apply: (tx, proposal) => applyCharacterRelationStateProposal(tx, {
      novelId: proposal.novelId,
      chapterId: proposal.chapterId,
      payload: proposal.payload,
      summary: proposal.summary,
      evidence: proposal.evidence,
      sourceType: proposal.sourceType,
    }),
  },
};

export function getStateProposalApplicationMode(
  proposalType: StateChangeProposal["proposalType"],
): StateProposalApplicationMode {
  return STATE_PROPOSAL_APPLIERS[proposalType].mode;
}

export async function applyStateChangeProposal(
  tx: Prisma.TransactionClient,
  proposal: StateChangeProposal,
): Promise<StateProposalApplicationMode> {
  const definition = STATE_PROPOSAL_APPLIERS[proposal.proposalType];
  if (definition.mode === "ledger_only") {
    return definition.mode;
  }
  if (!definition.apply) {
    throw new Error(`No state proposal applier is registered for ${proposal.proposalType}.`);
  }
  await definition.apply(tx, proposal);
  return definition.mode;
}
