import type { ChapterExecutionPlanPatch } from "@ai-novel/shared/types/chapterExecutionPlan";
import type { ProposedChange } from "@ai-novel/shared/types/changeProposal";

/**
 * 可调整的计划字段。
 *
 * 顺序与 `chapterExecutionPlanPatchSchema` 一致，标签沿用界面里已有的叫法
 * （「本章目的」「独占事件」见张力曲线侧栏），不引入第二套说法。
 */
export const PLAN_PATCH_FIELDS = [
  { key: "purpose", label: "本章目的", placeholder: "这一章要完成什么" },
  { key: "endingState", label: "章末状态", placeholder: "这一章结束时的局面" },
  { key: "nextChapterEntryState", label: "下一章开场状态", placeholder: "下一章从什么局面开始" },
  { key: "exclusiveEvent", label: "独占事件", placeholder: "只在这一章发生的关键事件" },
] as const;

export type PlanPatchFieldKey = typeof PLAN_PATCH_FIELDS[number]["key"];

/** 这份提案里的这一项是不是章节偏离。 */
export function isChapterDivergenceChange(change: ProposedChange): boolean {
  return change.proposalType === "chapter_execution_plan_update";
}

interface DivergencePayloadView {
  chapterOrder: number | null;
  expected: string;
  actual: string;
  downstreamPlanPatches: ChapterExecutionPlanPatch[];
}

function readPatches(value: unknown): ChapterExecutionPlanPatch[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is ChapterExecutionPlanPatch => (
    Boolean(item)
    && typeof item === "object"
    && !Array.isArray(item)
    && typeof (item as { chapterOrder?: unknown }).chapterOrder === "number"
  ));
}

/**
 * 读出偏离项里界面要用的部分。
 *
 * 已保存过的修改优先：作者存过一版补丁后重新打开，看到的应该是自己那一版。
 */
export function readDivergencePayload(change: ProposedChange): DivergencePayloadView {
  const source = (change.userEditedPayload ?? change.payload) as Record<string, unknown> | null;
  const payload = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  return {
    chapterOrder: typeof payload.chapterOrder === "number" ? payload.chapterOrder : null,
    expected: typeof payload.expected === "string" ? payload.expected : "",
    actual: typeof payload.actual === "string" ? payload.actual : "",
    downstreamPlanPatches: readPatches(payload.downstreamPlanPatches),
  };
}

/** 把界面里编辑好的补丁写回完整载荷，其余字段原样保留。 */
export function withDownstreamPatches(
  change: ProposedChange,
  patches: ChapterExecutionPlanPatch[],
): Record<string, unknown> {
  const source = (change.userEditedPayload ?? change.payload) as Record<string, unknown> | null;
  const payload = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  return { ...payload, downstreamPlanPatches: patches };
}

export const CORRECTION_RESULT_COPY = {
  corrected: {
    title: "正文已改回原计划",
    description: "这一处不一致已经处理完，可以继续审阅其余内容。",
  },
  repair_failed: {
    title: "这次没能改回原计划",
    description: "正文没有被改动，这一条仍然可以处理，也可以改为接受这次变化。",
  },
  conflict: {
    title: "内容在处理期间发生了变化",
    description: "为避免覆盖新内容，这次改写没有保存。刷新后再试一次。",
  },
} as const;
