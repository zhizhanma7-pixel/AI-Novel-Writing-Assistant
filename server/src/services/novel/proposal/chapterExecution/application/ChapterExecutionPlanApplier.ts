import type { StateChangeProposal } from "@ai-novel/shared/types/canonicalState";
import {
  chapterExecutionPlanUpdatePayloadSchema,
  type ChapterExecutionPlanPatch,
} from "@ai-novel/shared/types/chapterExecutionPlan";
import type { VolumePlanDocument } from "@ai-novel/shared/types/novel";
import type { Prisma } from "@prisma/client";
import { StateProposalDomainError } from "../../../state/StateProposalDomainError";
import { NovelVolumeService } from "../../../volume/NovelVolumeService";

const volumeService = new NovelVolumeService();

function parseRiskFlags(
  value: string | null | undefined,
  proposal: StateChangeProposal,
): Record<string, unknown> {
  if (!value?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("riskFlags is not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    // 解析失败必须拒绝 apply：清空旧值后继续会静默丢掉既有 qualityLoop
    // 等质量债记录，属于数据完整性问题。
    throw new StateProposalDomainError({
      proposalType: proposal.proposalType,
      reason: "invalid_payload",
      message: "Chapter riskFlags could not be parsed; refusing to overwrite existing quality debt.",
      cause: error,
    });
  }
}

function applyPatchToDocument(
  document: VolumePlanDocument,
  patches: ChapterExecutionPlanPatch[],
): { volumes: VolumePlanDocument["volumes"]; appliedOrders: number[] } {
  const byOrder = new Map(patches.map((patch) => [patch.chapterOrder, patch]));
  const appliedOrders: number[] = [];
  const volumes = document.volumes.map((volume) => ({
    ...volume,
    chapters: volume.chapters.map((chapter) => {
      const patch = byOrder.get(chapter.chapterOrder);
      if (!patch) {
        return chapter;
      }
      appliedOrders.push(chapter.chapterOrder);
      return {
        ...chapter,
        ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
        ...(patch.endingState !== undefined ? { endingState: patch.endingState } : {}),
        ...(patch.nextChapterEntryState !== undefined
          ? { nextChapterEntryState: patch.nextChapterEntryState }
          : {}),
        ...(patch.exclusiveEvent !== undefined
          ? { exclusiveEvent: patch.exclusiveEvent }
          : {}),
      };
    }),
  }));
  return { volumes, appliedOrders };
}

/**
 * 「接受偏离」的正式写入。
 *
 * 三条硬约束：
 * 1. **不写本章的义务合同 / 边界合同**——原始 Expected 原样保留作审计证据。
 * 2. 只 patch 下游卷规划条目，且经 `applyWorkspaceDocumentWithinTransaction`
 *    在信封事务内完成 active version + workspace 的一致写入。
 * 3. 在本章 `riskFlags.divergenceResolutions` 上 merge 解决结果，保留全部既有
 *    顶层键（含 `qualityLoop`），禁止整段覆盖。
 *
 * 注：这里不调用 `ChapterContentProtectionGuard`——本 applier 只写
 * `volumePlan` / `volumeChapterPlan` / `novel`，从不触碰 `Chapter` 行，
 * 既不删除也不重排章节，因此该 guard 的保护面与本路径无交集；对尚未生成
 * `Chapter` 行的未来章节调用它反而会产生假失败。
 */
export async function applyChapterExecutionPlanUpdate(
  tx: Prisma.TransactionClient,
  proposal: StateChangeProposal,
): Promise<void> {
  const parsed = chapterExecutionPlanUpdatePayloadSchema.safeParse(proposal.payload);
  if (!parsed.success) {
    throw new StateProposalDomainError({
      proposalType: "chapter_execution_plan_update",
      reason: "invalid_payload",
      message: "Chapter execution plan proposal has an invalid payload.",
      cause: parsed.error,
    });
  }
  const payload = parsed.data;

  const chapter = await tx.chapter.findFirst({
    where: { id: payload.chapterId, novelId: proposal.novelId },
    select: { id: true, riskFlags: true },
  });
  if (!chapter) {
    throw new StateProposalDomainError({
      proposalType: "chapter_execution_plan_update",
      reason: "character_not_found",
      message: "Chapter execution plan proposal references a missing chapter.",
    });
  }

  if (payload.downstreamPlanPatches.length > 0) {
    // 必须用事务内读取：此前这里先走一次全局 `getVolumes()`，那不仅读的是
    // 信封事务之外的快照，还可能在 hydrate 有差异时自行持久化（复审 M2）。
    const document = await volumeService.readWorkspaceWithinTransaction(tx, proposal.novelId);
    const { volumes, appliedOrders } = applyPatchToDocument(
      document,
      payload.downstreamPlanPatches,
    );
    const requestedOrders = payload.downstreamPlanPatches.map((patch) => patch.chapterOrder);
    const missing = requestedOrders.filter((order) => !appliedOrders.includes(order));
    if (missing.length > 0) {
      throw new StateProposalDomainError({
        proposalType: "chapter_execution_plan_update",
        reason: "invalid_payload",
        message: `Downstream plan patch targets missing chapter orders: ${missing.join(", ")}.`,
      });
    }
    // 传回完整 volumes，避免 merge 语义把未列出的条目当成删除。
    await volumeService.applyWorkspaceDocumentWithinTransaction(tx, proposal.novelId, {
      ...document,
      volumes,
    });
  }

  const riskFlags = parseRiskFlags(chapter.riskFlags, proposal);
  const existingResolutions = riskFlags.divergenceResolutions
    && typeof riskFlags.divergenceResolutions === "object"
    && !Array.isArray(riskFlags.divergenceResolutions)
    ? riskFlags.divergenceResolutions as Record<string, unknown>
    : {};
  await tx.chapter.update({
    where: { id: chapter.id },
    data: {
      riskFlags: JSON.stringify({
        ...riskFlags,
        divergenceResolutions: {
          ...existingResolutions,
          // 以稳定 divergenceId 为键：同一章后续出现同类偏离时不覆盖历史（M5）。
          [payload.divergenceId]: {
            resolution: "accepted_divergence",
            kind: payload.kind,
            expected: payload.expected,
            actual: payload.actual,
            resolvedAt: new Date().toISOString(),
            stateProposalId: proposal.id ?? null,
          },
        },
      }),
    },
  });
}
