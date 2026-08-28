import type { ReviewIssue } from "@ai-novel/shared/types/novel";
import { runChapterRepairText } from "../../../runtime/repair/chapterRepairRuntime";
import type { ChapterDivergenceRepairPort } from "../application/ChapterDivergenceCorrectionService";

/**
 * `ChapterDivergenceRepairPort` 的生产实现。
 *
 * 直接调既有 `runChapterRepairText`——**不新建修复链路**，因此既有的
 * patch/heavy 升级、修复模式与预算规则一并继承。
 *
 * 偏离以 `ChapterExecutionMissingObligation` 的形态经 `runtimePackage.obligationCoverage`
 * 传入，这正是 `buildRepairIssuesPayload` 已经在消费的字段，现有修复 Prompt 无需改动。
 */
export function createChapterDivergenceRepairAdapter(): ChapterDivergenceRepairPort {
  return {
    async repairChapter(input) {
      const issues: ReviewIssue[] = input.obligations.map((obligation) => ({
        severity: "high",
        category: "coherence",
        evidence: obligation.evidence ?? obligation.summary,
        fixSuggestion: obligation.summary,
      }));

      const executed = await runChapterRepairText({
        novelId: input.novelId,
        chapterId: input.chapterId,
        novelTitle: input.novelTitle,
        chapterTitle: input.chapterTitle,
        content: input.content,
        issues,
        // 只带 obligationCoverage：修复器据此定向补写，其余运行时字段留空，
        // 避免为了「按计划修正」伪造一份完整 runtime package。
        runtimePackage: {
          obligationCoverage: {
            status: "unmet",
            missing: input.obligations,
            summary: `本章有 ${input.obligations.length} 处与计划不一致，需要改回计划要求。`,
          },
        } as never,
        options: { repairMode: "light_repair" },
      });

      const content = executed.content?.trim();
      // 修复器可能回退成原文；原样返回等于没修，交由调用方判为失败。
      return content && content !== input.content.trim() ? { content } : null;
    },
  };
}
