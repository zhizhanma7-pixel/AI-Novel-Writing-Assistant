import type {
  FaithfulOutlineResult,
  NormalizedOutlineDraft,
  OutlineFidelity,
} from "@ai-novel/shared/types/outlineWorkflow";
import {
  faithfulOutlineResultSchema,
  normalizedOutlineDraftSchema,
} from "@ai-novel/shared/types/outlineWorkflow";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { PromptAsset } from "../../core/promptTypes";

export interface OutlineImportParseInput {
  sourceText: string;
}

export interface OutlineFaithfulPolishInput {
  draft: NormalizedOutlineDraft;
  fidelity: OutlineFidelity;
  currentPlanningContext: string;
}

function validateStrictPreservation(
  output: FaithfulOutlineResult,
  input: OutlineFaithfulPolishInput,
): FaithfulOutlineResult {
  if (input.fidelity !== "strict") {
    return output;
  }
  const expected = input.draft.coreEvents
    .slice()
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
    .map((event) => event.id);
  const preserved = new Set(output.preservedEventIds);
  const chapterPositions = new Map<string, number>();
  output.chapters
    .slice()
    .sort((left, right) => left.order - right.order)
    .forEach((chapter, index) => {
      for (const eventId of chapter.sourceEventIds) {
        if (!chapterPositions.has(eventId)) chapterPositions.set(eventId, index);
      }
    });
  const missing = expected.filter((eventId) => !preserved.has(eventId) || !chapterPositions.has(eventId));
  if (missing.length > 0) {
    throw new Error(`outline_preservation_failed: missing core events ${missing.join(", ")}`);
  }
  for (let index = 1; index < expected.length; index += 1) {
    if ((chapterPositions.get(expected[index]) ?? -1) < (chapterPositions.get(expected[index - 1]) ?? -1)) {
      throw new Error(`outline_preservation_failed: event order changed at ${expected[index]}`);
    }
  }
  return output;
}

export const outlineImportParsePrompt: PromptAsset<OutlineImportParseInput, NormalizedOutlineDraft> = {
  id: "novel.outline.import.parse",
  version: "v1",
  taskType: "planner",
  mode: "structured",
  language: "zh",
  contextPolicy: { maxTokensBudget: 12_000 },
  outputSchema: normalizedOutlineDraftSchema,
  management: { productPrompt: true, editModes: ["readonly"] },
  structuredOutputHint: {
    example: {
      title: "导入大纲",
      sourceSummary: "主角在连续事件中发现真相。",
      coreEvents: [{
        id: "event_001",
        sourceText: "22 吃饭",
        sourceOrder: 0,
        inferredChapterOrder: 22,
        title: "吃饭",
        characters: [],
        causes: [],
        outcomes: [],
        confidence: 0.9,
      }],
    },
  },
  render(input) {
    return [
      new SystemMessage("你是小说大纲解析器。把用户自由文本还原为结构化核心事件，不改写、不删减、不补造事件。每个事件分配稳定且唯一的 event_XXX ID，并保持原文顺序。"),
      new HumanMessage(`请解析以下大纲。保留原文证据、显式章序、角色、因果与结果；不确定内容降低 confidence，不要猜成事实。\n\n${input.sourceText}`),
    ];
  },
};

export const outlineFaithfulPolishPrompt: PromptAsset<OutlineFaithfulPolishInput, FaithfulOutlineResult> = {
  id: "novel.outline.faithfulPolish",
  version: "v1",
  taskType: "planner",
  mode: "structured",
  language: "zh",
  contextPolicy: { maxTokensBudget: 18_000 },
  outputSchema: faithfulOutlineResultSchema,
  semanticRetryPolicy: { maxAttempts: 1 },
  postValidate: validateStrictPreservation,
  management: { productPrompt: true, editModes: ["readonly"] },
  render(input) {
    const fidelityRule = input.fidelity === "strict"
      ? "Strict：所有核心事件、原顺序、结局、关系走向和揭露点都必须保留；只补因果、情绪、铺垫、转场和拆章建议。"
      : input.fidelity === "balanced"
        ? "Balanced：可做局部结构优化，但每项结构变化必须进入影响与 warning。"
        : "Director：可主动重构，但不得隐瞒重大变化或已有正文影响。";
    return [
      new SystemMessage(`你是面向写作新手的大纲忠实润色器。${fidelityRule}\n每个 proposed chapter 必须用 sourceEventIds 指回输入事件。`),
      new HumanMessage([
        `忠实度：${input.fidelity}`,
        "当前规划上下文：",
        input.currentPlanningContext || "当前没有规划资产。",
        "结构化原始草稿：",
        JSON.stringify(input.draft, null, 2),
        "输出保留义务、保留事件 ID、章节建议、依赖影响与警告。已有正文只能标为 major 影响，不能建议静默删除或重排。",
      ].join("\n\n")),
    ];
  },
};
