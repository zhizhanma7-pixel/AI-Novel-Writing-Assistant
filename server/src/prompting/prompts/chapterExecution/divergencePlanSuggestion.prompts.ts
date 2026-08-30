import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AiChapterDivergencePlanSuggestionResult } from "@ai-novel/shared/types/chapterDivergencePlanSuggestion";
import { aiChapterDivergencePlanSuggestionResultSchema } from "@ai-novel/shared/types/chapterDivergencePlanSuggestion";
import { MAX_DIVERGENCE_PLAN_SUGGESTIONS } from "@ai-novel/shared/types/chapterDivergencePlanSuggestion";
import type { PromptAsset } from "../../core/promptTypes";

export interface DivergencePlanSuggestionPromptInput {
  chapterOrder: number;
  chapterTitle: string;
  divergenceKind: string;
  divergenceSummary: string;
  expected: string;
  actual: string;
  availableChapterOrdersJson: string;
  downstreamPlansJson: string;
}

export const divergencePlanSuggestionPrompt: PromptAsset<
  DivergencePlanSuggestionPromptInput,
  AiChapterDivergencePlanSuggestionResult
> = {
  id: "chapter_execution.divergence.plan_suggestion",
  version: "v1",
  taskType: "replan",
  mode: "structured",
  language: "zh",
  contextPolicy: {
    maxTokensBudget: 2000,
    preferredGroups: ["chapter_goal", "canonical_state"],
    dropOrder: ["protected_secrets"],
  },
  // 建议的理由文本会直接呈现给作者、供其决定要不要采纳，所以这是产品级
  // prompt，而不是纯内部决策器——「能在目录里检索到」不等于完成纳管声明。
  // 输出必须过确定性 sanitizer，槽位编辑会让边界失控，因此只开 readonly。
  management: {
    productPrompt: true,
    editModes: ["readonly"],
  },
  outputSchema: aiChapterDivergencePlanSuggestionResultSchema,
  render: (input) => [
    new SystemMessage([
      "你在帮长篇小说作者处理一个已经发生的情况：某一章的正文写得和原计划不一致，",
      "作者决定保留正文，于是后续章节的计划可能需要跟着调整。",
      "你的任务是判断后面哪些章节的计划需要改、改成什么，并说明理由。",
      "只输出严格 JSON，不要 Markdown、解释或额外文本。",
      "",
      "【硬性规则】",
      "1. chapterOrder 只能从 availableChapterOrders 里选，绝不能选本章或本章之前的章节。",
      "2. 每条建议只能改这四个字段：purpose、endingState、nextChapterEntryState、exclusiveEvent。",
      "   不要输出标题、摘要、字数、场景卡等任何其他字段——它们不由这里管理，写了也不会生效。",
      "3. 每条建议必须给出 reason，用作者能看懂的话说明为什么这一章要改。",
      `4. 最多给 ${MAX_DIVERGENCE_PLAN_SUGGESTIONS} 条建议，优先改紧接着的章节。`,
      "5. 同一章只能出现一次。",
      "",
      "【最重要的一条】",
      "如果后续章节的计划本来就还成立，就返回空的 suggestions 数组。",
      "不要为了显得有用而硬编改动——多余的改动会让作者的后续计划变坏，",
      "而「不需要改」本身就是一个有价值的判断。",
      "",
      "【判断依据】",
      "只依据实际发生的正文与原计划之间的差异来推断后续影响。",
      "不要臆造正文里没有的情节，也不要顺手优化你觉得写得不够好的地方。",
    ].join("\n")),
    new HumanMessage([
      `发生偏离的章节：第${input.chapterOrder}章《${input.chapterTitle}》`,
      `偏离类型：${input.divergenceKind}`,
      `偏离说明：${input.divergenceSummary}`,
      "",
      "【原计划要求】",
      input.expected,
      "",
      "【正文实际写成】",
      input.actual,
      "",
      "【可调整的后续章节序号】",
      input.availableChapterOrdersJson,
      "",
      "【这些章节现有的计划】",
      input.downstreamPlansJson,
      "",
      "请输出后续计划调整建议 JSON。若无需调整，suggestions 返回空数组。",
    ].join("\n")),
  ],
};
