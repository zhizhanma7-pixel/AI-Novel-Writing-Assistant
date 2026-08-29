import type { ChapterExecutionPlanPatch } from "@ai-novel/shared/types/chapterExecutionPlan";

export type DownstreamPatchViolationCode =
  | "not_downstream"
  | "unknown_chapter"
  | "duplicate_chapter";

export interface DownstreamPatchViolation {
  code: DownstreamPatchViolationCode;
  chapterOrder: number;
  message: string;
}

export interface DownstreamPatchBoundaryInput {
  /** 发生偏离的那一章。补丁只能落在它之后。 */
  currentChapterOrder: number;
  patches: ChapterExecutionPlanPatch[];
  /** 这本书真实存在的章节序号。 */
  existingChapterOrders: Iterable<number>;
}

/**
 * 下游补丁的边界规则，**唯一来源**。
 *
 * schema 只管形状：它拦得住多余字段和空补丁，拦不住「改第 1 章」这种越界，
 * 也拦不住同一份载荷里两条补丁指向同一章——后者会在 applier 的
 * `new Map(patches.map(...))` 里被后一条静默覆盖，作者看到的和写进去的不是
 * 一回事，而且 `missing` 检查发现不了（重复的 order 同样命中章节）。
 *
 * 编辑期和 apply 期都调这里：前者让作者当场知道填错了，后者是最终可执行
 * 载荷的边界（复审 M4 的口径——校验必须放在真正写入的那一层）。
 * 返回违规列表而不是直接抛，是因为两处要包成各自的领域错误类型。
 */
export function findDownstreamPatchViolations(
  input: DownstreamPatchBoundaryInput,
): DownstreamPatchViolation[] {
  const existing = new Set(input.existingChapterOrders);
  const violations: DownstreamPatchViolation[] = [];
  const seen = new Set<number>();

  for (const patch of input.patches) {
    const { chapterOrder } = patch;
    if (seen.has(chapterOrder)) {
      violations.push({
        code: "duplicate_chapter",
        chapterOrder,
        message: `第 ${chapterOrder} 章出现了多条调整，请合并成一条。`,
      });
      continue;
    }
    seen.add(chapterOrder);

    if (chapterOrder <= input.currentChapterOrder) {
      violations.push({
        code: "not_downstream",
        chapterOrder,
        message: `第 ${chapterOrder} 章不在这一章之后，只能调整后续章节。`,
      });
      continue;
    }
    if (!existing.has(chapterOrder)) {
      violations.push({
        code: "unknown_chapter",
        chapterOrder,
        message: `第 ${chapterOrder} 章不存在。`,
      });
    }
  }

  return violations;
}
