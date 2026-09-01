import { z } from "zod";
import {
  stateChangeProposalStatusSchema,
  stateChangeProposalTypeSchema,
} from "./canonicalState.js";

export const changeProposalTypeSchema = z.enum([
  "chapter_execution",
  "outline_edit",
  "character_state",
  "relationship_change",
  "world_edit",
  "plot_replan",
  "asset_import",
  "post_write_state",
]);

export const changeProposalStatusSchema = z.enum([
  "draft",
  "pending_review",
  "approved",
  "partially_approved",
  "rejected",
  "executed",
  "superseded",
]);

export const proposedChangeSeveritySchema = z.enum(["minor", "major"]);
export const proposedChangeOperationSchema = z.enum(["add", "remove", "replace"]);
export const proposedChangeCategorySchema = z.enum([
  "outline",
  "character",
  "relationship",
  "knowledge",
  "world",
  "plot",
  "foreshadowing",
  "timeline",
]);
export const proposedChangeReviewDecisionSchema = z.enum([
  "accepted",
  "modified",
  "rejected",
]);

export const directorArtifactSourceReferenceSchema = z.object({
  kind: z.literal("director_artifact"),
  artifactId: z.string().trim().min(1),
  version: z.number().int().positive(),
  contentHash: z.string().trim().min(1).nullable().optional(),
  label: z.string().trim().min(1).max(240).nullable().optional(),
});

export const recordSourceReferenceSchema = z.object({
  // Record references are traceability metadata in Proposal Core. Deterministic
  // stale checks currently apply only to director_artifact and chapter refs.
  kind: z.literal("record"),
  table: z.string().trim().min(1).max(120),
  id: z.string().trim().min(1),
  version: z.union([z.string(), z.number()]).nullable().optional(),
  label: z.string().trim().min(1).max(240).nullable().optional(),
});

export const chapterSourceReferenceSchema = z.object({
  kind: z.literal("chapter"),
  chapterId: z.string().trim().min(1),
  chapterOrder: z.number().int().positive().nullable().optional(),
  contentHash: z.string().trim().min(1).nullable().optional(),
  label: z.string().trim().min(1).max(240).nullable().optional(),
});

export const proposalSourceReferenceSchema = z.discriminatedUnion("kind", [
  directorArtifactSourceReferenceSchema,
  recordSourceReferenceSchema,
  chapterSourceReferenceSchema,
]);

export const proposalWarningSchema = z.object({
  code: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(1000),
  severity: proposedChangeSeveritySchema,
  sourceRefs: z.array(proposalSourceReferenceSchema).default([]),
});

export const proposedChangeInputSchema = z.object({
  proposalType: stateChangeProposalTypeSchema,
  path: z.string().trim().min(1).max(500),
  operation: proposedChangeOperationSchema,
  category: proposedChangeCategorySchema,
  severity: proposedChangeSeveritySchema,
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  payload: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(1).max(1000),
  sourceRefs: z.array(proposalSourceReferenceSchema).default([]),
  evidence: z.array(z.string().trim().min(1).max(1000)).default([]),
});

export const createChangeProposalInputSchema = z.object({
  chapterId: z.string().trim().min(1).nullable().optional(),
  taskId: z.string().trim().min(1).nullable().optional(),
  proposalType: changeProposalTypeSchema,
  outlineFidelity: z.enum(["strict", "balanced", "director"]).nullable().optional(),
  summary: z.string().trim().min(1).max(1000),
  // This is deliberately the only rationale field. It is user-visible and must
  // never contain hidden model reasoning or chain-of-thought.
  reasoningSummary: z.string().trim().min(1).max(1000).nullable().optional(),
  sourceRefs: z.array(proposalSourceReferenceSchema).default([]),
  warnings: z.array(proposalWarningSchema).default([]),
  expectedState: z.unknown().nullable().optional(),
  changes: z.array(proposedChangeInputSchema).min(1).max(200),
  submitForReview: z.boolean().default(true),
});

export const proposedChangeItemDecisionSchema = z.object({
  id: z.string().trim().min(1),
  decision: proposedChangeReviewDecisionSchema,
  editedPayload: z.record(z.string(), z.unknown()).optional(),
  editedValue: z.unknown().optional(),
}).superRefine((value, context) => {
  const hasEditedValue = value.editedPayload !== undefined || value.editedValue !== undefined;
  if (value.decision !== "modified" && hasEditedValue) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decision"],
      message: "editedPayload and editedValue are only valid for modified decisions",
    });
  }
});

