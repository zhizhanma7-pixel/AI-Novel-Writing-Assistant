import { stateChangeProposalTypeSchema } from "@ai-novel/shared/types/canonicalState";
import { chapterExecutionPlanUpdatePayloadSchema } from "@ai-novel/shared/types/chapterExecutionPlan";
import type { z, ZodType } from "zod";
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
