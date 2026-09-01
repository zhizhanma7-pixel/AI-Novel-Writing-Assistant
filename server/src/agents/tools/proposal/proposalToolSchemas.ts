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
  disposition: z.enum(["pending_review", "executed", "apply_failed"]),
  autonomyLevel: proposalAutonomyLevelSchema,
  directorPolicyMode: z.enum([
    "suggest_only",
    "run_next_step",
    "run_until_gate",
    "auto_safe_scope",
  ]),
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
      "proposal_major",
      "outline_fidelity_strict",
    ])),
    // 这里曾要求 autoRetryBudget 与 onQualityFailure，还多列了四个 quality_*
    // 风险标签。它们都来自那批已废弃的质量预算编排——`DirectorPolicyDecision`
    // （shared/types/directorRuntime.ts）从不产出这些字段。这是**输出** schema，
    // 校验的是本项目自己算出来的决定，于是这条工具一调用必然抛 ZodError。
    // 取值域按真实类型对齐，不要反过来给引擎加字段去迁就一个过时的形状。
  }),
  policyReason: z.string(),
  summary: z.string(),
});
