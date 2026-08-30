import { stateChangeProposalTypeSchema } from "@ai-novel/shared/types/canonicalState";
import { chapterExecutionPlanUpdatePayloadSchema } from "@ai-novel/shared/types/chapterExecutionPlan";
import type { z, ZodType } from "zod";
import { prisma } from "../../../../db/prisma";
import { findDownstreamPatchViolations } from "../chapterExecution/domain/ChapterExecutionPatchBoundary";
import { ChangeProposalError } from "./ChangeProposalError";

/**
 * 编辑期的逐项 payload 校验。
 *
 * 此前 `editProposedChange` 只校验输入信封，任意 JSON 对象都会被存进
 * `userEditedPayloadJson`，直到 apply 时 applier 解析失败才报错——作者点了
 * 「批准」才知道自己填错了。
 *
 * **刻意只登记 `chapter_execution_plan_update`。** 其他类型有历史数据，
 * 贸然开校验会让过去存下的 payload 在编辑时突然不合法；等各自需要结构化
 * 编辑入口时再逐个登记。这里少即是安全：没登记的类型行为与从前逐字一致。
 */
type StateChangeProposalType = z.infer<typeof stateChangeProposalTypeSchema>;

const EDIT_TIME_PAYLOAD_SCHEMAS: Partial<Record<StateChangeProposalType, ZodType>> = {
  chapter_execution_plan_update: chapterExecutionPlanUpdatePayloadSchema,
};

export function assertEditablePayloadShape(
  proposalType: StateChangeProposalType,
  payload: unknown,
): void {
  const schema = EDIT_TIME_PAYLOAD_SCHEMAS[proposalType];
  if (!schema) {
    return;
  }
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return;
  }
  const issues = parsed.error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  throw new ChangeProposalError(
    "invalid_review",
    `Edited value cannot be executed as ${proposalType}. ${issues.join("; ")}`,
    { proposalType, issues },
  );
}

/**
 * 编辑期的边界校验。
 *
 * 形状对不代表边界对：`chapterExecutionPlanPatchSchema` 拦不住「改第 1 章」
 * 或同一份载荷里两条补丁指向同一章。规则本身在
 * `ChapterExecutionPatchBoundary`，这里只负责取出这本书真实存在的章节序号
 * 并把违规包成审阅错误。
 */
export async function assertEditablePayloadBoundaries(
  proposalType: StateChangeProposalType,
  payload: unknown,
  context: { novelId: string; db: Pick<typeof prisma, "chapter"> },
): Promise<void> {
  if (proposalType !== "chapter_execution_plan_update") {
    return;
  }
  const parsed = chapterExecutionPlanUpdatePayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.downstreamPlanPatches.length === 0) {
    // 形状问题已由 `assertEditablePayloadShape` 报过，这里不重复报。
    return;
  }

  const chapters = await context.db.chapter.findMany({
    where: { novelId: context.novelId },
    select: { order: true },
  });
  const violations = findDownstreamPatchViolations({
    currentChapterOrder: parsed.data.chapterOrder,
    patches: parsed.data.downstreamPlanPatches,
    existingChapterOrders: chapters.map((chapter) => chapter.order),
  });
  if (violations.length > 0) {
    throw new ChangeProposalError(
      "invalid_review",
      violations.map((violation) => violation.message).join(" "),
      { violations },
    );
  }
}
