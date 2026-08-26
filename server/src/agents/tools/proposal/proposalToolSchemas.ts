import { changeProposalSchema } from "@ai-novel/shared/types/changeProposal";
import { proposalAutonomyLevelSchema } from "@ai-novel/shared/types/proposalRuntime";
import { z } from "zod";
import { aiChangeProposalInputSchema } from "../../../services/novel/proposal/runtime/AiChangeProposalProducerService";

export const proposeNovelChangeInputSchema = aiChangeProposalInputSchema
  .extend({
    novelId: z.string().trim().min(1).optional(),
    taskId: z.string().trim().min(1).optional(),
  })
  .strict();

export const proposeNovelChangeOutputSchema = z.object({
  proposal: changeProposalSchema,
  disposition: z.enum(["pending_review", "executed"]),
  autonomyLevel: proposalAutonomyLevelSchema,
  policyMode: z.enum([
    "suggest_only",
    "run_next_step",
    "run_until_gate",
    "auto_safe_scope",
  ]),
  policyDecision: z.object({
    canRun: z.boolean(),
    requiresApproval: z.boolean(),
    gateType: z.enum(["none", "approval", "blocked_scope"]),
    reason: z.string(),
    mayOverwriteUserContent: z.boolean(),
    affectedArtifacts: z.array(z.string()),
    riskTags: z.array(z.enum([
      "suggest_only",
      "protected_user_content",
      "default_approval",
      "expensive_review",
      "downstream_recompute",
      "large_scope_auto_run",
      "quality_repair",
      "quality_manual_repair",
      "quality_blocked_scope",
      "continue_with_risk",
      "proposal_major",
      "outline_fidelity_strict",
    ])),
    autoRetryBudget: z.number().int().nonnegative(),
    onQualityFailure: z.enum([
      "repair_once",
      "pause_for_manual",
      "continue_with_risk",
      "block_scope",
    ]),
  }),
  policyReason: z.string(),
  summary: z.string(),
});
