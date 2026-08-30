import { z } from "zod";
import { sillyTavernParseWarningSchema } from "./sillytavernCard.js";

/**
 * World Book 导入的预览契约（Phase 3 / S3）。
 *
 * 走 Semantic Mode：条目进既有知识库与 RAG 检索，**不实现关键词注入引擎**。
 * 同时维护两套检索机制会让「为什么这条没被检索到」永远说不清。
 * 原文里的 `keys` 作为检索提示写进正文，让既有的语义检索能命中。
 */

export const sillyTavernWorldBookPreviewSchema = z.object({
  bookName: z.string().nullable(),
  entryCount: z.number().int().nonnegative(),
  /** 会进入知识库正文、参与检索的条目数。 */
  includedCount: z.number().int().nonnegative(),
  /** 在原文件里被关掉的条目数：不进检索，但在预览里列出来。 */
  excludedCount: z.number().int().nonnegative(),
  /** 原文标记为常驻的条目数，仅作提示。 */
  constantCount: z.number().int().nonnegative(),
  content: z.string(),
  charCount: z.number().int().nonnegative(),
  warnings: z.array(sillyTavernParseWarningSchema).default([]),
});
export type SillyTavernWorldBookPreview = z.infer<typeof sillyTavernWorldBookPreviewSchema>;

export const sillyTavernWorldBookImportResultSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  versionNumber: z.number().int().positive(),
  /**
   * 内容与当前版本完全一致，因此没有建新版本、也没有重新排队索引。
   * 重复导入同一本世界书是常见操作，不该每次都产生一份新版本。
   */
  unchanged: z.boolean(),
  preview: sillyTavernWorldBookPreviewSchema,
});
export type SillyTavernWorldBookImportResult =
  z.infer<typeof sillyTavernWorldBookImportResultSchema>;
