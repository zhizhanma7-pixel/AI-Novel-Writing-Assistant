import type {
  AiChapterDivergencePlanSuggestionResult,
  ChapterDivergencePlanSuggestionResult,
} from "@ai-novel/shared/types/chapterDivergencePlanSuggestion";
import { prisma } from "../../../../../db/prisma";
import { runStructuredPrompt } from "../../../../../prompting/core/promptRunner";
import {
  divergencePlanSuggestionPrompt,
  type DivergencePlanSuggestionPromptInput,
} from "../../../../../prompting/prompts/chapterExecution/divergencePlanSuggestion.prompts";
import { NovelVolumeService } from "../../../volume/NovelVolumeService";
import { ChangeProposalError } from "../../domain/ChangeProposalError";
import {
  sanitizeDivergencePlanSuggestions,
  type DownstreamChapterOption,
} from "../domain/ChapterDivergencePlanSuggestionSanitizer";

/**
 * 下游计划建议的生成端口。
 *
 * 抽成端口是为了让本服务可以在没有 LLM 的情况下测试——特别是那条
 * 「建议过程不写任何库」的回归，它必须能确定性地跑。
 */
export interface DivergencePlanSuggestionPort {
  suggest(
    input: DivergencePlanSuggestionPromptInput,
  ): Promise<AiChapterDivergencePlanSuggestionResult>;
}

export interface SuggestDivergencePlanInput {
  novelId: string;
  proposalId: string;
  /** 要为哪一条偏离生成建议。 */
  changeId: string;
}

interface SuggestionDeps {
  suggestionPort?: DivergencePlanSuggestionPort;
  volumeService?: Pick<NovelVolumeService, "readWorkspaceWithinTransaction">;
  db?: typeof prisma;
}

/** 一次最多喂给模型多少章下游计划，避免上下文膨胀。 */
const DOWNSTREAM_CONTEXT_WINDOW = 10;

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function compactJson(value: unknown, maxLength = 6000): string {
  const text = JSON.stringify(value ?? null);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function createDefaultSuggestionPort(): DivergencePlanSuggestionPort {
  return {
    async suggest(input) {
      const result = await runStructuredPrompt({
        asset: divergencePlanSuggestionPrompt,
        promptInput: input,
        options: {
          temperature: 0.3,
          stage: "chapter_execution_divergence_plan_suggestion",
          triggerReason: input.divergenceKind,
        },
      });
      return result.output;
    },
  };
}

/**
 * 为一条待审的偏离生成「后续章节该怎么改」的建议。
 *
 * **本服务从不写库。** 它读提案、读卷规划工作区（只读事务，`skipSelfHeal`），
 * 调一次模型，清洗后把结果交给界面。作者采纳后的落库走既有的用户编辑通路，
 * 因此这里不构成一条 AI 自主写状态的路径，也不需要经过 `DirectorPolicyEngine`。
 * 这条性质由 `chapterDivergencePlanSuggestionRealSqlite` 的行数回归守着。
 */
export class ChapterDivergencePlanSuggestionService {
  private readonly suggestionPort: DivergencePlanSuggestionPort;
  private readonly db: typeof prisma;
  private volumeServiceInstance: Pick<NovelVolumeService, "readWorkspaceWithinTransaction"> | null;

  constructor(deps: SuggestionDeps = {}) {
    this.suggestionPort = deps.suggestionPort ?? createDefaultSuggestionPort();
    this.db = deps.db ?? prisma;
    this.volumeServiceInstance = deps.volumeService ?? null;
  }

  private get volumeService(): Pick<NovelVolumeService, "readWorkspaceWithinTransaction"> {
    this.volumeServiceInstance ??= new NovelVolumeService();
    return this.volumeServiceInstance;
  }

  async suggest(input: SuggestDivergencePlanInput): Promise<ChapterDivergencePlanSuggestionResult> {
    const proposal = await this.db.changeProposal.findFirst({
      where: { id: input.proposalId, novelId: input.novelId },
      include: { changes: true },
    });
    if (!proposal) {
      throw new ChangeProposalError("not_found", "Change proposal not found.");
    }
    if (proposal.status !== "draft" && proposal.status !== "pending_review") {
      throw new ChangeProposalError(
        "invalid_transition",
        `Suggestions are only available while the proposal is under review (current: ${proposal.status}).`,
      );
    }

    const change = proposal.changes.find((item) => item.id === input.changeId);
    if (!change) {
      throw new ChangeProposalError("not_found", "Proposed change not found in this proposal.");
    }
    if (change.proposalType !== "chapter_execution_plan_update") {
      throw new ChangeProposalError(
        "unsupported_change",
        "Downstream plan suggestions only apply to chapter execution divergences.",
      );
    }

    const payload = parseJsonRecord(change.payloadJson);
    const chapterOrder = typeof payload.chapterOrder === "number" ? payload.chapterOrder : null;
    const expected = typeof payload.expected === "string" ? payload.expected : "";
    const actual = typeof payload.actual === "string" ? payload.actual : "";
    if (!chapterOrder || !expected || !actual) {
      throw new ChangeProposalError(
        "invalid_review",
        "Divergence payload is missing the chapter order or the expected/actual pair.",
      );
    }

    const document = await this.db.$transaction((tx) => (
      this.volumeService.readWorkspaceWithinTransaction(tx, input.novelId)
    ));

    const planned = document.volumes
      .flatMap((volume) => volume.chapters ?? [])
      .filter((chapter) => chapter.chapterOrder > chapterOrder)
      .sort((left, right) => left.chapterOrder - right.chapterOrder)
      .slice(0, DOWNSTREAM_CONTEXT_WINDOW);

    const downstreamChapters: DownstreamChapterOption[] = planned.map((chapter) => ({
      chapterOrder: chapter.chapterOrder,
      title: chapter.title ?? null,
    }));

    if (downstreamChapters.length === 0) {
      // 没有后续章节可调整时不必调用模型。
      return { suggestions: [], discarded: [] };
    }

    const currentChapter = document.volumes
      .flatMap((volume) => volume.chapters ?? [])
      .find((chapter) => chapter.chapterOrder === chapterOrder);

    const aiResult = await this.suggestionPort.suggest({
      chapterOrder,
      chapterTitle: currentChapter?.title ?? `第${chapterOrder}章`,
      divergenceKind: typeof payload.kind === "string" ? payload.kind : "unknown",
      divergenceSummary: change.summary ?? "",
      expected,
      actual,
      availableChapterOrdersJson: compactJson(
        downstreamChapters.map((chapter) => chapter.chapterOrder),
      ),
      downstreamPlansJson: compactJson(planned.map((chapter) => ({
        chapterOrder: chapter.chapterOrder,
        title: chapter.title ?? null,
        purpose: chapter.purpose ?? null,
        endingState: chapter.endingState ?? null,
        nextChapterEntryState: chapter.nextChapterEntryState ?? null,
        exclusiveEvent: chapter.exclusiveEvent ?? null,
      }))),
    });

    return sanitizeDivergencePlanSuggestions({
      result: aiResult,
      downstreamChapters,
      currentChapterOrder: chapterOrder,
    });
  }
}
