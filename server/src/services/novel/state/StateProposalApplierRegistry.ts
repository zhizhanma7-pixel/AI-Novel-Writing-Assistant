import type { StateChangeProposal } from "@ai-novel/shared/types/canonicalState";
import { characterImportPayloadSchema } from "@ai-novel/shared/types/characterImport";
import { characterResourceUpdatePayloadSchema } from "@ai-novel/shared/types/characterResource";
import {
  getStateProposalApplicationMode as getSharedStateProposalApplicationMode,
  type DomainStateProposalType,
  type StateProposalApplicationMode,
} from "@ai-novel/shared/types/stateProposalApplication";
import type { Prisma } from "@prisma/client";
import { characterResourceLedgerService } from "../characterResource/CharacterResourceLedgerService";
import { applyCharacterRelationStateProposal } from "../dynamics/characterRelationStateMutation";
import { applyChapterExecutionPlanUpdate } from "../proposal/chapterExecution/application/ChapterExecutionPlanApplier";
import { StateProposalDomainError } from "./StateProposalDomainError";
import { applyOutlinePlanUpdate } from "../proposal/outline/application/OutlinePlanProposalApplier";

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
  outline_plan_update: applyOutlinePlanUpdate,
  chapter_execution_plan_update: applyChapterExecutionPlanUpdate,
  /**
   * 从外部资产导入一个角色。
   *
   * 走提案而不是直接写角色库，是设计文档对导入的硬要求。这里只在事务内建行，
   * **不排队 RAG 索引**——既有的角色 applier（`character_state_update`）同样不排，
   * 在事务内触发提交后才该发生的副作用会在回滚时留下孤儿任务。属 K5 同类的
   * 已知边界：需要索引时由既有的重建路径补。
   */
  character_import: async (tx, proposal) => {
    const parsed = characterImportPayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      throw new StateProposalDomainError({
        proposalType: "character_import",
        reason: "invalid_payload",
        message: "Character import proposal has an invalid payload.",
        cause: parsed.error,
      });
    }
    const payload = parsed.data;
    const novel = await tx.novel.findUnique({
      where: { id: proposal.novelId },
      select: { id: true },
    });
    if (!novel) {
      throw new StateProposalDomainError({
        proposalType: "character_import",
        reason: "invalid_payload",
        message: "Character import proposal references a missing novel.",
      });
    }
    const duplicate = await tx.character.findFirst({
      where: { novelId: proposal.novelId, name: payload.name },
      select: { id: true },
    });
    if (duplicate) {
      throw new StateProposalDomainError({
        proposalType: "character_import",
        reason: "duplicate_character",
        message: `Character ${payload.name} already exists in this novel.`,
      });
    }
    await tx.character.create({
      data: {
        novelId: proposal.novelId,
        name: payload.name,
        role: payload.role,
        personality: payload.personality ?? null,
        background: payload.background ?? null,
      },
    });
  },
  character_resource_update: async (tx, proposal) => {
    const parsed = characterResourceUpdatePayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      throw new StateProposalDomainError({
        proposalType: "character_resource_update",
        reason: "invalid_payload",
        message: "Character resource state proposal has an invalid payload.",
        cause: parsed.error,
      });
    }
    const payload = parsed.data;
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
      throw new StateProposalDomainError({
        proposalType: "character_state_update",
        reason: "missing_character_id",
        message: "Character state proposal is missing characterId.",
      });
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
      throw new StateProposalDomainError({
        proposalType: "character_state_update",
        reason: "character_not_found",
        message: "Character state proposal references a missing character.",
      });
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
