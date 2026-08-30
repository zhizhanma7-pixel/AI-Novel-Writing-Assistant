import { z } from "zod";
import { sillyTavernParseWarningSchema } from "./sillytavernCard.js";
import { sillyTavernWorldBookPreviewSchema } from "./sillytavernWorldBookImport.js";

/**
 * 角色卡的分流契约（Phase 3 / S4）。
 *
 * **这一层是整个 Phase 3 的产品主张所在。** 角色卡在格式上长得像"一个角色"，
 * 但作者往往把世界设定、语气要求和写作约束都塞在 `description` / `scenario` 里。
 * 直接映射成一个角色实体，等于把世界观埋进角色字段。
 *
 * 所以导入不是映射，是**分流**：把卡片切成段，每段各自决定去世界设定、
 * 写法资产还是角色。
 */

export const sillyTavernSegmentDestinationSchema = z.enum([
  /** 世界设定 → 知识库，可绑定到书或世界，全局可复用。 */
  "world",
  /** 文风与写作约束 → 写法资产。 */
  "style",
  /** 真正的角色事实 → 角色，必须归属某本书。 */
  "character",
  /** 不导入。 */
  "skip",
]);
export type SillyTavernSegmentDestination = z.infer<typeof sillyTavernSegmentDestinationSchema>;

/** 建议是怎么来的：字段本身就能定的，还是需要人判断的。 */
export const sillyTavernSuggestionOriginSchema = z.enum(["deterministic", "needs_review"]);
export type SillyTavernSuggestionOrigin = z.infer<typeof sillyTavernSuggestionOriginSchema>;

export const sillyTavernCardSegmentSchema = z.object({
  /** 稳定标识，形如 `description:1`，用户提交决定时按它对应。 */
  id: z.string(),
  sourceField: z.string(),
  /** 字段的中文名，直接展示。 */
  sourceLabel: z.string(),
  text: z.string(),
  suggestedDestination: sillyTavernSegmentDestinationSchema,
  /** 为什么这么建议，给用户看。 */
  reason: z.string(),
  origin: sillyTavernSuggestionOriginSchema,
});
export type SillyTavernCardSegment = z.infer<typeof sillyTavernCardSegmentSchema>;

export const sillyTavernCardSplitPlanSchema = z.object({
  cardName: z.string(),
  segments: z.array(sillyTavernCardSegmentSchema),
  /**
   * 卡片内嵌的世界书。它的归属是确定的（世界设定），不参与分流，
   * 但要让用户看到卡片里带了多少世界观。
   */
  embeddedBook: sillyTavernWorldBookPreviewSchema.nullable(),
  /** 需要用户逐段判断的数量——这类段落是这张卡最容易被导错的部分。 */
  needsReviewCount: z.number().int().nonnegative(),
  /**
   * 有内容但不参与分流的字段（卡片元信息）。
   *
   * 列出来是为了让界面能说明「这些没被导入」；静默丢弃会让人以为进去了。
   */
  ignoredFields: z.array(z.object({
    field: z.string(),
    label: z.string(),
    reason: z.string(),
  })).default([]),
  warnings: z.array(sillyTavernParseWarningSchema).default([]),
});
export type SillyTavernCardSplitPlan = z.infer<typeof sillyTavernCardSplitPlanSchema>;

export const sillyTavernSegmentDecisionSchema = z.object({
  segmentId: z.string(),
  destination: sillyTavernSegmentDestinationSchema,
});
export type SillyTavernSegmentDecision = z.infer<typeof sillyTavernSegmentDecisionSchema>;

export const sillyTavernCardApplyResultSchema = z.object({
  /** 世界设定去处；没有分到世界的段落时为 null。 */
  knowledgeDocumentId: z.string().nullable(),
  knowledgeUnchanged: z.boolean(),
  /** 文风去处。 */
  styleProfileId: z.string().nullable(),
  /** 角色去处。角色必须归属一本书，所以只有给了 novelId 才会写。 */
  characterId: z.string().nullable(),
  appliedCounts: z.object({
    world: z.number().int().nonnegative(),
    style: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
});
export type SillyTavernCardApplyResult = z.infer<typeof sillyTavernCardApplyResultSchema>;
