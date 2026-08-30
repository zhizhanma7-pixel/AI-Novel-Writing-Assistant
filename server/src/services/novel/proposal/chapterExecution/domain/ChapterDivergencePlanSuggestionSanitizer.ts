import {
  chapterExecutionPlanPatchSchema,
  type ChapterExecutionPlanPatch,
} from "@ai-novel/shared/types/chapterExecutionPlan";
import {
  MAX_DIVERGENCE_PLAN_SUGGESTIONS,
  type AiChapterDivergencePlanSuggestionResult,
  type ChapterDivergencePlanSuggestionResult,
} from "@ai-novel/shared/types/chapterDivergencePlanSuggestion";

/** patch 可写的字段，与 `chapterExecutionPlanPatchSchema` 保持一致。 */
const PATCH_FIELDS = ["purpose", "endingState", "nextChapterEntryState", "exclusiveEvent"] as const;

export interface DownstreamChapterOption {
  chapterOrder: number;
  title: string | null;
}

export interface SanitizeDivergencePlanSuggestionsInput {
  result: AiChapterDivergencePlanSuggestionResult;
  /** 本章之后、真实存在的章节。sanitizer 不自己去查库。 */
  downstreamChapters: DownstreamChapterOption[];
  currentChapterOrder: number;
}

/**
 * AI 建议的确定性清洗。
 *
 * 与 `sanitizeAiReplanWindowDecision` 同一套路：**AI 的输出一律不直接使用**。
 * 这里要挡住四类东西——指向不存在或非下游章节的建议、重复目标、什么都不改的
 * 空建议、以及一次想改太多章。剩下的还要再过一遍可执行 schema 才交出去。
 *
 * 空建议是合法结果，不是错误：AI 认为下游不需要改，就该如实返回空。
 */
export function sanitizeDivergencePlanSuggestions(
  input: SanitizeDivergencePlanSuggestionsInput,
): ChapterDivergencePlanSuggestionResult {
  const titleByOrder = new Map(
    input.downstreamChapters
      .filter((chapter) => chapter.chapterOrder > input.currentChapterOrder)
      .map((chapter) => [chapter.chapterOrder, chapter.title]),
  );

  const suggestions: ChapterDivergencePlanSuggestionResult["suggestions"] = [];
  const discarded: ChapterDivergencePlanSuggestionResult["discarded"] = [];
  const usedOrders = new Set<number>();

  for (const raw of input.result.suggestions) {
    if (!titleByOrder.has(raw.chapterOrder)) {
      discarded.push({
        chapterOrder: raw.chapterOrder,
        reason: `第 ${raw.chapterOrder} 章不在本章之后的可调整范围内。`,
      });
      continue;
    }
    if (usedOrders.has(raw.chapterOrder)) {
      discarded.push({
        chapterOrder: raw.chapterOrder,
        reason: `第 ${raw.chapterOrder} 章已经有一条建议，重复的那条被丢弃。`,
      });
      continue;
    }
    if (suggestions.length >= MAX_DIVERGENCE_PLAN_SUGGESTIONS) {
      discarded.push({
        chapterOrder: raw.chapterOrder,
        reason: `一次最多调整 ${MAX_DIVERGENCE_PLAN_SUGGESTIONS} 章，多出的建议被丢弃。`,
      });
      continue;
    }

    // 只搬运 patch schema 认识的字段：AI 多写的一律丢掉，而不是让 `.strict()`
    // 在后面报一个作者看不懂的错。
    const candidate: Record<string, unknown> = { chapterOrder: raw.chapterOrder };
    for (const field of PATCH_FIELDS) {
      if (raw[field] !== undefined) {
        candidate[field] = raw[field];
      }
    }

    const parsed = chapterExecutionPlanPatchSchema.safeParse(candidate);
    if (!parsed.success) {
      discarded.push({
        chapterOrder: raw.chapterOrder,
        reason: `第 ${raw.chapterOrder} 章的建议没有给出可写入的计划字段。`,
      });
      continue;
    }

    usedOrders.add(raw.chapterOrder);
    suggestions.push({
      patch: parsed.data as ChapterExecutionPlanPatch,
      reason: raw.reason,
      chapterTitle: titleByOrder.get(raw.chapterOrder) ?? null,
    });
  }

  return { suggestions, discarded };
}
