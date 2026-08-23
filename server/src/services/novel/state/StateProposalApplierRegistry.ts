import type { StateChangeProposal } from "@ai-novel/shared/types/canonicalState";
import { characterResourceUpdatePayloadSchema } from "@ai-novel/shared/types/characterResource";
import {
  getStateProposalApplicationMode as getSharedStateProposalApplicationMode,
  type DomainStateProposalType,
  type StateProposalApplicationMode,
} from "@ai-novel/shared/types/stateProposalApplication";
import type { Prisma } from "@prisma/client";
import { characterResourceLedgerService } from "../characterResource/CharacterResourceLedgerService";
import { applyCharacterRelationStateProposal } from "../dynamics/characterRelationStateMutation";

type StateProposalApplier = (
  tx: Prisma.TransactionClient,
  proposal: StateChangeProposal,
) => Promise<void>;

function compactText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const DOMAIN_STATE_PROPOSAL_APPLIERS: Record<DomainStateProposalType, StateProposalApplier> = {
  character_resource_update: async (tx, proposal) => {
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
  character_state_update: async (tx, proposal) => {
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
  relation_state_update: (tx, proposal) => applyCharacterRelationStateProposal(tx, {
      novelId: proposal.novelId,
      chapterId: proposal.chapterId,
      payload: proposal.payload,
      summary: proposal.summary,
      evidence: proposal.evidence,
      sourceType: proposal.sourceType,
    }),
};

export function getStateProposalApplicationMode(
  proposalType: StateChangeProposal["proposalType"],
): StateProposalApplicationMode {
  return getSharedStateProposalApplicationMode(proposalType);
}

export async function applyStateChangeProposal(
  tx: Prisma.TransactionClient,
  proposal: StateChangeProposal,
): Promise<StateProposalApplicationMode> {
  const mode = getSharedStateProposalApplicationMode(proposal.proposalType);
  if (mode === "ledger_only") {
    return mode;
  }
  const apply = DOMAIN_STATE_PROPOSAL_APPLIERS[proposal.proposalType as DomainStateProposalType];
  if (!apply) {
    throw new Error(`No state proposal applier is registered for ${proposal.proposalType}.`);
  }
  await apply(tx, proposal);
  return mode;
}
