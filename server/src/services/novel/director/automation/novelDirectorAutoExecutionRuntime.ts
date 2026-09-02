import type {
  DirectorAutoExecutionState,
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import { isFullBookAutopilotRunMode } from "@ai-novel/shared/types/novelDirector";
import {
  buildDirectorAutoExecutionPausedLabel,
  buildDirectorAutoExecutionPausedSummary,
  buildDirectorAutoExecutionScopeLabelFromState,
  buildDirectorAutoExecutionStageLabel,
  buildDirectorAutoExecutionPipelineOptions,
  resolveDirectorAutoExecutionWorkflowState,
  type DirectorAutoExecutionChapterRef,
  type DirectorAutoExecutionRange,
} from "./novelDirectorAutoExecution";
import {
  recordCompletedCheckpoint,
  recordQualityRepairCheckpoint,
  resolveQualityRepairNoticeAction,
  syncAutoExecutionTaskState,
  type AutoExecutionResumeStage,
} from "./novelDirectorAutoExecutionCheckpointRuntime";
import { isSkippableAutoExecutionReviewFailure } from "./novelDirectorAutoExecutionFailure";
import {
  buildFailureCircuitBreaker,
  isDirectorCircuitBreakerOpen,
  resolveUsageCircuitBreaker,
  stopAutoExecutionForCircuitBreaker,
  withCircuitBreakerState,
} from "./novelDirectorAutoExecutionCircuitBreakerRuntime";
import {
  isNoChaptersToGenerateError,
  resolveSingleChapterExecutionRange,
  shouldClearAutoExecutionCheckpoint,
} from "./novelDirectorAutoExecutionRuntimeUtils";
import { prepareRequestedAutoExecution as prepareRequestedAutoExecutionState, resolveAutoExecutionRuntimeRangeAndState, shouldStopAutoExecution } from "./novelDirectorAutoExecutionRuntimePreparation";
import type { NovelDirectorAutoExecutionRuntimeDeps, PipelineJobSnapshot } from "./novelDirectorAutoExecutionRuntimePorts";
import { prisma } from "../../../../db/prisma";

export class NovelDirectorAutoExecutionRuntime {
  constructor(private readonly deps: NovelDirectorAutoExecutionRuntimeDeps) {}

  async prepareRequestedAutoExecution(
    input: Parameters<typeof prepareRequestedAutoExecutionState>[1],
  ) {
    return prepareRequestedAutoExecutionState(this.deps, input);
  }

  async runFromReady(input: {
    taskId: string;
    novelId: string;
    request: DirectorConfirmRequest;
    existingPipelineJobId?: string | null;
    existingState?: DirectorAutoExecutionState | null;
    resumeCheckpointType?: "chapter_batch_ready" | "replan_required" | null;
    resumeStage?: AutoExecutionResumeStage;
    previousFailureMessage?: string | null;
    allowSkipReviewBlockedChapter?: boolean;
    approveAutoExecutionScope?: boolean;
    skipCurrentQualityRepair?: boolean;
    resumePendingManualRecovery?: boolean;
  }): Promise<void> {
    const allowLazyChapterPlanning = isFullBookAutopilotRunMode(input.request.runMode);
    let { range, autoExecution, pipelineJobId } = await prepareRequestedAutoExecutionState(this.deps, {
      novelId: input.novelId,
      request: input.request,
      existingState: input.existingState,
      existingPipelineJobId: input.existingPipelineJobId,
      previousFailureMessage: input.previousFailureMessage,
      allowSkipReviewBlockedChapter: input.allowSkipReviewBlockedChapter,
    });
    let knownPipelineJob: PipelineJobSnapshot = null;
    if (pipelineJobId) {
      knownPipelineJob = await this.deps.novelService.getPipelineJobById(pipelineJobId);
      if (knownPipelineJob?.pendingManualRecovery && input.resumePendingManualRecovery) {
        await this.deps.novelService.resumePipelineJob(knownPipelineJob.id);
        knownPipelineJob = await this.deps.novelService.getPipelineJobById(knownPipelineJob.id);
      }
      if (!knownPipelineJob || ["failed", "cancelled"].includes(knownPipelineJob.status)) {
        pipelineJobId = "";
        ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
          novelId: input.novelId,
          existingState: {
            ...autoExecution,
            pipelineJobId: null,
            pipelineStatus: null,
            circuitBreaker: null,
          },
          pipelineJobId: null,
          pipelineStatus: "queued",
          allowLazyChapterPlanning,
        }));
      }
    }
    if (isDirectorCircuitBreakerOpen(autoExecution.circuitBreaker)) {
      // 治理可能判「带警告继续」：那时任务已被重新拉起并处于运行态，直接 return
      // 会让它停在"显示运行中但永远不再推进"的状态。拿到 continuedState 就接着跑。
      const continuedState = await stopAutoExecutionForCircuitBreaker(this.deps, {
        taskId: input.taskId,
        novelId: input.novelId,
        request: input.request,
        range,
        autoExecution,
        circuitBreaker: autoExecution.circuitBreaker,
        resumeStage: input.resumeStage,
      });
      if (!continuedState) {
        return;
      }
      autoExecution = continuedState;
    }

    await syncAutoExecutionTaskState(this.deps, {
        taskId: input.taskId,
        novelId: input.novelId,
        request: input.request,
        range,
        autoExecution,
        isBackgroundRunning: true,
        resumeStage: input.resumeStage,
      });
      if (await shouldStopAutoExecution(this.deps, input.taskId, pipelineJobId || null)) {
        return;
      }

      if (pipelineJobId) {
        const existingJob = knownPipelineJob ?? await this.deps.novelService.getPipelineJobById(pipelineJobId);
        knownPipelineJob = existingJob;
        if (!existingJob || ["failed", "cancelled"].includes(existingJob.status)) {
          pipelineJobId = "";
        }
      }

      const activeRangeJob = await this.deps.novelService.findActivePipelineJobForRange(
        input.novelId,
        resolveSingleChapterExecutionRange(range, autoExecution).startOrder,
        resolveSingleChapterExecutionRange(range, autoExecution).endOrder,
        pipelineJobId || null,
      );
      if (activeRangeJob) {
        pipelineJobId = activeRangeJob.id;
        ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
          novelId: input.novelId,
          existingState: autoExecution,
          pipelineJobId,
          pipelineStatus: activeRangeJob.status,
          allowLazyChapterPlanning,
        }));
        await syncAutoExecutionTaskState(this.deps, {
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range,
          autoExecution,
          isBackgroundRunning: true,
          resumeStage: input.resumeStage,
        });
      }

      autoExecutionLoop:
      while (true) {
      if (!pipelineJobId) {
        ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
          novelId: input.novelId,
          existingState: autoExecution,
          pipelineJobId: null,
          pipelineStatus: "queued",
          allowLazyChapterPlanning,
        }));
        if ((autoExecution.remainingChapterCount ?? 0) === 0) {
          await recordCompletedCheckpoint(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            pipelineStatus: "succeeded",
          });
          return;
        }

        await this.deps.workflowService.markTaskRunning(input.taskId, {
          stage: "chapter_execution",
          itemKey: "chapter_execution",
          itemLabel: buildDirectorAutoExecutionStageLabel(autoExecution),
          progress: 0.93,
          clearCheckpoint: shouldClearAutoExecutionCheckpoint(input.resumeCheckpointType),
        });
        try {
          const job = await this.deps.novelService.startPipelineJob(
            input.novelId,
            buildDirectorAutoExecutionPipelineOptions({
              provider: input.request.provider,
              model: input.request.model,
              temperature: input.request.temperature,
              workflowTaskId: input.taskId,
              taskStyleProfileId: input.request.styleProfileId,
              controlAdvanceMode: isFullBookAutopilotRunMode(input.request.runMode)
                ? "full_book_autopilot"
                : "auto_to_execution",
              ...resolveSingleChapterExecutionRange(range, autoExecution),
              autoReview: autoExecution.autoReview,
              autoRepair: autoExecution.autoRepair,
              artifactSyncMode: autoExecution.artifactSyncMode,
            }),
          );
          pipelineJobId = job.id;
          autoExecution = {
            ...autoExecution,
            pipelineJobId: job.id,
            pipelineStatus: job.status,
          };
        } catch (error) {
          if (!isNoChaptersToGenerateError(error)) {
            throw error;
          }
          ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
            novelId: input.novelId,
            existingState: autoExecution,
            pipelineJobId: null,
            pipelineStatus: "succeeded",
            allowLazyChapterPlanning,
          }));
          if ((autoExecution.remainingChapterCount ?? 0) === 0) {
            await recordCompletedCheckpoint(this.deps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              pipelineStatus: "succeeded",
            });
            return;
          }
          throw error;
        }
        await syncAutoExecutionTaskState(this.deps, {
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range,
          autoExecution,
          isBackgroundRunning: true,
          resumeStage: input.resumeStage,
        });
      }

      // 当前这个 pipeline job 是为哪一章跑的。失败熔断被治理放行后要靠它判断
      // "还能不能往前走"：下一章要是还等于它，继续就等于原地重跑同一章。
      const activeJobChapterId = autoExecution.nextChapterId ?? null;
      const activeJobChapterOrder = autoExecution.nextChapterOrder ?? null;
      while (pipelineJobId) {
        if (await shouldStopAutoExecution(this.deps, input.taskId, pipelineJobId)) {
          return;
        }
        const job = await this.deps.novelService.getPipelineJobById(pipelineJobId);
        if (!job) {
          throw new Error("自动执行章节批次时未能找到对应的批量任务。");
        }
        if (job.pendingManualRecovery) {
          const failureMessage = job.error?.trim() || "章节批次已暂停，等待人工确认后继续。";
          ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
            novelId: input.novelId,
            existingState: autoExecution,
            pipelineJobId,
            pipelineStatus: job.status,
            allowLazyChapterPlanning,
          }));
          await this.deps.workflowService.requeueTaskForRecovery(input.taskId, failureMessage, {
            stage: "quality_repair",
            itemKey: "quality_repair",
            itemLabel: buildDirectorAutoExecutionPausedLabel(autoExecution),
            checkpointType: "chapter_batch_ready",
            checkpointSummary: failureMessage,
            chapterId: autoExecution.nextChapterId ?? range.firstChapterId,
            progress: job.progress,
          });
          await syncAutoExecutionTaskState(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            isBackgroundRunning: false,
            resumeStage: "pipeline",
          });
          return;
        }
        if (job.status === "queued" || job.status === "running") {
          const runningState = resolveDirectorAutoExecutionWorkflowState(job, range, autoExecution);
          await this.deps.workflowService.markTaskRunning(input.taskId, {
            ...runningState,
            clearCheckpoint: shouldClearAutoExecutionCheckpoint(input.resumeCheckpointType),
          });
          ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
            novelId: input.novelId,
            existingState: autoExecution,
            pipelineJobId,
            pipelineStatus: job.status,
            allowLazyChapterPlanning,
          }));
          await syncAutoExecutionTaskState(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            isBackgroundRunning: true,
            resumeStage: "pipeline",
          });
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }

        ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
          novelId: input.novelId,
          existingState: autoExecution,
          pipelineJobId,
          pipelineStatus: job.status,
          allowLazyChapterPlanning,
        }));
        const usageCircuitBreaker = await resolveUsageCircuitBreaker({
          taskId: input.taskId,
          novelId: input.novelId,
          autoExecution,
        });
        if (usageCircuitBreaker) {
          autoExecution = withCircuitBreakerState(autoExecution, usageCircuitBreaker);
          if (isDirectorCircuitBreakerOpen(usageCircuitBreaker)) {
            const continuedState = await stopAutoExecutionForCircuitBreaker(this.deps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              circuitBreaker: usageCircuitBreaker,
              resumeStage: "pipeline",
            });
            if (!continuedState) {
              return;
            }
            // 放行后回到循环头继续下一章。这里不会空转的原因是用量记录去重：
            // 合闸后的状态保留了 lastUsageRecordId，下一轮 recordUsageAnomalySignal
            // 看到同一条记录会直接返回原状态、不再开闸。
            // （不要指望 issue 治理来兜底：resolveDirectorIssueDecision 是纯函数，
            // 既不查历史也不看 fingerprint，fingerprint 只用于事件幂等。）
            autoExecution = continuedState;
            continue autoExecutionLoop;
          }
          await syncAutoExecutionTaskState(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            isBackgroundRunning: true,
            resumeStage: "pipeline",
          });
        }

        if (job.status === "succeeded" && job.noticeSummary?.trim()) {
          const qualityIssueChapter = await this.resolveQualityIssueChapter(input.novelId, job);
          const noticeAction = await resolveQualityRepairNoticeAction(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            pipelineJobId,
            pipelineStatus: job.status,
            noticeCode: job.noticeCode,
            noticeSummary: job.noticeSummary.trim(),
            payload: job.payload,
            approveAutoExecutionScope: input.approveAutoExecutionScope,
            skipCurrentQualityRepair: input.skipCurrentQualityRepair,
            qualityIssueChapter,
          });
          if (noticeAction.action === "auto_continue") {
            pipelineJobId = "";
            ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
              novelId: input.novelId,
              existingState: noticeAction.checkpointState,
              pipelineJobId: null,
              pipelineStatus: "queued",
              allowLazyChapterPlanning,
            }));
            await syncAutoExecutionTaskState(this.deps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              isBackgroundRunning: true,
              resumeStage: "pipeline",
            });
            continue autoExecutionLoop;
          }

          await recordQualityRepairCheckpoint(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            // The risk decision is part of the checkpoint snapshot so every
            // recovery surface reads the same explanation immediately.
            autoExecution: noticeAction.checkpointState,
            pipelineJobId,
            pipelineStatus: job.status,
            checkpointType: noticeAction.checkpointType,
            pauseMessage: job.noticeSummary.trim(),
            qualityRepairRisk: noticeAction.qualityRepairRisk,
          });
          await syncAutoExecutionTaskState(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution: noticeAction.checkpointState,
            isBackgroundRunning: false,
            resumeStage: "pipeline",
          });
          return;
        }

        if (job.status === "succeeded") {
          const completedPipelineJobId = pipelineJobId;
          pipelineJobId = "";
          const handoffTask = await prisma.novelWorkflowTask.findUnique({
            where: { id: input.taskId },
            select: { currentItemKey: true, checkpointType: true },
          }).catch(() => null);
          if (
            handoffTask?.currentItemKey === "professional_production_handoff"
            && handoffTask.checkpointType === "workflow_completed"
          ) {
            return;
          }
          if ((autoExecution.remainingChapterCount ?? 0) > 0) {
            if (this.deps.autoConfirmPendingCandidates) {
              await this.deps.autoConfirmPendingCandidates(input.novelId).catch(() => null);
            }
            schedulePendingReviewAutoPromotionIfEnabled(this.deps, {
              novelId: input.novelId,
              taskId: input.taskId,
            });
            await syncAutoExecutionTaskState(this.deps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              isBackgroundRunning: true,
              resumeStage: "pipeline",
            });
            continue autoExecutionLoop;
          }
          await recordCompletedCheckpoint(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            pipelineJobId: completedPipelineJobId,
            pipelineStatus: job.status,
          });
          return;
        }

        if ((autoExecution.remainingChapterCount ?? 0) === 0) {
          await recordCompletedCheckpoint(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution,
            pipelineJobId,
            pipelineStatus: job.status,
          });
          return;
        }

        const scopeLabel = buildDirectorAutoExecutionScopeLabelFromState(autoExecution, range.totalChapterCount);
        const failureMessage = job.error?.trim()
          || (job.status === "cancelled"
            ? `${scopeLabel}自动执行已取消。`
            : `${scopeLabel}自动执行未能全部通过质量要求。`);
        if (
          isFullBookAutopilotRunMode(input.request.runMode)
          && isSkippableAutoExecutionReviewFailure(failureMessage)
          && this.deps.resolveStateProposals
        ) {
          const resolution = await this.deps.resolveStateProposals({
            novelId: input.novelId,
            taskId: input.taskId,
            chapterId: autoExecution.nextChapterId ?? range.firstChapterId,
            chapterOrder: autoExecution.nextChapterOrder ?? null,
            runMode: input.request.runMode,
            provider: input.request.provider,
            model: input.request.model,
            temperature: input.request.temperature,
          });
          if (resolution.processed) {
            if (resolution.decision === "auto_replan_window" && this.deps.replanNovel) {
              await this.deps.replanNovel(input.novelId, {
                chapterId: autoExecution.nextChapterId ?? undefined,
                triggerType: "state_proposal_resolution",
                reason: resolution.reason ?? failureMessage,
                sourceIssueIds: resolution.proposalIds,
                windowSize: Math.max(1, resolution.affectedChapterWindow?.chapterOrders?.length ?? 1),
                provider: input.request.provider,
                model: input.request.model,
                temperature: input.request.temperature,
              });
            }
            pipelineJobId = "";
            ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
              novelId: input.novelId,
              existingState: {
                ...autoExecution,
                pipelineJobId: null,
                pipelineStatus: null,
              },
              pipelineJobId: null,
              pipelineStatus: "queued",
              allowLazyChapterPlanning,
            }));
            await syncAutoExecutionTaskState(this.deps, {
              taskId: input.taskId,
              novelId: input.novelId,
              request: input.request,
              range,
              autoExecution,
              isBackgroundRunning: true,
              resumeStage: "pipeline",
            });
            continue autoExecutionLoop;
          }
        }
        const failureCircuitBreaker = buildFailureCircuitBreaker({
          autoExecution,
          jobStatus: job.status,
          message: failureMessage,
        });
        const failedAutoExecution = withCircuitBreakerState({
          ...autoExecution,
          pipelineJobId,
          pipelineStatus: job.status,
        }, failureCircuitBreaker);
        if (isDirectorCircuitBreakerOpen(failureCircuitBreaker)) {
          const continuedState = await stopAutoExecutionForCircuitBreaker(this.deps, {
            taskId: input.taskId,
            novelId: input.novelId,
            request: input.request,
            range,
            autoExecution: failedAutoExecution,
            circuitBreaker: failureCircuitBreaker,
            resumeStage: "pipeline",
          });
          if (continuedState) {
            // 放行的状态是从 failedAutoExecution 上合闸来的，它仍带着这个已经失败的
            // 终态 job。直接 continue 会在循环头走「已有 job」分支重新取到同一个
            // 失败 job，原地死循环——治理那边也拦不住：resolveDirectorIssueDecision
            // 是纯函数，不查历史也不看 fingerprint；全书模式下质量类问题只要有可用
            // 正文更是被锁定成 continue_with_warning，每一轮都会放行。
            // 所以清掉 job 再按新状态重解析，并且只有"下一章不再是刚失败的那一章"
            // （或者已经没有剩余章节）才继续；否则落到失败处理，让任务停在安全位置。
            pipelineJobId = "";
            ({ range, autoExecution } = await resolveAutoExecutionRuntimeRangeAndState(this.deps, {
              novelId: input.novelId,
              existingState: { ...continuedState, pipelineJobId: null, pipelineStatus: null },
              pipelineJobId: null,
              pipelineStatus: "queued",
              allowLazyChapterPlanning,
            }));
            const advanced = (
              (autoExecution.remainingChapterCount ?? 0) === 0
              || autoExecution.nextChapterId !== activeJobChapterId
              || autoExecution.nextChapterOrder !== activeJobChapterOrder
            );
            if (advanced) {
              await syncAutoExecutionTaskState(this.deps, {
                taskId: input.taskId,
                novelId: input.novelId,
                request: input.request,
                range,
                autoExecution,
                isBackgroundRunning: true,
                resumeStage: "pipeline",
              });
              continue autoExecutionLoop;
            }
          } else {
            return;
          }
        }
        await this.deps.workflowService.markTaskFailed(input.taskId, failureMessage, {
          stage: "quality_repair",
          itemKey: "quality_repair",
          itemLabel: buildDirectorAutoExecutionPausedLabel(autoExecution),
          checkpointType: "chapter_batch_ready",
          checkpointSummary: buildDirectorAutoExecutionPausedSummary({
            scopeLabel,
            remainingChapterCount: autoExecution.remainingChapterCount ?? 0,
            nextChapterOrder: autoExecution.nextChapterOrder ?? null,
            failureMessage,
          }),
          chapterId: autoExecution.nextChapterId ?? range.firstChapterId,
          progress: 0.98,
        });
        await syncAutoExecutionTaskState(this.deps, {
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range,
          autoExecution: failedAutoExecution,
          isBackgroundRunning: false,
          resumeStage: "pipeline",
        });
        return;
      }
      return;
    }
  }

  private async resolveQualityIssueChapter(
    novelId: string,
    job: NonNullable<PipelineJobSnapshot>,
  ): Promise<DirectorAutoExecutionChapterRef | null> {
    const startOrder = typeof job.startOrder === "number" && Number.isFinite(job.startOrder)
      ? job.startOrder
      : null;
    const endOrder = typeof job.endOrder === "number" && Number.isFinite(job.endOrder)
      ? job.endOrder
      : null;
    if (startOrder == null || (endOrder != null && endOrder !== startOrder)) {
      return null;
    }
    const chapters = await this.deps.novelContextService.listChapters(novelId);
    return chapters.find((chapter) => chapter.order === startOrder) ?? null;
  }
}

export function schedulePendingReviewAutoPromotionIfEnabled(
  deps: Pick<
    NovelDirectorAutoExecutionRuntimeDeps,
    "isPendingReviewAutoPromotionEnabled" | "autoPromotePendingReviewProposals"
  >,
  input: {
    novelId: string;
    taskId: string;
  },
): void {
  if (!deps.isPendingReviewAutoPromotionEnabled || !deps.autoPromotePendingReviewProposals) {
    return;
  }
  void Promise.resolve(deps.isPendingReviewAutoPromotionEnabled())
    .then((enabled) => {
      if (!enabled) {
        return undefined;
      }
      return deps.autoPromotePendingReviewProposals?.(input);
    })
    .catch(() => null);
}

