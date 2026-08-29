import { z } from "zod";
import { chapterExecutionPlanPatchSchema } from "./chapterExecutionPlan.js";

/**
 * 「接受偏离」时给作者的下游计划建议（Phase 2C.7）。
 *
 * **这不是一条 AI 写状态的路径。** 建议只被返回给界面，作者采纳并保存后，
 * 落库走的仍是既有的用户编辑通路（`userEditedPayloadJson` + `reviewDecision: modified`），
 * 因此 `DirectorPolicyEngine` 门禁与 L0–L3 自治等级映射一律不参与，也无需参与。
 */

/**
 * AI 直接产出的扁平形状。
 *
 * 刻意与 `chapterExecutionPlanPatchSchema` 分开：那个 schema 是 `.strict()` 的
 * 可执行载荷，不收 `reason`；而建议必须带上「为什么这么改」，否则作者无从判断
 * 要不要采纳。两者的转换由 sanitizer 负责，不能让 AI 直接产出可执行载荷。
 */
export const aiChapterDivergencePlanSuggestionSchema = z.object({
  chapterOrder: z.number().int().positive(),
  purpose: z.string().trim().min(1).nullable().optional(),
  endingState: z.string().trim().min(1).nullable().optional(),
  nextChapterEntryState: z.string().trim().min(1).nullable().optional(),
  exclusiveEvent: z.string().trim().min(1).nullable().optional(),
  reason: z.string().trim().min(1),
});

export const aiChapterDivergencePlanSuggestionResultSchema = z.object({
  suggestions: z.array(aiChapterDivergencePlanSuggestionSchema).default([]),
});

/**
 * 清洗后交给界面的形状。
 *
 * `patch` 已经是可以直接放进 `downstreamPlanPatches` 的合法载荷——前端不需要
 * 自己剥字段，少一处出错的地方。
 */
export const chapterDivergencePlanSuggestionSchema = z.object({
  patch: chapterExecutionPlanPatchSchema,
  reason: z.string().trim().min(1),
  chapterTitle: z.string().nullable(),
});

export const chapterDivergencePlanSuggestionResultSchema = z.object({
  suggestions: z.array(chapterDivergencePlanSuggestionSchema),
  /** 被清洗掉的建议条数与原因，如实告诉作者 AI 给过但不可用的内容。 */
  discarded: z.array(z.object({
    chapterOrder: z.number().nullable(),
    reason: z.string(),
  })),
});

export type AiChapterDivergencePlanSuggestion =
  z.infer<typeof aiChapterDivergencePlanSuggestionSchema>;
export type AiChapterDivergencePlanSuggestionResult =
  z.infer<typeof aiChapterDivergencePlanSuggestionResultSchema>;
export type ChapterDivergencePlanSuggestion =
  z.infer<typeof chapterDivergencePlanSuggestionSchema>;
export type ChapterDivergencePlanSuggestionResult =
  z.infer<typeof chapterDivergencePlanSuggestionResultSchema>;

/** 一次最多给出的建议条数。超出的部分丢弃，避免一次改动过多下游章节。 */
export const MAX_DIVERGENCE_PLAN_SUGGESTIONS = 5;
