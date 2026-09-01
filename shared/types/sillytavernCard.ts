import { z } from "zod";

/**
 * SillyTavern 角色卡与世界书的解析契约（Phase 3）。
 *
 * **这里只描述「读进来的是什么」，不描述「它该变成什么」。** 角色卡里的内容
 * 往往是世界设定与文风要求，而不是一个角色的属性；去向由后续的分流提案决定，
 * 不在解析层写死映射。
 */

/** 卡片规范版本。`unknown` 表示能读出结构但版本号不认识——降级解析，不假装成功。 */
export const sillyTavernCardSpecSchema = z.enum(["v1", "v2", "v3", "unknown"]);
export type SillyTavernCardSpec = z.infer<typeof sillyTavernCardSpecSchema>;

export const sillyTavernParseWarningCodeSchema = z.enum([
  "unknown_spec_version",
  "legacy_v1_layout",
  "missing_required_field",
  "unreadable_character_book",
  "dropped_unparsable_entry",
  "empty_content",
  "duplicate_worldbook_entry",
]);
export type SillyTavernParseWarningCode = z.infer<typeof sillyTavernParseWarningCodeSchema>;

export const sillyTavernParseWarningSchema = z.object({
  code: sillyTavernParseWarningCodeSchema,
  /** 面向用户的中文说明，界面直接展示。 */
  message: z.string(),
  field: z.string().nullable().default(null),
});
export type SillyTavernParseWarning = z.infer<typeof sillyTavernParseWarningSchema>;

/**
 * 世界书条目。
 *
 * 字段名保持 SillyTavern 的下划线原样——这是外部格式的忠实映射，
 * 改成驼峰只会让对照原始文件时多一层翻译。
 */
export const sillyTavernBookEntrySchema = z.object({
  keys: z.array(z.string()).default([]),
  secondary_keys: z.array(z.string()).default([]),
  content: z.string().default(""),
  enabled: z.boolean().default(true),
  insertion_order: z.number().default(0),
  constant: z.boolean().default(false),
  selective: z.boolean().default(false),
  name: z.string().nullable().default(null),
  comment: z.string().nullable().default(null),
  priority: z.number().nullable().default(null),
}).passthrough();
export type SillyTavernBookEntry = z.infer<typeof sillyTavernBookEntrySchema>;

export const sillyTavernBookSchema = z.object({
  name: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  entries: z.array(sillyTavernBookEntrySchema).default([]),
}).passthrough();
export type SillyTavernBook = z.infer<typeof sillyTavernBookSchema>;

/**
 * 角色卡正文字段。
 *
 * 全部可空：外部文件不保证完整，缺字段应当降级并告警，而不是解析失败。
 */
export const sillyTavernCardDataSchema = z.object({
  name: z.string().default(""),
  description: z.string().default(""),
  personality: z.string().default(""),
  scenario: z.string().default(""),
  first_mes: z.string().default(""),
  mes_example: z.string().default(""),
  creator_notes: z.string().default(""),
  system_prompt: z.string().default(""),
  post_history_instructions: z.string().default(""),
  alternate_greetings: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  creator: z.string().default(""),
  character_version: z.string().default(""),
  /** V2/V3 可以内嵌一本世界书——角色卡携带世界观的主要形式。 */
  character_book: sillyTavernBookSchema.nullable().default(null),
}).passthrough();
export type SillyTavernCardData = z.infer<typeof sillyTavernCardDataSchema>;

export const parsedSillyTavernCardSchema = z.object({
  spec: sillyTavernCardSpecSchema,
  /** 文件自称的版本号，原样保留（如 "2.0"）。 */
  specVersion: z.string().nullable(),
  data: sillyTavernCardDataSchema,
  /**
   * schema 不认识的字段，原样留存。
   *
   * 外部格式会继续演进，丢字段是不可逆的数据损失；宁可留一份读不懂的原文，
   * 也不要在导入时悄悄扔掉。
   */
  rawImportedMetadata: z.record(z.string(), z.unknown()).default({}),
  warnings: z.array(sillyTavernParseWarningSchema).default([]),
});
export type ParsedSillyTavernCard = z.infer<typeof parsedSillyTavernCardSchema>;

/** 独立的世界书文件（.json lorebook），不带角色卡外壳。 */
export const parsedSillyTavernBookSchema = z.object({
  book: sillyTavernBookSchema,
  rawImportedMetadata: z.record(z.string(), z.unknown()).default({}),
  warnings: z.array(sillyTavernParseWarningSchema).default([]),
});
export type ParsedSillyTavernBook = z.infer<typeof parsedSillyTavernBookSchema>;

/** 解析层认识的字段，其余进 `rawImportedMetadata`。 */
export const SILLYTAVERN_KNOWN_CARD_FIELDS = [
  "name",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
  "system_prompt",
  "post_history_instructions",
  "alternate_greetings",
  "tags",
  "creator",
  "character_version",
  "character_book",
] as const;
