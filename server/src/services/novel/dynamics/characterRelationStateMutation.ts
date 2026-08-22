import type { Prisma } from "@prisma/client";
import { z } from "zod";

const relationStateProposalPayloadSchema = z.object({
  sourceCharacterId: z.string().trim().min(1),
  targetCharacterId: z.string().trim().min(1),
  surfaceRelation: z.string().trim().min(1).optional().nullable(),
  hiddenTension: z.string().trim().optional().nullable(),
  conflictSource: z.string().trim().optional().nullable(),
  secretAsymmetry: z.string().trim().optional().nullable(),
  dynamicLabel: z.string().trim().optional().nullable(),
  nextTurnPoint: z.string().trim().optional().nullable(),
  trustScore: z.number().int().min(0).max(100).optional().nullable(),
  conflictScore: z.number().int().min(0).max(100).optional().nullable(),
  intimacyScore: z.number().int().min(0).max(100).optional().nullable(),
  dependencyScore: z.number().int().min(0).max(100).optional().nullable(),
  stageLabel: z.string().trim().min(1).optional().nullable(),
  stageSummary: z.string().trim().min(1).optional().nullable(),
  summary: z.string().trim().min(1).optional().nullable(),
  volumeId: z.string().trim().min(1).optional().nullable(),
  chapterId: z.string().trim().min(1).optional().nullable(),
  chapterOrder: z.number().int().min(1).optional().nullable(),
  confidence: z.number().min(0).max(1).optional().nullable(),
}).passthrough();

export interface ReplaceCurrentCharacterRelationStageInput {
  novelId: string;
  relationId: string | null;
  sourceCharacterId: string;
  targetCharacterId: string;
  volumeId?: string | null;
  chapterId?: string | null;
  chapterOrder?: number | null;
  stageLabel: string;
  stageSummary: string;
  nextTurnPoint?: string | null;
  sourceType: string;
  confidence?: number | null;
}

export async function replaceCurrentCharacterRelationStage(
  tx: Prisma.TransactionClient,
  input: ReplaceCurrentCharacterRelationStageInput,
) {
  await tx.characterRelationStage.updateMany({
    where: {
      novelId: input.novelId,
      sourceCharacterId: input.sourceCharacterId,
      targetCharacterId: input.targetCharacterId,
      isCurrent: true,
    },
    data: { isCurrent: false },
  });
  return tx.characterRelationStage.create({
    data: {
      novelId: input.novelId,
      relationId: input.relationId,
      sourceCharacterId: input.sourceCharacterId,
      targetCharacterId: input.targetCharacterId,
      volumeId: input.volumeId ?? null,
      chapterId: input.chapterId ?? null,
      chapterOrder: input.chapterOrder ?? null,
      stageLabel: input.stageLabel,
      stageSummary: input.stageSummary,
      nextTurnPoint: input.nextTurnPoint || null,
      sourceType: input.sourceType,
      confidence: input.confidence ?? null,
      isCurrent: true,
    },
    include: {
      sourceCharacter: { select: { name: true } },
      targetCharacter: { select: { name: true } },
      volume: { select: { title: true } },
    },
  });
}

export async function applyCharacterRelationStateProposal(
  tx: Prisma.TransactionClient,
  input: {
    novelId: string;
    chapterId?: string | null;
    payload: Record<string, unknown>;
    summary: string;
    evidence: string[];
    sourceType: string;
  },
): Promise<void> {
  const payload = relationStateProposalPayloadSchema.parse(input.payload);
  if (payload.sourceCharacterId === payload.targetCharacterId) {
    throw new Error("Relation state proposal requires two different characters.");
  }
  const characterCount = await tx.character.count({
    where: {
      novelId: input.novelId,
      id: { in: [payload.sourceCharacterId, payload.targetCharacterId] },
    },
  });
  if (characterCount !== 2) {
    throw new Error("Relation state proposal references characters outside this novel.");
  }

  const fallbackRelationLabel = payload.stageLabel
    || payload.dynamicLabel
    || payload.surfaceRelation
    || input.summary;
  const relation = await tx.characterRelation.upsert({
    where: {
      novelId_sourceCharacterId_targetCharacterId: {
        novelId: input.novelId,
        sourceCharacterId: payload.sourceCharacterId,
        targetCharacterId: payload.targetCharacterId,
      },
    },
    create: {
      novelId: input.novelId,
      sourceCharacterId: payload.sourceCharacterId,
      targetCharacterId: payload.targetCharacterId,
      surfaceRelation: payload.surfaceRelation || fallbackRelationLabel,
      hiddenTension: payload.hiddenTension ?? null,
      conflictSource: payload.conflictSource ?? null,
      secretAsymmetry: payload.secretAsymmetry ?? null,
      dynamicLabel: payload.dynamicLabel ?? payload.stageLabel ?? null,
      nextTurnPoint: payload.nextTurnPoint ?? null,
      trustScore: payload.trustScore ?? null,
      conflictScore: payload.conflictScore ?? null,
      intimacyScore: payload.intimacyScore ?? null,
      dependencyScore: payload.dependencyScore ?? null,
      evidence: input.evidence.join("\n") || null,
    },
    update: {
      ...(payload.surfaceRelation !== undefined
        ? { surfaceRelation: payload.surfaceRelation || fallbackRelationLabel }
        : {}),
      ...(payload.hiddenTension !== undefined
        ? { hiddenTension: payload.hiddenTension || null }
        : {}),
      ...(payload.conflictSource !== undefined
        ? { conflictSource: payload.conflictSource || null }
        : {}),
      ...(payload.secretAsymmetry !== undefined
        ? { secretAsymmetry: payload.secretAsymmetry || null }
        : {}),
      ...(payload.dynamicLabel !== undefined
        ? { dynamicLabel: payload.dynamicLabel || null }
        : {}),
      ...(payload.nextTurnPoint !== undefined
        ? { nextTurnPoint: payload.nextTurnPoint || null }
        : {}),
      ...(payload.trustScore !== undefined ? { trustScore: payload.trustScore } : {}),
      ...(payload.conflictScore !== undefined ? { conflictScore: payload.conflictScore } : {}),
      ...(payload.intimacyScore !== undefined ? { intimacyScore: payload.intimacyScore } : {}),
      ...(payload.dependencyScore !== undefined ? { dependencyScore: payload.dependencyScore } : {}),
      ...(input.evidence.length > 0 ? { evidence: input.evidence.join("\n") } : {}),
    },
  });

  await replaceCurrentCharacterRelationStage(tx, {
    novelId: input.novelId,
    relationId: relation.id,
    sourceCharacterId: payload.sourceCharacterId,
    targetCharacterId: payload.targetCharacterId,
    volumeId: payload.volumeId,
    chapterId: input.chapterId ?? payload.chapterId ?? null,
    chapterOrder: payload.chapterOrder,
    stageLabel: payload.stageLabel || payload.dynamicLabel || relation.dynamicLabel || relation.surfaceRelation,
    stageSummary: payload.stageSummary || payload.summary || input.summary,
    nextTurnPoint: payload.nextTurnPoint,
    sourceType: input.sourceType,
    confidence: payload.confidence,
  });
}
