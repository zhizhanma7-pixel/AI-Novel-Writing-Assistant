import { z } from "zod";

/**
 * 「接受偏离」的可执行载荷（Phase 2C.4）。
 *
 * 口径 4：**不得改写并抹掉本章原始 Expected**。`originalExpected` 是审计证据，
 * applier 只读不写；真正被写入的只有 `downstreamPlanPatches` 指向的下游卷规划条目。
 */
/**
 * 下游计划 patch **只允许卷规划文档自有的字段**。
 *
 * `title` / `summary` / `taskSheet` / `targetWordCount` / `revealLevel` /
 * `mustAvoid` / `sceneCards` 的权威来源是 `Chapter` 数据列——
 * `NovelVolumeService.hydrateCanonicalChapterFields` 每次读取工作区时都会用
 * Chapter 行覆盖文档侧的值（`summary` 取自 `Chapter.expectation`）。
 * 若允许 patch 这些字段，写入会在下一次 hydrate 时被无声还原：apply 报成功、
 * 界面显示一次、然后变化消失。因此 schema 层直接不收，而不是留给运行期踩。
 *
 * 将来若确实需要改下游章节的 summary，必须走 Chapter 列的正式写入路径，
 * 并届时接入 `ChapterContentProtectionGuard`。
 */
export const chapterExecutionPlanPatchSchema = z.object({
  chapterOrder: z.number().int().positive(),
  purpose: z.string().trim().min(1).nullable().optional(),
  endingState: z.string().trim().min(1).nullable().optional(),
  nextChapterEntryState: z.string().trim().min(1).nullable().optional(),
  exclusiveEvent: z.string().trim().min(1).nullable().optional(),
}).strict().refine(
  (patch) => Object.keys(patch).some((key) => key !== "chapterOrder"),
  { message: "downstream patch must change at least one document-owned planning field" },
);

export const chapterExecutionPlanUpdatePayloadSchema = z.object({
  chapterId: z.string().trim().min(1),
  chapterOrder: z.number().int().positive(),
  /**
   * 稳定偏离标识，作 `riskFlags.divergenceResolutions` 的键。
   * 用 `kind` 作键会让同一章后续同类偏离覆盖历史解决记录（复审 M5）。
   */
  divergenceId: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  expected: z.string().trim().min(1),
  actual: z.string().trim().min(1),
  /**
   * 审计证据：偏离发生时本章的原始合同，原样留存供人复盘。
   *
   * 刻意用宽松 schema：applier 从不解读它的内部结构，而严格引用
   * `chapterExecutionObligationContractSchema` 会把整个 `chapterRuntime`
   * 运行时图拉进 shared 的 ESM 加载路径——该模块目前含无扩展名相对导入，
   * 在纯 ESM 下会 `ERR_MODULE_NOT_FOUND`（既有问题，见实施报告）。
   */
  originalExpected: z.record(z.string(), z.unknown()).optional(),
  /** 只有下游卷规划条目会被 patch。空数组表示只记录解决结果、不改计划。 */
  downstreamPlanPatches: z.array(chapterExecutionPlanPatchSchema).default([]),
}).passthrough();

export type ChapterExecutionPlanUpdatePayload =
  z.infer<typeof chapterExecutionPlanUpdatePayloadSchema>;
export type ChapterExecutionPlanPatch = z.infer<typeof chapterExecutionPlanPatchSchema>;
