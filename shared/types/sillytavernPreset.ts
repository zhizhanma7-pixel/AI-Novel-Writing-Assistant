import { z } from "zod";
import { sillyTavernParseWarningSchema } from "./sillytavernCard.js";

/**
 * SillyTavern preset 的解析契约（Phase 3 / S2）。
 *
 * preset 承载的是**文风与写作行为**，不承载世界状态、人物状态或剧情状态。
 * 解析层同样只负责读，不决定它变成什么。
 */

export const sillyTavernPresetKindSchema = z.enum([
  "chat_completion",
  "text_completion",
  "unknown",
]);
export type SillyTavernPresetKind = z.infer<typeof sillyTavernPresetKindSchema>;

/**
 * 一条指令片段。
 *
 * chat completion preset 把指令拆成带 identifier 的多段（main / jailbreak /
 * nsfw / 自定义），并用 `prompt_order` 决定顺序与启停。顺序有意义——它就是
 * 作者调出来的那份写作指令的组织方式，合并时必须保持。
 */
export const sillyTavernPresetInstructionSchema = z.object({
  identifier: z.string(),
  name: z.string(),
  content: z.string(),
  enabled: z.boolean(),
  role: z.string().nullable(),
});
export type SillyTavernPresetInstruction = z.infer<typeof sillyTavernPresetInstructionSchema>;

export const parsedSillyTavernPresetSchema = z.object({
  name: z.string().nullable(),
  kind: sillyTavernPresetKindSchema,
  /** 按 `prompt_order` 排好序的指令片段；未启用的也保留，标记出来。 */
  instructions: z.array(sillyTavernPresetInstructionSchema).default([]),
  /**
   * 采样参数（temperature / top_p / ...）。
   *
   * **保留供查看，不接管模型路由。** 让一份导入的 preset 静默改写用户已配置的
   * 模型参数，会以最难察觉的方式破坏生成行为。
   */
  generationParameters: z.record(z.string(), z.number()).default({}),
  rawImportedMetadata: z.record(z.string(), z.unknown()).default({}),
  warnings: z.array(sillyTavernParseWarningSchema).default([]),
});
export type ParsedSillyTavernPreset = z.infer<typeof parsedSillyTavernPresetSchema>;

/** 已知的采样参数键。两种 preset 家族的叫法不同，都要认。 */
export const SILLYTAVERN_GENERATION_PARAMETER_KEYS = [
  "temperature",
  "temp",
  "top_p",
  "top_k",
  "top_a",
  "typical_p",
  "min_p",
  "repetition_penalty",
  "rep_pen",
  "frequency_penalty",
  "presence_penalty",
  "max_tokens",
  "openai_max_tokens",
  "genamt",
] as const;
