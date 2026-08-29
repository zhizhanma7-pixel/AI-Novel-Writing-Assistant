import type { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import {
  changeProposalStatusSchema,
  changeProposalTypeSchema,
  createChangeProposalInputSchema,
  editProposedChangeInputSchema,
  proposedChangeItemDecisionSchema,
  regenerateChangeProposalInputSchema,
  rejectChangeProposalInputSchema,
  reviewChangeProposalInputSchema,
} from "@ai-novel/shared/types/changeProposal";
import { z } from "zod";
import { AppError } from "../../../../middleware/errorHandler";
import { validate } from "../../../../middleware/validate";
import {
  ChangeProposalError,
  changeProposalApplyService,
  changeProposalReviewService,
  changeProposalService,
} from "../../../../services/novel/proposal";
import { DirectorCommandService } from "../../../../services/novel/director/commands/DirectorCommandService";
import { outlineImportRequestSchema } from "@ai-novel/shared/types/outlineWorkflow";
import { outlineImportProposalService } from "../../../../services/novel/proposal/outline/application/OutlineImportProposalService";
import { ChapterDivergenceCorrectionService } from "../../../../services/novel/proposal/chapterExecution/application/ChapterDivergenceCorrectionService";

const proposalParamsSchema = z.object({
  id: z.string().trim().min(1),
  proposalId: z.string().trim().min(1),
});

const proposedChangeParamsSchema = proposalParamsSchema.extend({
  itemId: z.string().trim().min(1),
});

const listProposalQuerySchema = z.object({
  status: changeProposalStatusSchema.optional(),
  type: changeProposalTypeSchema.optional(),
  chapterId: z.string().trim().min(1).optional(),
});

const expectedVersionSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
}).default({});

const partialApprovalSchema = reviewChangeProposalInputSchema.extend({
  itemDecisions: z.array(proposedChangeItemDecisionSchema).min(1).max(200),
});

const directorCommandService = new DirectorCommandService();

// 修正命令会在构造时接生产 repair adapter，延迟到首次调用再建，
// 避免又一处模块加载期的 eager 构造（见 `7088f77`）。
let chapterDivergenceCorrectionServiceInstance: ChapterDivergenceCorrectionService | null = null;

function getChapterDivergenceCorrectionService(): ChapterDivergenceCorrectionService {
  chapterDivergenceCorrectionServiceInstance ??= new ChapterDivergenceCorrectionService();
  return chapterDivergenceCorrectionServiceInstance;
}

async function enqueueTaskBoundReview(
  novelId: string,
  proposalId: string,
  request: Parameters<DirectorCommandService["enqueueReviewProposalCommand"]>[1],
) {
  const proposal = await changeProposalService.getProposal(novelId, proposalId);
  if (!proposal.taskId) {
    return null;
  }
  return directorCommandService.enqueueReviewProposalCommand(proposal.taskId, request);
}

export function forwardProposalError(error: unknown, next: (error?: unknown) => void): void {
  if (error instanceof ChangeProposalError) {
    // Proposal clients branch on the stable domain code and translate the
    // recovery action locally. Keep the domain message as response detail.
    next(new AppError(error.code, error.statusCode, error.message));
    return;
  }
  next(error);
}

