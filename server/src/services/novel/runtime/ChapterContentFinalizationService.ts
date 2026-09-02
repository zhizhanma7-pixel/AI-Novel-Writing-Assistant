import { createHash } from "node:crypto";
import type { ChapterRuntimePackage, GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import { novelEventBus } from "../../../events";
import { openConflictService } from "../../state/OpenConflictService";
import { directorAutomationLedgerEventService } from "../director/runtime/DirectorAutomationLedgerEventService";
import { stableDirectorContentHash } from "../director/runtime/DirectorArtifactLedger";
import { UNVERIFIED_DIVERGENCE_DEBT_CODE } from "@ai-novel/shared/types/chapterDivergence";
import { filterAcceptedFactItems, type FactLedgerExcludedItem } from "../fact/factLedgerFilter";
import { novelFactService } from "../fact/NovelFactService";
import { chapterDivergenceProposalService } from "../proposal/chapterExecution/application/ChapterDivergenceProposalService";
import { ChapterArtifactSyncService } from "./ChapterArtifactSyncService";
import type { ChapterRuntimeRequestInput } from "./chapterRuntimeSchema";
import type { StyleReviewResult } from "./PostGenerationStyleReviewRunner";
import { ChapterQualityGateService } from "./ChapterQualityGateService";
import type { ChapterTimelineFinalizationService } from "./ChapterTimelineFinalizationService";
import {
  buildRuntimePackage,
  type ChapterRuntimePlannerPort,
} from "./chapterRuntimePackageBuilders";
import {
  buildProseQualityAuditReport,
  detectProseQuality,
} from "./proseQuality/ProseQualityDetector";
import type { ChapterLifecycleService } from "./lifecycle";

export interface ChapterContentFinalizationAgentRuntime {
  finishChapterGenRun: (runId: string, summary: string, durationMs: number) => Promise<void>;
}

export interface ChapterContentFinalizationServiceDeps {
  qualityGateService: Pick<ChapterQualityGateService, "runAcceptanceGate">;
  artifactSyncService: Pick<ChapterArtifactSyncService, "syncChapterArtifacts">;
  plannerService: ChapterRuntimePlannerPort;
  agentRuntime: ChapterContentFinalizationAgentRuntime;
  timelineFinalizer: Pick<ChapterTimelineFinalizationService, "finalizeCurrentContent">;
  lifecycleService: Pick<ChapterLifecycleService, "markChapterStatus">;
  divergenceProposalService?: Pick<typeof chapterDivergenceProposalService, "createForChapter">;
  ledgerEventService?: Pick<typeof directorAutomationLedgerEventService, "recordEvent">;
  warn?: (message: string, details?: Record<string, unknown>) => void;
}

export interface FinalizeChapterContentInput {
  novelId: string;
  chapterId: string;
  request: ChapterRuntimeRequestInput;
  contextPackage: GenerationContextPackage;
  content: string;
  lengthControl?: ChapterRuntimePackage["lengthControl"];
  runId: string | null;
  startMs: number | null;
  deferArtifactBackgroundSync?: boolean;
  scheduleDeferredArtifactBackgroundSync?: boolean;
}

export interface FinalizeChapterContentResult {
  finalContent: string;
  runtimePackage: ChapterRuntimePackage;
  styleReview: StyleReviewResult;
  needsRepair: boolean;
}

export class ChapterContentFinalizationService {
  private readonly qualityGateService: Pick<ChapterQualityGateService, "runAcceptanceGate">;
  private readonly artifactSyncService: Pick<ChapterArtifactSyncService, "syncChapterArtifacts">;
  private readonly plannerService: ChapterRuntimePlannerPort;
  private readonly agentRuntime: ChapterContentFinalizationAgentRuntime;
  private readonly timelineFinalizer: Pick<ChapterTimelineFinalizationService, "finalizeCurrentContent">;
  private readonly lifecycleService: Pick<ChapterLifecycleService, "markChapterStatus">;
  private readonly divergenceProposalService: Pick<typeof chapterDivergenceProposalService, "createForChapter">;
  private readonly ledgerEventService: Pick<typeof directorAutomationLedgerEventService, "recordEvent">;
  private readonly warn: (message: string, details?: Record<string, unknown>) => void;

  constructor(deps: ChapterContentFinalizationServiceDeps) {
    this.qualityGateService = deps.qualityGateService;
    this.artifactSyncService = deps.artifactSyncService;
    this.plannerService = deps.plannerService;
    this.agentRuntime = deps.agentRuntime;
    this.timelineFinalizer = deps.timelineFinalizer;
    this.lifecycleService = deps.lifecycleService;
    this.divergenceProposalService = deps.divergenceProposalService ?? chapterDivergenceProposalService;
    this.ledgerEventService = deps.ledgerEventService ?? directorAutomationLedgerEventService;
    this.warn = deps.warn ?? console.warn;
  }

  /** 章节偏离提案是旁路：失败只能留下提醒，不能改变正文推进决定。 */
  private async produceChapterDivergenceProposal(
    input: FinalizeChapterContentInput,
    assessment: { divergences?: unknown; repairability?: string; riskTags?: unknown },
  ): Promise<void> {
    const riskTags = Array.isArray(assessment.riskTags) ? assessment.riskTags : [];
    if (riskTags.includes(UNVERIFIED_DIVERGENCE_DEBT_CODE)) {
      await this.ledgerEventService.recordEvent({
        type: "quality_issue_found",
        idempotencyKey: [
          input.request.workflowTaskId ?? "book",
          input.novelId,
          input.chapterId,
          UNVERIFIED_DIVERGENCE_DEBT_CODE,
        ].join(":"),
        taskId: input.request.workflowTaskId ?? null,
        novelId: input.novelId,
        nodeKey: "chapter.divergence.unverified",
        summary: `第 ${input.contextPackage.chapter.order} 章检测到与计划不一致的地方，`
          + "但依据无法核验，已记为待跟进提醒，不影响继续写作。",
        affectedScope: `chapter:${input.chapterId}`,
        severity: "medium",
        metadata: { code: UNVERIFIED_DIVERGENCE_DEBT_CODE, chapterId: input.chapterId },
      }).catch((error: unknown) => {
        this.warn("[chapter-divergence] failed to record unverified divergence event.", {
          novelId: input.novelId,
          chapterId: input.chapterId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    const divergences = Array.isArray(assessment.divergences) ? assessment.divergences : [];
    if (divergences.length === 0) {
      return;
    }
    const expectedSource = input.contextPackage.chapterReviewContext
      ?? input.contextPackage.chapterWriteContext
      ?? null;
    try {
      await this.divergenceProposalService.createForChapter({
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder: input.contextPackage.chapter.order,
        taskId: input.request.workflowTaskId ?? null,
        divergences: divergences as Parameters<typeof chapterDivergenceProposalService.createForChapter>[0]["divergences"],
        obligationContract: expectedSource?.obligationContract ?? null,
        boundaryContract: expectedSource?.chapterBoundary ?? null,
        repairability: assessment.repairability ?? null,
        chapterContentHash: stableDirectorContentHash(input.content),
      });
    } catch (error) {
      this.warn("[chapter-divergence] failed to produce divergence proposal.", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        divergenceCount: divergences.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async finalizeChapterContent(input: FinalizeChapterContentInput): Promise<FinalizeChapterContentResult> {
    const finalContent = input.content;
    const acceptance = await this.qualityGateService.runAcceptanceGate({
      novelId: input.novelId,
      chapterId: input.chapterId,
      contextPackage: input.contextPackage,
      content: finalContent,
      request: input.request,
    });
    const proseQualityReport = detectProseQuality(finalContent);
    const proseQualityAuditReport = buildProseQualityAuditReport({
      novelId: input.novelId,
      chapterId: input.chapterId,
      report: proseQualityReport,
    });
    const auditResult = {
      score: acceptance.score,
      issues: acceptance.issues,
      auditReports: proseQualityAuditReport
        ? [...acceptance.auditReports, proseQualityAuditReport]
        : acceptance.auditReports,
    };
    const styleReview: StyleReviewResult = {
      report: null,
      autoRewritten: false,
      originalContent: null,
      finalContent,
    };
    const activeOpenConflicts = await openConflictService.listOpenConflicts(input.novelId, {
      beforeChapterOrder: input.contextPackage.chapter.order,
      includeCurrentChapter: true,
      limit: 8,
    });
    const runtimePackage = buildRuntimePackage({
      novelId: input.novelId,
      chapterId: input.chapterId,
      request: input.request,
      contextPackage: input.contextPackage,
      finalContent,
      lengthControl: input.lengthControl,
      auditResult,
      activeOpenConflicts,
      styleReview,
      acceptance: acceptance.assessment,
      runId: input.runId,
      plannerService: this.plannerService,
    });
    await this.produceChapterDivergenceProposal(input, acceptance.assessment);
    const needsRepair = acceptance.assessment.status === "repairable"
      || acceptance.assessment.status === "needs_manual_review"
      || runtimePackage.audit.hasBlockingIssues;
    const timelineFinalization = await this.timelineFinalizer.finalizeCurrentContent({
      novelId: input.novelId,
      chapterId: input.chapterId,
      content: finalContent,
      contextPackage: input.contextPackage,
      request: input.request,
      mode: needsRepair ? "degraded" : "stable",
      sourceStage: "chapter_content_finalization",
      qualityDebt: needsRepair,
    });
    if (!timelineFinalization.checkpointWritten) {
      throw new Error("Chapter timeline finalization is still running");
    }
    await this.markChapterStatus(input.chapterId, needsRepair ? "needs_repair" : "pending_review");
    if (!needsRepair) {
      // 保证义务账本在下一章 JIT 上下文组装前完成；失败只告警，不阻断定稿返回。
      try {
        await this.writeAcceptedFacts(
          input.novelId,
          input.chapterId,
          input.runId,
          input.contextPackage,
          runtimePackage,
        );
      } catch (error) {
        console.warn("[chapter-runtime] fact ledger write failed", {
          novelId: input.novelId,
          chapterId: input.chapterId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

    }

    if (!needsRepair && input.deferArtifactBackgroundSync && input.scheduleDeferredArtifactBackgroundSync !== false) {
      await this.artifactSyncService.syncChapterArtifacts(
        input.novelId,
        input.chapterId,
        finalContent,
        {
          scheduleBackgroundSync: true,
          artifactSyncMode: input.request.artifactSyncMode,
          awaitArtifactDelta: true,
          skipLegacySummaryAndFacts: true,
          provider: input.request.provider,
          model: input.request.model,
        },
      );
    }

    await this.finishTraceRun(input.runId, finalContent.length, input.startMs);

    if (!needsRepair) {
      void novelEventBus.emit({
        type: "chapter:finalized",
        payload: {
          novelId: input.novelId,
          chapterId: input.chapterId,
          chapterOrder: input.contextPackage.chapter.order,
        },
      });
    }

    return {
      finalContent,
      runtimePackage,
      styleReview,
      needsRepair,
    };
  }

  async finishTraceRun(runId: string | null, contentLength: number, startMs: number | null): Promise<void> {
    if (!runId || startMs == null) {
      return;
    }

    try {
      await this.agentRuntime.finishChapterGenRun(
        runId,
        `chapter draft generated, ${contentLength} chars`,
        Date.now() - startMs,
      );
    } catch {
      // Ignore trace failures so chapter generation still completes.
    }
  }

  async markChapterStatus(
    chapterId: string,
    chapterStatus: "pending_generation" | "generating" | "pending_review" | "needs_repair",
  ): Promise<void> {
    await this.lifecycleService.markChapterStatus(chapterId, chapterStatus);
  }

  /**
   * 章节接收通过后，仅将验收确认已完成的 mustHitNow 义务写入事实账本。
   *
   * payoffDirectives 是写前指令，不是正文观测结果；伏笔“已揭示”事实应由
   * payoff ledger 状态迁移或 timeline gate 的 resolvedHookIds 等观测来源写入。
   */
  private async writeAcceptedFacts(
    novelId: string,
    chapterId: string,
    runId: string | null,
    contextPackage: GenerationContextPackage,
    runtimePackage: ChapterRuntimePackage,
  ): Promise<void> {
    const chapterOrder = contextPackage.chapter.order;
    const writeCtx = contextPackage.chapterWriteContext;
    if (!writeCtx) {
      return;
    }
    const obligationCoverage = runtimePackage.obligationCoverage ?? {
      status: "satisfied" as const,
      missing: [],
      summary: "旧运行记录未包含章节义务覆盖信息。",
    };
    const filtered = filterAcceptedFactItems({
      chapterOrder,
      mustHitNow: writeCtx.obligationContract?.mustHitNow ?? [],
      obligationCoverage,
      acceptanceRiskTags: runtimePackage.meta?.riskTags ?? [],
    });
    if (filtered.excluded.length > 0) {
      await this.recordExcludedFactItems({
        novelId,
        chapterId,
        chapterOrder,
        runId,
        obligationCoverageStatus: obligationCoverage.status,
        excluded: filtered.excluded,
      });
    }

    if (filtered.accepted.length === 0) {
      return;
    }
    await novelFactService.writeFacts(novelId, chapterOrder, filtered.accepted);
  }

  private async recordExcludedFactItems(input: {
    novelId: string;
    chapterId: string;
    chapterOrder: number;
    runId: string | null;
    obligationCoverageStatus: ChapterRuntimePackage["obligationCoverage"]["status"];
    excluded: FactLedgerExcludedItem[];
  }): Promise<void> {
    for (const item of input.excluded) {
      console.warn("[fact-ledger] skipped unverified chapter obligation", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        reason: item.reason,
        matchedMissingKind: item.matchedMissingKind ?? null,
        matchedMissingSummary: item.matchedMissingSummary ?? null,
        matchScore: item.matchScore ?? null,
        text: item.text,
      });
    }

    const fingerprint = createHash("sha1")
      .update(JSON.stringify(input.excluded.map((item) => ({
        text: item.text,
        reason: item.reason,
        matchedMissingKind: item.matchedMissingKind ?? null,
        matchedMissingSummary: item.matchedMissingSummary ?? null,
      }))))
      .digest("hex")
      .slice(0, 16);
    await directorAutomationLedgerEventService.recordEvent({
      type: "continue_with_risk",
      idempotencyKey: [
        input.novelId,
        input.chapterId,
        input.chapterOrder,
        "fact-ledger-obligation-filter",
        fingerprint,
      ].join(":"),
      runId: input.runId,
      novelId: input.novelId,
      nodeKey: "chapter_execution_node",
      summary: `本章 ${input.excluded.length} 条义务未由验收确认，未写入事实账本。`,
      affectedScope: `chapter:${input.chapterId}`,
      severity: "medium",
      metadata: {
        decision: "exclude_unverified_fact_items",
        chapterOrder: input.chapterOrder,
        obligationCoverageStatus: input.obligationCoverageStatus,
        excludedObligations: input.excluded,
      },
    }).catch((error) => {
      console.warn("[fact-ledger] skipped obligation exclusion event failed", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