/**
 * 读取时看到的 `updatedAt`，用于并发守卫。
 *
 * `expectedVersion` 挡不住这一类：`version` 是**重新生成的世代号**
 * （supersede 时 +1），逐项编辑不会动它。于是「我读过之后别人改了某一项」
 * 在乐观锁眼里毫无变化，审批照过，批准的是审批者没看过的内容。
 *
 * 不把编辑也算进 version：那会让世代号同时表示两件事，supersedesId 链
 * 和带 version 的事件幂等键都会跟着变味。另开一个字段，各管各的。
 *
 * 可选，老调用方行为不变。
 */
export const reviewChangeProposalInputSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  expectedUpdatedAt: z.string().optional(),
  itemDecisions: z.array(proposedChangeItemDecisionSchema).max(200).optional(),
  unlistedDecision: z.enum(["accepted", "rejected"]).optional(),
});

export const rejectChangeProposalInputSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  expectedUpdatedAt: z.string().optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
}).default({});

export const editProposedChangeInputSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  expectedUpdatedAt: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  after: z.unknown().optional(),
}).refine(
  (value) => value.payload !== undefined || value.after !== undefined,
  { message: "payload or after is required" },
);

export const regenerateChangeProposalInputSchema = z.object({
  summary: z.string().trim().min(1).max(1000).optional(),
  reasoningSummary: z.string().trim().min(1).max(1000).nullable().optional(),
  sourceRefs: z.array(proposalSourceReferenceSchema).optional(),
  warnings: z.array(proposalWarningSchema).optional(),
  expectedState: z.unknown().nullable().optional(),
  changes: z.array(proposedChangeInputSchema).min(1).max(200).optional(),
  submitForReview: z.boolean().default(true),
});

export const proposedChangeSchema = proposedChangeInputSchema.extend({
  id: z.string(),
  status: stateChangeProposalStatusSchema,
  reviewDecision: proposedChangeReviewDecisionSchema.nullable(),
  userEditedPayload: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const changeProposalSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  chapterId: z.string().nullable(),
  taskId: z.string().nullable(),
  proposalType: changeProposalTypeSchema,
  version: z.number().int().positive(),
  supersedesId: z.string().nullable(),
  status: changeProposalStatusSchema,
  outlineFidelity: z.enum(["strict", "balanced", "director"]).nullable(),
  summary: z.string(),
  reasoningSummary: z.string().nullable(),
  sourceRefs: z.array(proposalSourceReferenceSchema),
  warnings: z.array(proposalWarningSchema),
  expectedState: z.unknown().nullable(),
  isStale: z.boolean(),
  staleReasons: z.array(z.string()),
  approvedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  changes: z.array(proposedChangeSchema),
});

export type ChangeProposalType = z.infer<typeof changeProposalTypeSchema>;
export type ChangeProposalStatus = z.infer<typeof changeProposalStatusSchema>;
export type ProposedChangeSeverity = z.infer<typeof proposedChangeSeveritySchema>;
export type ProposedChangeOperation = z.infer<typeof proposedChangeOperationSchema>;
export type ProposedChangeCategory = z.infer<typeof proposedChangeCategorySchema>;
export type ProposedChangeReviewDecision = z.infer<typeof proposedChangeReviewDecisionSchema>;
export type ProposalSourceReference = z.infer<typeof proposalSourceReferenceSchema>;
export type ProposalWarning = z.infer<typeof proposalWarningSchema>;
export type ProposedChangeInput = z.infer<typeof proposedChangeInputSchema>;
export type CreateChangeProposalInput = z.infer<typeof createChangeProposalInputSchema>;
export type ProposedChangeItemDecision = z.infer<typeof proposedChangeItemDecisionSchema>;
export type ReviewChangeProposalInput = z.infer<typeof reviewChangeProposalInputSchema>;
export type RejectChangeProposalInput = z.infer<typeof rejectChangeProposalInputSchema>;
export type EditProposedChangeInput = z.infer<typeof editProposedChangeInputSchema>;
export type RegenerateChangeProposalInput = z.infer<typeof regenerateChangeProposalInputSchema>;
export type ProposedChange = z.infer<typeof proposedChangeSchema>;
export type ChangeProposal = z.infer<typeof changeProposalSchema>;