export function registerNovelChangeProposalRoutes(router: Router): void {
  router.post(
    "/:id/outline-import/propose",
    validate({
      params: z.object({ id: z.string().trim().min(1) }),
      body: outlineImportRequestSchema,
    }),
    async (req, res, next) => {
      try {
        const { id } = z.object({ id: z.string().trim().min(1) }).parse(req.params);
        const data = await outlineImportProposalService.propose(id, req.body);
        res.status(201).json({
          success: true,
          data,
          message: "AI 已整理核心事件和大纲建议，请审阅后应用。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        forwardProposalError(error, next);
      }
    },
  );

  router.get(
    "/:id/change-proposals",
    validate({
      params: z.object({ id: z.string().trim().min(1) }),
      query: listProposalQuerySchema,
    }),
    async (req, res, next) => {
      try {
        const { id } = z.object({ id: z.string().trim().min(1) }).parse(req.params);
        const query = listProposalQuerySchema.parse(req.query);
        const data = await changeProposalService.listProposals({
          novelId: id,
          status: query.status,
          proposalType: query.type,
          chapterId: query.chapterId,
        });
        res.status(200).json({
          success: true,
          data,
          message: "提案列表可供审阅。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        forwardProposalError(error, next);
      }
    },
  );

  router.get(
    "/:id/change-proposals/:proposalId",
    validate({ params: proposalParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, proposalId } = proposalParamsSchema.parse(req.params);
        const data = await changeProposalService.getProposal(id, proposalId);
        res.status(200).json({
          success: true,
          data,
          message: "提案详情可供审阅。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        forwardProposalError(error, next);
      }
    },
  );

  router.post(
    "/:id/change-proposals",
    validate({
      params: z.object({ id: z.string().trim().min(1) }),
      body: createChangeProposalInputSchema,
    }),
    async (req, res, next) => {
      try {
        const { id } = z.object({ id: z.string().trim().min(1) }).parse(req.params);
        const data = await changeProposalService.createProposal(id, req.body);
        res.status(201).json({
          success: true,
          data,
          message: data.status === "draft" ? "提案草稿可继续编辑。" : "提案可供审阅。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        forwardProposalError(error, next);
      }
    },
  );

  router.post(
    "/:id/change-proposals/:proposalId/submit",
    validate({ params: proposalParamsSchema, body: expectedVersionSchema }),
    async (req, res, next) => {
      try {
        const { id, proposalId } = proposalParamsSchema.parse(req.params);
        const data = await changeProposalService.submitForReview(
          id,
          proposalId,
          req.body.expectedVersion,
        );
        res.status(200).json({
          success: true,
          data,
          message: "提案可供审阅。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        forwardProposalError(error, next);
      }
    },
  );

  router.patch(
    "/:id/change-proposals/:proposalId/items/:itemId",
    validate({ params: proposedChangeParamsSchema, body: editProposedChangeInputSchema }),
    async (req, res, next) => {
      try {
        const { id, proposalId, itemId } = proposedChangeParamsSchema.parse(req.params);
        const data = await changeProposalReviewService.editProposedChange(
          id,
          proposalId,
          itemId,
          req.body,
        );
        res.status(200).json({
          success: true,
          data,
          message: "修改值将作为审批执行值。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        forwardProposalError(error, next);
      }
    },
  );

  router.post(
    "/:id/change-proposals/:proposalId/approve",
    validate({ params: proposalParamsSchema, body: reviewChangeProposalInputSchema }),
    async (req, res, next) => {
      try {
        const { id, proposalId } = proposalParamsSchema.parse(req.params);
        const queued = await enqueueTaskBoundReview(id, proposalId, {
          novelId: id,
          proposalId,
          decision: "approve",
          expectedVersion: req.body.expectedVersion,
          itemDecisions: req.body.itemDecisions,
          unlistedDecision: req.body.unlistedDecision,
        });
        if (queued) {
          res.status(202).json({
            success: true,
            data: queued,
            message: "导演提案审批命令已入队。",
          } satisfies ApiResponse<typeof queued>);
          return;
        }
        const data = await changeProposalReviewService.approveProposal(id, proposalId, req.body);
        res.status(200).json({
          success: true,
          data,
          message: "提案获得批准，可执行批准项。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        forwardProposalError(error, next);
      }
    },
  );

  router.post(
    "/:id/change-proposals/:proposalId/partial-approve",
    validate({ params: proposalParamsSchema, body: partialApprovalSchema }),
    async (req, res, next) => {
      try {
        const { id, proposalId } = proposalParamsSchema.parse(req.params);
        const queued = await enqueueTaskBoundReview(id, proposalId, {
          novelId: id,
          proposalId,
          decision: "partial",
          expectedVersion: req.body.expectedVersion,
          itemDecisions: req.body.itemDecisions,
          unlistedDecision: req.body.unlistedDecision,
        });
        if (queued) {
          res.status(202).json({
            success: true,
            data: queued,
            message: "导演提案部分审批命令已入队。",
          } satisfies ApiResponse<typeof queued>);
          return;
        }
        const data = await changeProposalReviewService.approveProposal(id, proposalId, req.body);
        res.status(200).json({
          success: true,
          data,
          message: "批准项可执行，拒绝项不会写入正式状态。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        forwardProposalError(error, next);
      }
    },
  );

  router.post(
    "/:id/change-proposals/:proposalId/reject",
    validate({ params: proposalParamsSchema, body: rejectChangeProposalInputSchema }),
    async (req, res, next) => {
      try {
        const { id, proposalId } = proposalParamsSchema.parse(req.params);
        const queued = await enqueueTaskBoundReview(id, proposalId, {
          novelId: id,
          proposalId,
          decision: "reject",
          expectedVersion: req.body.expectedVersion,
          reason: req.body.reason,
        });
        if (queued) {
          res.status(202).json({
            success: true,
            data: queued,
            message: "导演提案拒绝命令已入队。",
          } satisfies ApiResponse<typeof queued>);
          return;
        }
        const data = await changeProposalReviewService.rejectProposal(id, proposalId, req.body);
        res.status(200).json({
          success: true,
          data,
          message: "提案不会写入正式状态。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        forwardProposalError(error, next);
      }
    },
  );

  router.post(
    "/:id/change-proposals/:proposalId/regenerate",
    validate({ params: proposalParamsSchema, body: regenerateChangeProposalInputSchema }),
    async (req, res, next) => {
      try {
        const { id, proposalId } = proposalParamsSchema.parse(req.params);
        const queued = await enqueueTaskBoundReview(id, proposalId, {
          novelId: id,
          proposalId,
          decision: "replan",
          regenerateInput: req.body,
        });
        if (queued) {
          res.status(202).json({
            success: true,
            data: queued,
            message: "导演提案再生命令已入队。",
          } satisfies ApiResponse<typeof queued>);
          return;
        }
        const data = await changeProposalService.regenerateProposal(id, proposalId, req.body);
        res.status(201).json({
          success: true,
          data,
          message: "新版本提案可供审阅。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        forwardProposalError(error, next);
      }
    },
  );

  router.post(
    "/:id/change-proposals/:proposalId/execute",
    validate({ params: proposalParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, proposalId } = proposalParamsSchema.parse(req.params);
        const queued = await enqueueTaskBoundReview(id, proposalId, {
          novelId: id,
          proposalId,
          decision: "execute",
        });
        if (queued) {
          res.status(202).json({
            success: true,
            data: queued,
            message: "导演提案执行命令已入队。",
          } satisfies ApiResponse<typeof queued>);
          return;
        }
        const data = await changeProposalApplyService.executeProposal(id, proposalId);
        res.status(200).json({
          success: true,
          data,
          message: "批准项进入正式状态。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        forwardProposalError(error, next);
      }
    },
  );

  router.post(
    "/:id/change-proposals/:proposalId/items/:itemId/correct",
    validate({ params: proposedChangeParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, proposalId, itemId } = proposedChangeParamsSchema.parse(req.params);
        const result = await getChapterDivergenceCorrectionService().correct({
          novelId: id,
          proposalId,
          changeId: itemId,
        });
        if (result.status === "conflict") {
          // 修复期间正文/逐项决定/信封状态被改过，旧结果不能覆盖新状态。
          throw new ChangeProposalError("version_conflict", result.reason);
        }
        // `repair_failed` 是业务结果而不是服务故障：逐项仍可审阅，质量债已落，
        // 因此走 200 让前端如实呈现，而不是 5xx。
        res.status(200).json({
          success: true,
          data: result,
          message: result.status === "corrected"
            ? "正文已改回原计划。"
            : "这次没能改回原计划，条目仍可审阅。",
        } satisfies ApiResponse<typeof result>);
      } catch (error) {
        forwardProposalError(error, next);
      }
    },
  );
}
