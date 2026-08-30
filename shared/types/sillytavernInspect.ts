import { z } from "zod";
import { sillyTavernCardSplitPlanSchema } from "./sillytavernCardSplit.js";
import { sillyTavernWorldBookPreviewSchema } from "./sillytavernWorldBookImport.js";
import { parsedSillyTavernPresetSchema } from "./sillytavernPreset.js";

/**
 * 统一导入入口的识别结果（Phase 3 / S5）。
 *
 * 用户手上往往只有一个从 SillyTavern 导出的文件，未必分得清它是角色卡、
 * 世界书还是预设。识别放在服务端，前端不重复一套判断逻辑。
 */

export const sillyTavernAssetKindSchema = z.enum([
  "character_card",
  "world_book",
  "preset",
  "unknown",
]);
export type SillyTavernAssetKind = z.infer<typeof sillyTavernAssetKindSchema>;

export const sillyTavernPresetPreviewSchema = z.object({
  parsed: parsedSillyTavernPresetSchema,
  effectiveInstructions: z.string(),
  effectiveLength: z.number().int().nonnegative(),
  enabledCount: z.number().int().nonnegative(),
  disabledCount: z.number().int().nonnegative(),
  generationParametersApplied: z.literal(false),
});
export type SillyTavernPresetPreviewPayload = z.infer<typeof sillyTavernPresetPreviewSchema>;

export const sillyTavernInspectResultSchema = z.object({
  kind: sillyTavernAssetKindSchema,
  /** 识别依据，直接展示给用户，让他能判断我们认对了没有。 */
  detectedBy: z.string(),
  /** 从 PNG 里取出时说明来自哪个关键字。 */
  extractedFrom: z.string().nullable(),
  cardPlan: sillyTavernCardSplitPlanSchema.nullable(),
  worldBookPreview: sillyTavernWorldBookPreviewSchema.nullable(),
  presetPreview: sillyTavernPresetPreviewSchema.nullable(),
});
export type SillyTavernInspectResult = z.infer<typeof sillyTavernInspectResultSchema>;
