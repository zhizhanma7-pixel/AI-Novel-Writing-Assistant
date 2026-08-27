import { createHash } from "node:crypto";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import {
  outlineImportRequestSchema,
  type FaithfulOutlineResult,
  type NormalizedOutlineDraft,
  type OutlineImportRequest,
} from "@ai-novel/shared/types/outlineWorkflow";
import { prisma } from "../../../../../db/prisma";
import { runStructuredPrompt } from "../../../../../prompting/core/promptRunner";
import {
  outlineFaithfulPolishPrompt,
  outlineImportParsePrompt,
} from "../../../../../prompting/prompts/novel/outlineWorkflow.prompts";
import { probeChapterPlanImpacts } from "../../../planning/guards/ChapterContentProtectionGuard";
import { aiChangeProposalProducerService } from "../../runtime/AiChangeProposalProducerService";

type StructuredPromptRunner = typeof runStructuredPrompt;
type ProposalProducer = Pick<typeof aiChangeProposalProducerService, "produce">;

function hashText(value: string | null | undefined): string {
  return createHash("sha256").update(value ?? "", "utf8").digest("hex");
}

export class OutlineImportProposalService {
  constructor(
    private readonly promptRunner: StructuredPromptRunner = runStructuredPrompt,
    private readonly proposalProducer: ProposalProducer = aiChangeProposalProducerService,
  ) {}

  async propose(novelId: string, rawInput: unknown) {
    const input = outlineImportRequestSchema.parse(rawInput);
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: { id: true, title: true, outline: true, structuredOutline: true },
    });
    if (!novel) throw new Error("小说不存在。");
    const chapters = await prisma.chapter.findMany({
      where: { novelId },
      orderBy: { order: "asc" },
      select: { id: true, order: true, title: true, content: true, expectation: true },
    });
    const options = {
      provider: input.provider as LLMProvider | undefined,
      model: input.model,
      temperature: input.temperature,
      novelId,
      taskId: input.taskId ?? undefined,
      stage: "outline_import",
      entrypoint: "outline_import",
    };
    const parsed = await this.promptRunner({
      asset: outlineImportParsePrompt,
      promptInput: { sourceText: input.sourceText },
      options: { ...options, itemKey: "parse" },
    });
    const currentPlanningContext = JSON.stringify({
      title: novel.title,
      outline: novel.outline,
      structuredOutline: novel.structuredOutline,
      chapters: chapters.map((chapter) => ({
        order: chapter.order,
        title: chapter.title,
        summary: chapter.expectation,
        hasContent: Boolean(chapter.content?.trim()),
      })),
    });
    const polished = await this.promptRunner({
      asset: outlineFaithfulPolishPrompt,
      promptInput: {
        draft: parsed.output as NormalizedOutlineDraft,
        fidelity: input.fidelity,
        currentPlanningContext,
      },
      options: { ...options, itemKey: "faithful_polish" },
    });
    const result = polished.output as FaithfulOutlineResult;
    const existingByOrder = new Map(chapters.map((chapter) => [chapter.order, chapter]));
    const changedExistingChapters = result.chapters.flatMap((chapter) => {
      const existing = existingByOrder.get(chapter.order);
      if (!existing) return [];
      const changed = existing.title !== chapter.title || (existing.expectation ?? "") !== chapter.summary;
      if (!changed) return [];
      return [{ chapter, existing }];
    });
    const probedImpacts = await probeChapterPlanImpacts({
      novelId,
      mutations: changedExistingChapters.map(({ existing }) => ({
        operation: "update_plan_fields",
        chapterId: existing.id,
        currentChapterOrder: existing.order,
        fields: ["title", "expectation", "taskSheet"],
      })),
    });
    const probedImpactByChapterId = new Map(probedImpacts.map((impact) => [impact.chapterId, impact]));
    const deterministicImpacts = changedExistingChapters.map(({ chapter, existing }) => {
      const impact = probedImpactByChapterId.get(existing.id);
      return {
        chapterOrder: chapter.order,
        summary: impact?.hasExistingContent
          ? `第 ${chapter.order} 章已有正文；应用后只更新标题和规划，不删除或移动正文。`
          : `第 ${chapter.order} 章的标题或规划将更新。`,
        severity: impact?.severityFloor ?? "minor",
        hasExistingContent: impact?.hasExistingContent ?? false,
      };
    });
    const impacts = [...result.dependencyImpacts, ...deterministicImpacts];
    const severity = impacts.some((impact) => impact.severity === "major") ? "major" : "minor";
    const sourceRefs = chapters.map((chapter) => ({
      kind: "chapter" as const,
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      contentHash: hashText(chapter.content),
      label: chapter.title,
    }));
    const production = await this.proposalProducer.produce(novelId, {
      chapterId: null,
      taskId: input.taskId ?? null,
      proposalType: "outline_edit",
      outlineFidelity: input.fidelity,
      summary: `按${input.fidelity === "strict" ? "严格忠实" : input.fidelity === "balanced" ? "平衡优化" : "导演重构"}方式导入大纲，共 ${result.chapters.length} 章。`,
      reasoningSummary: result.polishedSummary,
      sourceRefs,
      warnings: impacts.map((impact) => ({
        code: impact.hasExistingContent ? "existing_chapter_content" : "outline_dependency_impact",
        summary: impact.summary,
        severity: impact.severity,
        sourceRefs: impact.chapterOrder == null
          ? []
          : sourceRefs.filter((ref) => ref.chapterOrder === impact.chapterOrder),
      })),
      expectedState: {
        coreEventIds: parsed.output.coreEvents.map((event) => event.id),
        preservationObligations: result.preservationObligations,
      },
      changes: [{
        proposalType: "outline_plan_update",
        path: "outline.plan",
        operation: novel.structuredOutline ? "replace" : "add",
        category: "outline",
        severity,
        before: novel.structuredOutline ? "现有大纲与章节规划" : null,
        payload: {
          fidelity: input.fidelity,
          sourceText: input.sourceText,
          polishedSummary: result.polishedSummary,
          preservationObligations: result.preservationObligations,
          chapters: result.chapters,
          dependencyImpacts: impacts,
        },
        reason: "将 AI 解析和忠实润色结果写入正式卷章规划。",
        sourceRefs,
        evidence: parsed.output.coreEvents.map((event) => event.sourceText),
      }],
    });
    return { draft: parsed.output, polished: { ...result, dependencyImpacts: impacts }, ...production };
  }
}

export const outlineImportProposalService = new OutlineImportProposalService();
