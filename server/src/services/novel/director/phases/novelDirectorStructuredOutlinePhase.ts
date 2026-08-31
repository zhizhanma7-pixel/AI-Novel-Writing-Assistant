import type { VolumePlanDocument } from "@ai-novel/shared/types/novel";
import type {
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import {
  isDirectorAutoExecutionRunMode,
  isFullBookAutopilotRunMode,
} from "@ai-novel/shared/types/novelDirector";
import type { VolumeGenerationPhaseEvent } from "../../volume/volumeModels";
import { getChapterTitleDiversityIssue } from "../../volume/chapterTitleDiversity";
import { buildNovelEditResumeTarget, parseSeedPayload } from "../../workflow/novelWorkflow.shared";
import { logMemoryUsage } from "../../../../runtime/memoryTelemetry";
import {
  buildDirectorSessionState,
  normalizeDirectorRunMode,
} from "../runtime/novelDirectorHelpers";
import {
  buildChapterDetailBundleLabel,
  buildChapterDetailBundleProgress,
  DIRECTOR_PROGRESS,
  type DirectorProgressItemKey,
} from "../projections/novelDirectorProgress";
import {
  buildDirectorAutoExecutionState,
  countDirectorAutoExecutionChapterRange,
  hasDirectorSyncedChapterExecutionContext,
  normalizeDirectorAutoExecutionPlan,
  resolveDirectorAutoExecutionPlanChapterRange,
} from "../automation/novelDirectorAutoExecution";
import {
  flattenPreparedOutlineChapters,
  resolveStructuredOutlineRecoveryCursor,
  type StructuredOutlineDetailMode,
  type StructuredOutlineRecoveryCursor,
} from "../recovery/novelDirectorStructuredOutlineRecovery";
import { runDirectorTrackedStep } from "../projections/directorProgressTracker";
import type { DirectorPhaseCallbacks, DirectorPhaseDependencies } from "./novelDirectorPhaseTypes";
import { resetDirectorDownstreamChapterState } from "../recovery/novelDirectorDownstreamReset";
import { createHash } from "node:crypto";
import { novelSideEffectJobService } from "../../../../events/sideEffects";

/**
 * 角色动态重建失败后的兜底：把它排进既有的 side-effect 队列。
 *
 * 那条队列自带退避重试和死信，比在这里原地重试稳。幂等键要带上章节结构指纹——
 * 拆章再变一次就是一件新的重建，不能被上一次成功的记录挡住（成功的作业会一直
 * 留在表里，固定键会让后续重建永远排不进去）。
 */
export function buildCharacterDynamicsRebuildRecoveryKey(
  novelId: string,
  workspace: VolumePlanDocument,
): string {
  const signature = createHash("sha1")
    .update(JSON.stringify(workspace.volumes.map((volume) => [
      volume.id,
      volume.sortOrder,
      volume.chapters.map((chapter) => chapter.chapterOrder),
    ])))
    .digest("hex");
  return `character.volumeRebuild:structured_outline:${novelId}:${signature}`;
}

/** 这一轮兜底最多往后找几个键：succeeded 的记录会挡住同键，得绕过去。 */
const REBUILD_RECOVERY_MAX_KEY_PROBES = 4;

/**
 * 兜底作业的排队结果。
 *
 * `scheduled` 表示"确实有一件会被 lease 的作业在等着跑"。这是唯一能说
 * 「重建交出去了」的情况，其余都得如实说明没人管。
 */
type RebuildRecoveryOutcome =
  | { scheduled: true; idempotencyKey: string }
  | { scheduled: false; reason: "dead"; idempotencyKey: string; attempts: number; maxAttempts: number }
  | { scheduled: false; reason: "exhausted"; idempotencyKey: string };

async function enqueueCharacterDynamicsRebuildRecovery(input: {
  novelId: string;
  taskId: string;
  workspace: VolumePlanDocument;
}): Promise<RebuildRecoveryOutcome> {
  const baseKey = buildCharacterDynamicsRebuildRecoveryKey(input.novelId, input.workspace);
  let idempotencyKey = baseKey;
  for (let probe = 0; probe < REBUILD_RECOVERY_MAX_KEY_PROBES; probe += 1) {
    idempotencyKey = probe === 0 ? baseKey : `${baseKey}:retry-${probe}`;
    const { job, created } = await novelSideEffectJobService.enqueueJob({
      novelId: input.novelId,
      jobType: "character.volumeRebuild",
      idempotencyKey,
      payload: {
        novelId: input.novelId,
        sourceType: "rebuild_projection",
      },
    });
    if (created) {
      return { scheduled: true, idempotencyKey };
    }
    // 队列只 lease pending / failed，所以只有非终态的既有作业才算"已经有人管"。
    if (job && job.status !== "succeeded" && job.status !== "dead") {
      return { scheduled: true, idempotencyKey };
    }
    if (job?.status === "dead") {
      // 死信是重试预算已经用尽，不自动复活——那就失去死信的意义了。
      return {
        scheduled: false,
        reason: "dead",
        idempotencyKey,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
      };
    }
    // 剩下的只有 succeeded：那条记录修的是**上一次**的重建需求，跟这次刚发生的
    // 失败无关。成功记录会永久留在表里，而键只指纹了章节结构，所以同结构的第二次
    // 失败会被它一直挡住、静默地什么都没排。换一个键接着排。
  }
  return { scheduled: false, reason: "exhausted", idempotencyKey };
}

function buildChapterOrderRangeLabel(startOrder: number, endOrder: number): string {
  return startOrder === endOrder ? `第 ${startOrder} 章` : `第 ${startOrder}-${endOrder} 章`;
}

function buildFastStartPlanningGuidance(request: DirectorConfirmRequest): string | undefined {
  const preparation = request.startupPreparation;
  if (!preparation || preparation.strategy !== "fast_start") {
    return undefined;
  }
  return [
    "本次采用快速开篇：首个可执行节奏段只规划开篇路线，不提前锁死远期章节。",
    `首批路线必须覆盖 ${preparation.routeWindow.min}-${preparation.routeWindow.target} 章，优先形成可立即进入正文的因果链。`,
    `正文前只需要完整细化未来 ${preparation.routeWindow.detailAhead} 章，其余章节保留为简略路线。`,
  ].join("\n");
}

function findMissingSelectedChapterOrders(
  selectedOrders: number[],
  range: { startOrder: number; endOrder: number },
): number[] {
  const selected = new Set(selectedOrders);
  const missing: number[] = [];
  for (let order = range.startOrder; order <= range.endOrder; order += 1) {
    if (!selected.has(order)) {
      missing.push(order);
    }
  }
  return missing;
}

async function syncPreparedChapterExecutionContext(input: {
  novelId: string;
  workspace: VolumePlanDocument;
  targetVolumeId: string;
  targetChapterId: string;
  dependencies: DirectorPhaseDependencies;
}): Promise<void> {
  const targetVolume = input.workspace.volumes.find((volume) => volume.id === input.targetVolumeId);
  const targetChapter = targetVolume?.chapters.find((chapter) => chapter.id === input.targetChapterId);
  if (!targetChapter) {
    return;
  }
  if (!targetChapter.taskSheet?.trim() && !targetChapter.sceneCards?.trim()) {
    return;
  }

  await input.dependencies.volumeService.syncVolumeChaptersWithOptions(input.novelId, {
    volumes: input.workspace.volumes,
    preserveContent: true,
    applyDeletes: false,
    executionContractChapterRange: {
      startOrder: targetChapter.chapterOrder,
      endOrder: targetChapter.chapterOrder,
    },
  }, {
    emitEvent: false,
    syncPayoffLedger: false,
  });
}

function buildStructuredOutlinePhaseUpdate(event: VolumeGenerationPhaseEvent): {
  itemKey: DirectorProgressItemKey;
  itemLabel: string;
  progress: number;
} | null {
  if (event.scope === "beat_sheet") {
    return {
      itemKey: "beat_sheet",
      itemLabel: event.label.trim() || (event.phase === "load_context" ? "正在整理节奏板上下文" : "正在生成节奏板"),
      progress: DIRECTOR_PROGRESS.beatSheet,
    };
  }
  if (event.scope === "chapter_list") {
    return {
      itemKey: "chapter_list",
      itemLabel: event.label.trim() || (event.phase === "load_context" ? "正在整理拆章上下文" : "正在生成章节列表"),
      progress: DIRECTOR_PROGRESS.chapterList,
    };
  }
  if (event.scope === "rebalance") {
    return {
      itemKey: "chapter_list",
      itemLabel: event.label.trim() || "正在校准相邻卷衔接",
      progress: 0.8,
    };
  }
  return null;
}

function buildStructuredOutlineCursorKey(cursor: StructuredOutlineRecoveryCursor): string {
  return [
    cursor.step,
    cursor.volumeId ?? "",
    cursor.chapterId ?? "",
    cursor.detailMode ?? "",
    cursor.beatKey ?? "",
    cursor.preparedVolumeIds.length,
    cursor.selectedChapters.length,
    cursor.completedChapterCount,
    cursor.totalChapterCount,
    cursor.completedDetailSteps,
    cursor.totalDetailSteps,
  ].join("|");
}

async function persistStructuredOutlineVolumeSnapshot(input: {
  taskId: string;
  novelId: string;
  workspace: VolumePlanDocument;
  itemKey: "beat_sheet" | "chapter_list";
  scope: "beat_sheet" | "chapter_list";
  volumeId?: string | null;
  dependencies: Pick<DirectorPhaseDependencies, "volumeService">;
}): Promise<VolumePlanDocument> {
  return input.dependencies.volumeService.updateVolumesWithOptions(input.novelId, input.workspace, {
    emitEvent: false,
    syncPayoffLedger: false,
    memoryTelemetry: {
      taskId: input.taskId,
      stage: "structured_outline",
      itemKey: input.itemKey,
      scope: input.scope,
      entrypoint: "auto_director",
      volumeId: input.volumeId,
    },
  });
}

export async function runDirectorStructuredOutlinePhase(input: {
  taskId: string;
  novelId: string;
  request: DirectorConfirmRequest;
  baseWorkspace: VolumePlanDocument;
  dependencies: DirectorPhaseDependencies;
  callbacks: DirectorPhaseCallbacks;
}): Promise<void> {
  const { taskId, novelId, request, baseWorkspace, dependencies, callbacks } = input;
  logMemoryUsage({
    event: "start",
    component: "runDirectorStructuredOutlinePhase",
    taskId,
    novelId,
    stage: "structured_outline",
    scope: "structured_outline",
    entrypoint: "auto_director",
    volumeCount: baseWorkspace.volumes.length,
    chapterCount: baseWorkspace.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0),
    beatSheetCount: baseWorkspace.beatSheets.length,
  });
  const firstVolume = baseWorkspace.volumes[0];
  if (!firstVolume) {
    throw new Error("自动导演未能生成可用卷骨架。");
  }
  const detailPlan = normalizeDirectorAutoExecutionPlan(
    isDirectorAutoExecutionRunMode(normalizeDirectorRunMode(request.runMode))
      ? request.autoExecutionPlan
      : undefined,
  );
  const fastStartGuidance = buildFastStartPlanningGuidance(request);
  const sortedVolumes = baseWorkspace.volumes
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder);
  if (detailPlan.mode === "volume" && (detailPlan.volumeOrder ?? 1) > sortedVolumes.length) {
    throw new Error(`当前卷规划只有 ${sortedVolumes.length} 卷，不能直接自动执行第 ${detailPlan.volumeOrder} 卷。`);
  }

  const directorSession = buildDirectorSessionState({
    runMode: request.runMode,
    phase: "structured_outline",
    isBackgroundRunning: true,
  });
  const initialRecoveryCursor = resolveStructuredOutlineRecoveryCursor({
    workspace: baseWorkspace,
    plan: detailPlan,
    allowPartialChapterListReady: isDirectorAutoExecutionRunMode(normalizeDirectorRunMode(request.runMode)),
  });
  const runningResumeTarget = buildNovelEditResumeTarget({
    novelId,
    taskId,
    stage: "structured",
    volumeId: initialRecoveryCursor.volumeId ?? firstVolume.id,
    chapterId: initialRecoveryCursor.chapterId,
  });
  await dependencies.workflowService.bootstrapTask({
    workflowTaskId: taskId,
    novelId,
    lane: "auto_director",
    title: request.candidate.workingTitle,
    seedPayload: callbacks.buildDirectorSeedPayload(request, novelId, {
      directorSession,
      resumeTarget: runningResumeTarget,
    }),
  });

  let workspace = baseWorkspace;
  let previousCursorKey: string | null = null;
  while (true) {
    const recoveryCursor = resolveStructuredOutlineRecoveryCursor({
      workspace,
      plan: detailPlan,
      allowPartialChapterListReady: isDirectorAutoExecutionRunMode(normalizeDirectorRunMode(request.runMode)),
    });
    const cursorKey = buildStructuredOutlineCursorKey(recoveryCursor);
    if (cursorKey === previousCursorKey) {
      throw new Error("自动导演结构化大纲恢复没有推进，请检查章节规划生成结果后重试。");
    }
    previousCursorKey = cursorKey;

    if (recoveryCursor.step === "beat_sheet") {
      const targetVolume = workspace.volumes.find((volume) => volume.id === recoveryCursor.volumeId);
      if (!targetVolume) {
        throw new Error("自动导演恢复时缺少待生成节奏板的目标卷。");
      }
      workspace = await runDirectorTrackedStep({
        taskId,
        stage: "structured_outline",
        itemKey: "beat_sheet",
        itemLabel: `正在生成第 ${targetVolume.sortOrder} 卷节奏板`,
        progress: DIRECTOR_PROGRESS.beatSheet,
        volumeId: targetVolume.id,
        callbacks,
        run: async ({ updateStatus, signal }) => dependencies.volumeService.generateVolumes(novelId, {
          provider: request.provider,
          model: request.model,
          temperature: request.temperature,
          scope: "beat_sheet",
          guidance: fastStartGuidance,
          targetVolumeId: targetVolume.id,
          draftWorkspace: workspace,
          taskId,
          entrypoint: "auto_director",
          signal,
          onPhaseStart: async (event) => {
            const update = buildStructuredOutlinePhaseUpdate(event);
            if (!update) {
              return;
            }
            await updateStatus(update);
          },
        }),
      });
      workspace = await persistStructuredOutlineVolumeSnapshot({
        taskId,
        novelId,
        workspace,
        itemKey: "beat_sheet",
        scope: "beat_sheet",
        volumeId: targetVolume.id,
        dependencies,
      });
      continue;
    }

    if (recoveryCursor.step === "chapter_list") {
      const targetVolume = workspace.volumes.find((volume) => volume.id === recoveryCursor.volumeId);
      if (!targetVolume) {
        throw new Error("自动导演恢复时缺少待拆章的目标卷。");
      }
      if (!recoveryCursor.beatKey) {
        throw new Error("自动导演恢复时缺少待生成章节的目标节奏段。");
      }
      const targetBeatKey = recoveryCursor.beatKey;
      workspace = await runDirectorTrackedStep({
        taskId,
        stage: "structured_outline",
        itemKey: "chapter_list",
        itemLabel: `正在生成第 ${targetVolume.sortOrder} 卷章节列表`,
        progress: DIRECTOR_PROGRESS.chapterList,
        volumeId: targetVolume.id,
        callbacks,
        run: async ({ updateStatus, signal }) => dependencies.volumeService.generateVolumes(novelId, {
          provider: request.provider,
          model: request.model,
          temperature: request.temperature,
          scope: "chapter_list",
          guidance: fastStartGuidance,
          targetVolumeId: targetVolume.id,
          generationMode: "single_beat",
          targetBeatKey,
          draftWorkspace: workspace,
          taskId,
          entrypoint: "auto_director",
          signal,
          persistIntermediateDocuments: true,
          onPhaseStart: async (event) => {
            const update = buildStructuredOutlinePhaseUpdate(event);
            if (!update) {
              return;
            }
            await updateStatus(update);
          },
          onIntermediateDocument: async (event) => {
            workspace = event.document;
          },
        }),
      });
      const preparedVolume = workspace.volumes.find((item) => item.id === targetVolume.id);
      const titleDiversityIssue = preparedVolume
        ? getChapterTitleDiversityIssue(preparedVolume.chapters.map((chapter) => chapter.title))
        : null;
      if (titleDiversityIssue) {
        throw new Error(titleDiversityIssue);
      }
      workspace = await persistStructuredOutlineVolumeSnapshot({
        taskId,
        novelId,
        workspace,
        itemKey: "chapter_list",
        scope: "chapter_list",
        volumeId: targetVolume.id,
        dependencies,
      });
      await dependencies.workflowService.markTaskRunning(taskId, {
        stage: "structured_outline",
        itemKey: "chapter_list",
        itemLabel: `第 ${targetVolume.sortOrder} 卷章节列表已生成`,
        progress: DIRECTOR_PROGRESS.chapterList,
        volumeId: targetVolume.id,
      });
      continue;
    }

    if (recoveryCursor.step === "chapter_detail_bundle") {
      // 懒规划模式（JIT）：全书自动执行时跳过预生成 task sheet，
      // 改为执行前即时生成（见 ChapterPlanJITService）。
      if (isFullBookAutopilotRunMode(request.runMode)) {
        break;
      }

      const targetDetailMode = recoveryCursor.detailMode as StructuredOutlineDetailMode | null;
      if (
        !recoveryCursor.chapterId
        || !recoveryCursor.volumeId
        || !targetDetailMode
        || recoveryCursor.nextChapterIndex == null
      ) {
        throw new Error("自动导演恢复时缺少章节细化所需游标。");
      }
      const targetVolumeId = recoveryCursor.volumeId;
      const targetChapterId = recoveryCursor.chapterId;
      const targetChapterIndex = recoveryCursor.nextChapterIndex;
      workspace = await runDirectorTrackedStep({
        taskId,
        stage: "structured_outline",
        itemKey: "chapter_detail_bundle",
        itemLabel: buildChapterDetailBundleLabel(
          targetChapterIndex + 1,
          recoveryCursor.totalChapterCount,
          targetDetailMode,
        ),
        progress: buildChapterDetailBundleProgress(
          recoveryCursor.completedDetailSteps,
          recoveryCursor.totalDetailSteps,
        ),
        chapterId: targetChapterId,
        volumeId: targetVolumeId,
        callbacks,
        run: async ({ signal }) => dependencies.volumeService.generateVolumes(novelId, {
          provider: request.provider,
          model: request.model,
          temperature: request.temperature,
          scope: "chapter_detail",
          targetVolumeId,
          targetChapterId,
          detailMode: targetDetailMode,
          chapterTaskSheetQualityMode: isFullBookAutopilotRunMode(request.runMode)
            ? "full_book_autopilot"
            : "ai_copilot",
          draftWorkspace: workspace,
          taskId,
          entrypoint: "auto_director",
          signal,
        }),
      });
      workspace = await dependencies.volumeService.updateVolumesWithOptions(novelId, workspace, {
        volumeUpdateReason: "chapter_execution_contract_refined",
        syncPayoffLedger: false,
        memoryTelemetry: {
          taskId,
          stage: "structured_outline",
          itemKey: "chapter_detail_bundle",
          scope: "chapter_detail",
          entrypoint: "auto_director",
          volumeId: recoveryCursor.volumeId,
          chapterId: recoveryCursor.chapterId,
        },
      });
      await syncPreparedChapterExecutionContext({
        novelId,
        workspace,
        targetVolumeId,
        targetChapterId,
        dependencies,
      });
      continue;
    }

    if (recoveryCursor.step === "chapter_sync" || recoveryCursor.step === "completed") {
      break;
    }
  }

  const preparedVolumeIds = resolveStructuredOutlineRecoveryCursor({
    workspace,
    plan: detailPlan,
    allowPartialChapterListReady: isDirectorAutoExecutionRunMode(normalizeDirectorRunMode(request.runMode)),
  }).preparedVolumeIds;
  const maxPreparedChapterOrder = Math.max(
    0,
    ...flattenPreparedOutlineChapters(workspace).map((chapter) => chapter.chapterOrder),
  );
  const targetChapterRange = resolveDirectorAutoExecutionPlanChapterRange(detailPlan);
  const allowIncrementalExecutionWindow = isDirectorAutoExecutionRunMode(normalizeDirectorRunMode(request.runMode));
  if (targetChapterRange && maxPreparedChapterOrder < targetChapterRange.endOrder && !allowIncrementalExecutionWindow) {
    throw new Error(
      `当前已生成的章节规划最多只覆盖到第 ${maxPreparedChapterOrder} 章，不能直接自动执行${buildChapterOrderRangeLabel(targetChapterRange.startOrder, targetChapterRange.endOrder)}。`,
    );
  }

  await callbacks.markDirectorTaskRunning(
    taskId,
    "structured_outline",
    "chapter_sync",
    "正在同步已准备章节到执行区",
    DIRECTOR_PROGRESS.chapterSync,
  );
  logMemoryUsage({
    event: "before_sync_write",
    component: "runDirectorStructuredOutlinePhase",
    taskId,
    novelId,
    stage: "structured_outline",
    itemKey: "chapter_sync",
    scope: "structured_outline",
    entrypoint: "auto_director",
    volumeCount: workspace.volumes.length,
    chapterCount: workspace.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0),
    beatSheetCount: workspace.beatSheets.length,
  });
  const persistedOutlineWorkspace = await dependencies.volumeService.updateVolumesWithOptions(novelId, workspace, {
    volumeUpdateReason: "chapter_execution_contract_refined",
    syncPayoffLedger: false,
    memoryTelemetry: {
      taskId,
      stage: "structured_outline",
      itemKey: "chapter_sync",
      scope: "structured_outline",
      entrypoint: "auto_director",
    },
  });
  await dependencies.volumeService.syncVolumeChaptersWithOptions(novelId, {
    volumes: persistedOutlineWorkspace.volumes,
    // Structured outline sync refreshes execution contracts; generated prose stays protected.
    preserveContent: true,
    applyDeletes: false,
    executionContractChapterRange: targetChapterRange ?? undefined,
  }, {
    emitEvent: false,
    syncPayoffLedger: false,
  });
  // 拆章刚落库，角色动态里的 plannedChapterOrders / isCoreInVolume /
  // volumeResponsibility 全都基于旧的章节规划，必须按新结构重投影一次。
  // 上面那次同步是 emitEvent: false，事件驱动的 character.volumeRebuild
  // side-effect job 接不上，所以这里只能显式重建，不能靠事件兜底。
  await dependencies.characterDynamicsService.rebuildDynamics(novelId, {
    sourceType: "rebuild_projection",
  }).catch(async (error) => {
    console.warn(
      `[director.structured_outline] event=character_dynamics_rebuild_failed taskId=${taskId} novelId=${novelId} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
    );
    // 只记一行日志是不够的：投影会停在旧的章节规划上，而正文执行照样往下跑，
    // 角色的 plannedChapterOrders / isCoreInVolume 会一路错到成稿。交给既有的
    // side-effect 队列重试（退避 + 死信），至少能自己恢复。
    // 幂等键带上章节结构指纹：拆章再变一次就是一件新的重建，不能被上一次的
    // 成功记录挡住。
    const recovery = await enqueueCharacterDynamicsRebuildRecovery({
      novelId,
      taskId,
      workspace: persistedOutlineWorkspace,
    });
    if (!recovery.scheduled) {
      // 没排上就是没人管。这里必须拒绝完成，让导演任务进入既有恢复链；只写日志
      // 会让正文继续读取旧的 plannedChapterOrders / isCoreInVolume。
      const recoveryDetails = recovery.reason === "dead"
        ? `死信已耗尽 ${recovery.attempts}/${recovery.maxAttempts} 次重试`
        : "可用幂等键已耗尽";
      throw new Error(
        `角色动态投影重建失败，且兜底作业无法排队（${recoveryDetails}；key=${recovery.idempotencyKey}）。`,
      );
    }
  });

  const syncCursor = resolveStructuredOutlineRecoveryCursor({
    workspace: persistedOutlineWorkspace,
    plan: detailPlan,
    allowPartialChapterListReady: allowIncrementalExecutionWindow,
  });
  const selectedChapters = syncCursor.selectedChapters;
  if (selectedChapters.length === 0) {
    throw new Error("自动导演未能准备出可执行的章节范围。");
  }
  const selectedChapterOrders = selectedChapters.map((chapter) => chapter.chapterOrder).sort((left, right) => left - right);
  if (targetChapterRange && !allowIncrementalExecutionWindow) {
    const missingOrders = findMissingSelectedChapterOrders(selectedChapterOrders, targetChapterRange);
    if (missingOrders.length > 0) {
      throw new Error(
        `自动导演已准备的章节规划缺少第 ${missingOrders.slice(0, 5).join("、")} 章，不能直接自动执行${buildChapterOrderRangeLabel(targetChapterRange.startOrder, targetChapterRange.endOrder)}。`,
      );
    }
  }
  const autoExecutionScopeLabel = syncCursor.scopeLabel;
  const downstreamResetRange = {
    startOrder: selectedChapterOrders[0] ?? 1,
    endOrder: selectedChapterOrders[selectedChapterOrders.length - 1] ?? selectedChapterOrders[0] ?? 1,
  };
  await resetDirectorDownstreamChapterState(novelId, downstreamResetRange);

  await callbacks.markDirectorTaskRunning(
    taskId,
    "structured_outline",
    "chapter_detail_bundle",
    `${autoExecutionScopeLabel}细化已完成，正在同步章节执行资源`,
    DIRECTOR_PROGRESS.chapterDetailDone,
    {
      chapterId: selectedChapters[0]?.id ?? null,
      volumeId: selectedChapters[0]?.volumeId ?? null,
    },
  );
  const persistedChapters = await dependencies.novelContextService.listChapters(novelId);
  if (persistedChapters.length === 0) {
    throw new Error("自动导演已生成拆章结果，但章节资源没有成功同步到执行区。");
  }
  const persistedChapterByOrder = new Map(persistedChapters.map((chapter) => [chapter.order, chapter] as const));
  // 懒规划（JIT）模式：task sheet 尚未预生成属预期状态，跳过执行上下文完整性检查。
  // 非 autopilot 路径仍做完整性检查，确保手动执行有完整 task sheet。
  if (!isFullBookAutopilotRunMode(request.runMode)) {
    const missingExecutionContextOrders = selectedChapterOrders.filter((order) => {
      const chapter = persistedChapterByOrder.get(order);
      return !chapter || !hasDirectorSyncedChapterExecutionContext(chapter);
    });
    if (missingExecutionContextOrders.length > 0) {
      throw new Error(
        `${autoExecutionScopeLabel}还有第 ${missingExecutionContextOrders.slice(0, 5).join("、")} 章缺少已同步的章节执行上下文，不能直接进入章节执行。请先补齐基础章节信息。`,
      );
    }
  }

  await dependencies.novelContextService.updateNovel(novelId, {
    projectStatus: "in_progress",
    storylineStatus: "in_progress",
    outlineStatus: "in_progress",
  });

  const autoExecutionState = buildDirectorAutoExecutionState({
    range: {
      startOrder: selectedChapterOrders[0] ?? 1,
      endOrder: selectedChapterOrders[selectedChapterOrders.length - 1] ?? selectedChapterOrders[0] ?? 1,
      totalChapterCount: targetChapterRange
        ? countDirectorAutoExecutionChapterRange(targetChapterRange)
        : selectedChapters.length,
      firstChapterId: selectedChapters[0]?.id ?? null,
    },
    chapters: persistedChapters.map((chapter) => ({
      id: chapter.id,
      order: chapter.order,
      content: chapter.content ?? null,
      conflictLevel: chapter.conflictLevel ?? null,
      revealLevel: chapter.revealLevel ?? null,
      targetWordCount: chapter.targetWordCount ?? null,
      mustAvoid: chapter.mustAvoid ?? null,
      taskSheet: chapter.taskSheet ?? null,
      sceneCards: chapter.sceneCards ?? null,
      generationState: chapter.generationState ?? null,
      chapterStatus: chapter.chapterStatus ?? null,
    })),
    plan: detailPlan,
    scopeLabel: autoExecutionScopeLabel,
    volumeTitle: detailPlan.mode === "volume" ? selectedChapters[0]?.volumeTitle ?? null : null,
    preparedVolumeIds,
    beatChapterListReady: syncCursor.beatChapterListReady,
    volumeChapterListComplete: syncCursor.volumeChapterListComplete,
  });

  const [currentTask, currentNovel] = await Promise.all([
    dependencies.workflowService.getTaskByIdWithoutHealing?.(taskId),
    dependencies.novelContextService.getNovelById(novelId).catch(() => null),
  ]);
  const currentSeed = parseSeedPayload<{ productionExperience?: unknown }>(currentTask?.seedPayloadJson);
  const selectedProductionExperience = currentSeed?.productionExperience === "simple"
    || currentSeed?.productionExperience === "professional"
    ? currentSeed.productionExperience
    : (currentNovel as { creationExperience?: unknown } | null)?.creationExperience === "simple"
      ? "simple"
      : null;
  const continueSimpleProduction = selectedProductionExperience === "simple";
  const pausedSession = buildDirectorSessionState({
    runMode: request.runMode,
    phase: "chapter_execution",
    isBackgroundRunning: continueSimpleProduction,
  });
  const chapterResumeTarget = buildNovelEditResumeTarget({
    novelId,
    taskId,
    stage: "chapter",
    volumeId: selectedChapters[0]?.volumeId ?? firstVolume.id,
    chapterId: selectedChapters[0]?.id ?? null,
  });
  await dependencies.workflowService.recordCheckpoint(taskId, {
    stage: "chapter_execution",
    checkpointType: continueSimpleProduction ? "chapter_batch_ready" : "production_experience_required",
    checkpointSummary: continueSimpleProduction
      ? `《${request.candidate.workingTitle.trim() || request.title?.trim() || "当前项目"}》的开篇路线已准备好，AI 将开始生成正文。`
      : `《${request.candidate.workingTitle.trim() || request.title?.trim() || "当前项目"}》已完成前期准备，请选择正文生产方式。`,
    itemLabel: continueSimpleProduction
      ? `${autoExecutionScopeLabel}开篇路线已就绪，正在开始第 1 章`
      : `${autoExecutionScopeLabel}已可开写，等待选择生产方式`,
    volumeId: selectedChapters[0]?.volumeId ?? firstVolume.id,
    chapterId: selectedChapters[0]?.id ?? null,
    progress: DIRECTOR_PROGRESS.chapterBatchReady,
    seedPayload: callbacks.buildDirectorSeedPayload(request, novelId, {
      directorSession: pausedSession,
      resumeTarget: chapterResumeTarget,
      autoExecution: autoExecutionState,
      startupPreparation: request.startupPreparation,
      ...(continueSimpleProduction ? { productionExperience: "simple" } : {}),
    }),
  });
  logMemoryUsage({
    event: "done",
    component: "runDirectorStructuredOutlinePhase",
    taskId,
    novelId,
    stage: "structured_outline",
    itemKey: continueSimpleProduction ? "chapter_batch_ready" : "production_experience_required",
    scope: autoExecutionScopeLabel,
    entrypoint: "auto_director",
    volumeCount: persistedOutlineWorkspace.volumes.length,
    chapterCount: persistedOutlineWorkspace.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0),
    beatSheetCount: persistedOutlineWorkspace.beatSheets.length,
  });
}
