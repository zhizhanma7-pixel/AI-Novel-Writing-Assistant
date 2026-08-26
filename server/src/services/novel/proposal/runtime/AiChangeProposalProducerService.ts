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
import { changeProposalApplyService } from "../application/ChangeProposalApplyService";
import { changeProposalReviewService } from "../application/ChangeProposalReviewService";
import { changeProposalService } from "../application/ChangeProposalService";
import { ChangeProposalError } from "../domain/ChangeProposalError";
import { changeProposalPolicyGateService } from "./ChangeProposalPolicyGateService";

export const aiChangeProposalInputSchema = createChangeProposalInputSchema
  .omit({ taskId: true, submitForReview: true })
  .extend({
    taskId: z.string().trim().min(1),
  })
  .strict();

export type AiChangeProposalInput = z.infer<typeof aiChangeProposalInputSchema>;
export type AiChangeProposalDisposition = "pending_review" | "executed";

export interface AiChangeProposalProductionResult {
  proposal: ChangeProposal;
  disposition: AiChangeProposalDisposition;
  autonomyLevel: ProposalAutonomyLevel;
  directorPolicyMode: DirectorPolicyMode;
  policyMode: DirectorPolicyMode;
  policyDecision: DirectorPolicyDecision;
  policyReason: string;
}

type ProposalCreator = Pick<
  typeof changeProposalService,
  "createProposal" | "markTaskProposalReviewRequired"
>;
type ProposalReviewer = Pick<typeof changeProposalReviewService, "approveProposal">;
type ProposalApplier = Pick<typeof changeProposalApplyService, "executeProposal">;
type ProposalPolicyGate = Pick<typeof changeProposalPolicyGateService, "evaluate">;

export class AiChangeProposalProducerService {
  constructor(
    private readonly proposalService: ProposalCreator = changeProposalService,
    private readonly reviewService: ProposalReviewer = changeProposalReviewService,
    private readonly applyService: ProposalApplier = changeProposalApplyService,
    private readonly policyGate: ProposalPolicyGate = changeProposalPolicyGateService,
  ) {}

  async produce(
    novelId: string,
    rawInput: AiChangeProposalInput,
  ): Promise<AiChangeProposalProductionResult> {
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
      await this.proposalService.markTaskProposalReviewRequired(proposal);
      return {
        proposal,
        disposition: "pending_review",
        autonomyLevel: evaluation.autonomyLevel,
        directorPolicyMode: evaluation.directorPolicyMode,
        policyMode: evaluation.policyMode,
        policyDecision: evaluation.decision,
        policyReason: evaluation.decision.reason,
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
      };
    } catch (error) {
      await this.proposalService.markTaskProposalReviewRequired(approved);
      if (error instanceof ChangeProposalError && error.code === "approval_required") {
        return {
          proposal: approved,
          disposition: "pending_review",
          autonomyLevel: evaluation.autonomyLevel,
          directorPolicyMode: evaluation.directorPolicyMode,
          policyMode: evaluation.policyMode,
          policyDecision: evaluation.decision,
          policyReason: "Runtime policy changed before apply; explicit review is required.",
        };
      }
      throw error;
    }
  }
}

export const aiChangeProposalProducerService = new AiChangeProposalProducerService();
