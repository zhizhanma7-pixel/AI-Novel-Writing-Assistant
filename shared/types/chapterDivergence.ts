import { z } from "zod";

/**
 * 章节执行偏离（Phase 2C）。
 *
 * 与既有 `missingObligations` 的边界：
 * - 「该写没写」（omission）一律归 `missingObligations`。
 * - 「写了，但与本章合同的明确期望方向相反或互斥」（deviation）归本模块。
 *
 * 同一个问题不得同时出现在两个数组里。
 */

/** 六类正好对应「值得创建 Proposal」的跨章影响面。 */
export const chapterDivergenceKindSchema = z.enum([
  "next_entry_state_changed",
  "cross_chapter_commitment",
  "character_life_status",
  "protected_reveal_touched",
  "payoff_timing_shifted",
  "relation_direction_reversed",
]);

/**
 * 结构化引用。阈值判定不取信 AI 自报的 kind 标签，而是拿这些引用回本章合同里
 * 精确回查——不能让被门禁的一方提供门禁的唯一入参。
 *
 * 刻意不叫 `affectedCharacterIds` / `affectedPayoffIds`：acceptance 输入里的
 * obligation 合同中，角色是姓名/说明文本，伏笔是 `operation: title` 形式的条目，
 * 都不是稳定数据库 id。若契约宣称输出 id，模型只能编造。
 */
export const chapterDivergenceReferenceSchema = z.object({
  affectedCharacterContractEntries: z.array(z.string().trim().min(1)).default([]),
  affectedPayoffContractEntries: z.array(z.string().trim().min(1)).default([]),
  touchedProtectedReveals: z.array(z.string().trim().min(1)).default([]),
  contractQuotes: z.array(z.string().trim().min(1)).default([]),
});

export const chapterDivergenceSchema = z.object({
  kind: chapterDivergenceKindSchema,
  summary: z.string().trim().min(1).max(500),
  /** 合同里的原文，供 UI 直接展示 Expected 一侧。 */
  expected: z.string().trim().min(1).max(1000),
  /** 正文实际写成什么。 */
  actual: z.string().trim().min(1).max(1000),
  evidence: z.string().trim().max(1000).nullable().optional(),
  references: chapterDivergenceReferenceSchema.default({
    affectedCharacterContractEntries: [],
    affectedPayoffContractEntries: [],
    touchedProtectedReveals: [],
    contractQuotes: [],
  }),
});

export const chapterDivergenceResolutionSchema = z.enum([
  /** 承认正文，只更新下游计划；本章原始 Expected 保留作审计证据。 */
  "accepted_divergence",
  /** 按 Expected 修正正文，走既有局部修复。 */
  "corrected_to_expected",
]);

/**
 * AI 报了偏离但引用无法回查、且一次语义重试后仍不可核验——该条被剥离，
 * 以此稳定码记入质量提醒，让用户知道「检测到但没能核验」而不是无声消失。
 */
export const UNVERIFIED_DIVERGENCE_DEBT_CODE = "unverified_cross_chapter_divergence";

/**
 * 「按计划修正」执行失败的稳定码。
 *
 * 与 `UNVERIFIED_DIVERGENCE_DEBT_CODE` 是**两种不同状况**：前者是检测阶段核验不了，
 * 后者是用户已确认要修、但修复没跑成。用同一个码会让驾驶舱和后续排查分不清。
 */
export const DIVERGENCE_CORRECTION_FAILED_DEBT_CODE = "divergence_correction_failed";

export type ChapterDivergenceKind = z.infer<typeof chapterDivergenceKindSchema>;
export type ChapterDivergenceReference = z.infer<typeof chapterDivergenceReferenceSchema>;
export type ChapterDivergence = z.infer<typeof chapterDivergenceSchema>;
export type ChapterDivergenceResolution = z.infer<typeof chapterDivergenceResolutionSchema>;

/** 本章合同中可被 `contractQuotes` 精确回查的条目集合。 */
export interface ChapterDivergenceContractEntries {
  obligationEntries: string[];
  boundaryEntries: string[];
  protectedReveals: string[];
  requiredPayoffTouches: string[];
  requiredCharacterAppearances: string[];
}

function compact(values: Array<string | null | undefined>): string[] {
  return values
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);
}

/**
 * 收集本章 Expected 合同里所有可回查的原文条目。
 *
 * 参数刻意用结构化最小形状而不是 import chapterRuntime 的完整 schema，
 * 避免 shared 内部产生循环依赖。
 */
export function collectChapterDivergenceContractEntries(input: {
  obligationContract?: {
    mustHitNow?: string[];
    mustPreserve?: string[];
    requiredPayoffTouches?: string[];
    requiredCharacterAppearances?: string[];
    requiredGoalChanges?: string[];
    canDefer?: string[];
    forbiddenCrossings?: string[];
  } | null;
  boundaryContract?: {
    exclusiveEvent?: string | null;
    entryState?: string | null;
    endingState?: string | null;
    nextChapterEntryState?: string | null;
    doNotCross?: string[];
    protectedReveals?: string[];
  } | null;
}): ChapterDivergenceContractEntries {
  const obligation = input.obligationContract ?? {};
  const boundary = input.boundaryContract ?? {};
  return {
    obligationEntries: compact([
      ...(obligation.mustHitNow ?? []),
      ...(obligation.mustPreserve ?? []),
      ...(obligation.requiredPayoffTouches ?? []),
      ...(obligation.requiredCharacterAppearances ?? []),
      ...(obligation.requiredGoalChanges ?? []),
      ...(obligation.canDefer ?? []),
      ...(obligation.forbiddenCrossings ?? []),
    ]),
    boundaryEntries: compact([
      boundary.exclusiveEvent,
      boundary.entryState,
      boundary.endingState,
      boundary.nextChapterEntryState,
      ...(boundary.doNotCross ?? []),
      ...(boundary.protectedReveals ?? []),
    ]),
    protectedReveals: compact(boundary.protectedReveals ?? []),
    requiredPayoffTouches: compact(obligation.requiredPayoffTouches ?? []),
    requiredCharacterAppearances: compact(obligation.requiredCharacterAppearances ?? []),
  };
}

/**
 * 一条偏离是否可被核验：至少有一条 `contractQuotes` 能在本章合同原文里精确命中。
 *
 * 这是 K1 的收口点——引用全空或全部无法回查的偏离不进入提案链路，
 * 由 Prompt 层触发一次语义重试，仍不可核验则显式降级为质量债。
 */
export function isVerifiableChapterDivergence(
  divergence: Pick<ChapterDivergence, "references">,
  entries: ChapterDivergenceContractEntries,
): boolean {
  const verifiable = new Set([...entries.obligationEntries, ...entries.boundaryEntries]);
  return divergence.references.contractQuotes.some((quote) => verifiable.has(quote.trim()));
}

/**
 * 「按计划修正」的结果（Phase 2C.7）。
 *
 * 放在 shared 是因为它是 HTTP 契约的一部分：界面要按这三态给出不同反馈，
 * 而 `repair_failed` **不是**服务故障——逐项仍可审阅，质量债已记下，
 * 所以它走 200 而不是 5xx。
 */
export type ChapterDivergenceCorrectionResult =
  | { status: "corrected"; chapterId: string; divergenceId: string }
  | { status: "repair_failed"; chapterId: string; divergenceId: string; reason: string }
  | { status: "conflict"; chapterId: string; divergenceId: string; reason: string };
