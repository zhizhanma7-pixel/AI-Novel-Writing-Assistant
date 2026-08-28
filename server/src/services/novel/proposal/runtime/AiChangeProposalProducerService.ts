import {
  createChangeProposalInputSchema,
  type ChangeProposal,
  type CreateChangeProposalInput,
} from "@ai-novel/shared/types/changeProposal";
import type {
  DirectorPolicyDecision,
  DirectorPolicyMode,
} from "@ai-novel/shared/types/directorRuntime";
import type { ProposalAutonomyLevel } from "@ai-novel/shared/types/proposalRuntime";
import { z } from "zod";
import { directorAutomationLedgerEventService } from "../../director/runtime/DirectorAutomationLedgerEventService";
import { changeProposalApplyService } from "../application/ChangeProposalApplyService";
import { changeProposalReviewService } from "../application/ChangeProposalReviewService";
import { changeProposalService } from "../application/ChangeProposalService";
import { ChangeProposalError } from "../domain/ChangeProposalError";
import { changeProposalPolicyGateService } from "./ChangeProposalPolicyGateService";

export const aiChangeProposalInputSchema = createChangeProposalInputSchema
  .omit({ taskId: true, submitForReview: true })
  .extend({
    taskId: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export type AiChangeProposalInput = z.infer<typeof aiChangeProposalInputSchema>;
/**
 * - `pending_review`：提案停在待审状态，等待人工审阅。
 * - `executed`：已自动批准并成功写入正式状态。
 * - `apply_failed`：**已自动批准但写入失败**。信封事务原子回滚，没有半写状态；
 *   提案实际停在 `approved`，不是 `pending_review`。
 *
 * `apply_failed` 是复审 H3 的修复：此前这条路径返回 `pending_review`，而提案
 * 真实状态是 `approved`，导致调用方（含 agent 工具的用户可见文案）声称
 * 「已放入审阅入口」，但状态机从 `approved` 只能到 `executed` / `superseded`，
 * 回不到待审——用户真正要做的是重新执行或重新生成，不是审阅。
 */
export type AiChangeProposalDisposition = "pending_review" | "executed" | "apply_failed";

/**
 * 待审提案的投影方式（Phase 2C / D2）。
 *
 * - `task_checkpoint`：默认值，Phase 2A 的既有行为——投 `proposal_review_required`
 *   checkpoint，任务进入等待审批状态。
 * - `non_blocking`：只写账本事件让驾驶舱时间线可见，不投 checkpoint、不改任务状态。
 *   章节局部偏离必须用这一种，否则每次偏离都会停住全书执行链，正面违反
 *   `AGENTS.md` 的 Auto-Director Quality Gate Rules。
 *
 * 默认值刻意保持 `task_checkpoint`：新调用方忘记传参时应当落到更保守的一侧，
 * 而不是静默失去 checkpoint。
 */
export type ChangeProposalReviewProjection = "task_checkpoint" | "non_blocking";

export interface AiChangeProposalProduceOptions {
  reviewProjection?: ChangeProposalReviewProjection;
}

export interface AiChangeProposalProductionResult {
  proposal: ChangeProposal;
  disposition: AiChangeProposalDisposition;
  autonomyLevel: ProposalAutonomyLevel;
  directorPolicyMode: DirectorPolicyMode;
  policyMode: DirectorPolicyMode;
  policyDecision: DirectorPolicyDecision;
  policyReason: string;
  reviewProjection: ChangeProposalReviewProjection;
}

type ProposalCreator = Pick<
  typeof changeProposalService,
  "createProposal" | "markTaskProposalReviewRequired"
>;
type ProposalReviewer = Pick<typeof changeProposalReviewService, "approveProposal">;
type ProposalApplier = Pick<typeof changeProposalApplyService, "executeProposal">;
type ProposalPolicyGate = Pick<typeof changeProposalPolicyGateService, "evaluate">;
type ProposalLedgerEventRecorder = Pick<typeof directorAutomationLedgerEventService, "recordEvent">;

export class AiChangeProposalProducerService {
  constructor(
    private readonly proposalService: ProposalCreator = changeProposalService,
    private readonly reviewService: ProposalReviewer = changeProposalReviewService,
    private readonly applyService: ProposalApplier = changeProposalApplyService,
    private readonly policyGate: ProposalPolicyGate = changeProposalPolicyGateService,
    private readonly ledgerEventService: ProposalLedgerEventRecorder = directorAutomationLedgerEventService,
    private readonly warn: (message: string, details?: Record<string, unknown>) => void = console.warn,
  ) {}

  async produce(
    novelId: string,
    rawInput: AiChangeProposalInput,
    options: AiChangeProposalProduceOptions = {},
  ): Promise<AiChangeProposalProductionResult> {
    const reviewProjection = options.reviewProjection ?? "task_checkpoint";
    const input = aiChangeProposalInputSchema.parse(rawInput);
    const proposal = await this.proposalService.createProposal(
      novelId,
      {
        ...input,
        taskId: input.taskId,
        submitForReview: true,
      } satisfies CreateChangeProposalInput,
      { deferTaskCheckpoint: true },
    );
    const evaluation = await this.policyGate.evaluate(proposal);

    if (!evaluation.decision.canRun || evaluation.decision.requiresApproval) {
      await this.projectPendingReview({
        proposal,
        reviewProjection,
        severity: "medium",
        summary: `变更方案需要确认：${proposal.summary}`,
        reason: evaluation.decision.reason,
      });
      return {
        proposal,
        disposition: "pending_review",
        autonomyLevel: evaluation.autonomyLevel,
        directorPolicyMode: evaluation.directorPolicyMode,
        policyMode: evaluation.policyMode,
        policyDecision: evaluation.decision,
        policyReason: evaluation.decision.reason,
        reviewProjection,
      };
    }

    const approved = await this.reviewService.approveProposal(novelId, proposal.id, {
      expectedVersion: proposal.version,
    });
    try {
      const executed = await this.applyService.executeProposal(novelId, proposal.id, {
        authority: "automation",
      });
      return {
        proposal: executed,
        disposition: "executed",
        autonomyLevel: evaluation.autonomyLevel,
        directorPolicyMode: evaluation.directorPolicyMode,
        policyMode: evaluation.policyMode,
        policyDecision: evaluation.decision,
        policyReason: evaluation.decision.reason,
        reviewProjection,
      };
    } catch (error) {
      // 自动执行失败不停全书链：信封是原子的，失败即整体回滚，没有半写状态；
      // 失败的是计划更新而不是正文生成，本章正文仍然可用，因此不满足
      // `AGENTS.md` 里任何一条允许停链的条件。代价是失败会比较安静，
      // 所以非阻塞投影下必须写 high severity 账本事件让它在驾驶舱显眼。
      await this.projectPendingReview({
        proposal: approved,
        reviewProjection,
        severity: "high",
        // 文案必须如实：提案已经批准过了，卡在写入这一步，需要的是重新执行
        // 或重新生成，不是再审一次。
        summary: `变更方案已确认但未能应用，需要重新执行或重新生成：${approved.summary}`,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof ChangeProposalError && error.code === "approval_required") {
        return {
          proposal: approved,
          disposition: "apply_failed",
          autonomyLevel: evaluation.autonomyLevel,
          directorPolicyMode: evaluation.directorPolicyMode,
          policyMode: evaluation.policyMode,
          policyDecision: evaluation.decision,
          policyReason: "Runtime policy changed before apply; explicit review is required.",
          reviewProjection,
        };
      }
      throw error;
    }
  }

  /**
   * 把「这份提案需要人来看」投影出去。两种投影只在**是否改变任务状态**上不同，
   * 提案本身在两种模式下都保持可审阅。
   */
  private async projectPendingReview(input: {
    proposal: ChangeProposal;
    reviewProjection: ChangeProposalReviewProjection;
    severity: "medium" | "high";
    summary: string;
    reason: string;
  }): Promise<void> {
    if (input.reviewProjection === "task_checkpoint") {
      await this.proposalService.markTaskProposalReviewRequired(input.proposal);
      return;
    }
    try {
      await this.ledgerEventService.recordEvent({
        type: "proposal_review_deferred",
        idempotencyKey: [
          input.proposal.taskId ?? "book",
          input.proposal.novelId,
          input.proposal.id,
          input.proposal.version,
          input.severity,
        ].join(":"),
        taskId: input.proposal.taskId ?? null,
        novelId: input.proposal.novelId,
        nodeKey: "proposal.review_deferred",
        artifactType: "change_proposal",
        summary: input.summary,
        affectedScope: `change_proposal:${input.proposal.id}`,
        severity: input.severity,
        metadata: {
          changeProposalId: input.proposal.id,
          proposalType: input.proposal.proposalType,
          version: input.proposal.version,
          chapterId: input.proposal.chapterId ?? null,
          // 真实状态必须进账本：approved 与 pending_review 的可用操作完全不同
          // （前者只能重新执行或重新生成，回不到待审）。
          proposalStatus: input.proposal.status,
          reason: input.reason,
        },
      });
    } catch (error) {
      // 账本写入失败也不能停链。降级到服务端日志，至少不完全静默。
      this.warn("[ai-change-proposal-producer] failed to record deferred review event.", {
        novelId: input.proposal.novelId,
        changeProposalId: input.proposal.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const aiChangeProposalProducerService = new AiChangeProposalProducerService();
