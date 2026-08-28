import { prisma } from "../../../db/prisma";
import type { DbClient } from "./volumeModels";
import type { LegacyVolumeSource } from "./volumePlanUtils";

/**
 * `db` 传入调用方事务客户端时，legacy 兜底读取也在同一事务快照内完成（复审 M2）。
 * 省略时沿用全局客户端，既有调用方行为不变。
 */
export async function getLegacyVolumeSource(
  novelId: string,
  db: DbClient = prisma,
): Promise<LegacyVolumeSource> {
  const [novel, arcPlans] = await Promise.all([
    db.novel.findUnique({
      where: { id: novelId },
      select: {
        id: true,
        outline: true,
        structuredOutline: true,
        estimatedChapterCount: true,
        chapters: {
          orderBy: { order: "asc" },
          select: {
            order: true,
            title: true,
            expectation: true,
            targetWordCount: true,
            conflictLevel: true,
            revealLevel: true,
            mustAvoid: true,
            taskSheet: true,
            sceneCards: true,
          },
        },
      },
    }),
    db.storyPlan.findMany({
      where: { novelId, level: "arc" },
      orderBy: [{ createdAt: "asc" }],
      select: {
        externalRef: true,
        title: true,
        objective: true,
        phaseLabel: true,
        hookTarget: true,
        rawPlanJson: true,
      },
    }),
  ]);
  if (!novel) {
    throw new Error("小说不存在。");
  }
  return {
    outline: novel.outline,
    structuredOutline: novel.structuredOutline,
    estimatedChapterCount: novel.estimatedChapterCount,
    chapters: novel.chapters,
    arcPlans,
  };
}
