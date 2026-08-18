import {
  changeProposalStatusSchema,
  changeProposalTypeSchema,
  proposalSourceReferenceSchema,
  proposalWarningSchema,
  proposedChangeCategorySchema,
  proposedChangeOperationSchema,
  proposedChangeReviewDecisionSchema,
  proposedChangeSeveritySchema,
  type ChangeProposal,
  type ProposalSourceReference,
  type ProposalWarning,
} from "@ai-novel/shared/types/changeProposal";
import {
  stateChangeProposalStatusSchema,
  stateChangeProposalTypeSchema,
} from "@ai-novel/shared/types/canonicalState";

export interface ProposedChangeRow {
  id: string;
  proposalType: string;
  status: string;
  summary: string;
  payloadJson: string;
  evidenceJson: string | null;
  changePath: string | null;
  operation: string | null;
  category: string | null;
  severity: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  userEditedPayloadJson: string | null;
  reviewDecision: string | null;
  sourceRefsJson: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChangeProposalRow {
  id: string;
  novelId: string;
  chapterId: string | null;
  taskId: string | null;
  proposalType: string;
  version: number;
  supersedesId: string | null;
  status: string;
  outlineFidelity: string | null;
  summary: string;
  reasoningSummary: string | null;
  sourceRefsJson: string | null;
  warningsJson: string | null;
  expectedStateJson: string | null;
  approvedAt: Date | null;
  executedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  changes: ProposedChangeRow[];
}

export interface ChangeProposalStaleState {
  isStale: boolean;
  reasons: string[];
}

function parseJson(value: string | null | undefined): unknown {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseStringArray(value: string | null | undefined): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
}

export function parseProposalSourceRefs(value: string | null | undefined): ProposalSourceReference[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) => {
    const result = proposalSourceReferenceSchema.safeParse(item);
    return result.success ? [result.data] : [];
  });
}

function parseProposalWarnings(value: string | null | undefined): ProposalWarning[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) => {
    const result = proposalWarningSchema.safeParse(item);
    return result.success ? [result.data] : [];
  });
}

export function mapChangeProposal(
  row: ChangeProposalRow,
  stale: ChangeProposalStaleState = { isStale: false, reasons: [] },
): ChangeProposal {
  return {
    id: row.id,
    novelId: row.novelId,
    chapterId: row.chapterId,
    taskId: row.taskId,
    proposalType: changeProposalTypeSchema.parse(row.proposalType),
    version: row.version,
    supersedesId: row.supersedesId,
    status: changeProposalStatusSchema.parse(row.status),
    outlineFidelity: row.outlineFidelity === "strict"
      || row.outlineFidelity === "balanced"
      || row.outlineFidelity === "director"
      ? row.outlineFidelity
      : null,
    summary: row.summary,
    reasoningSummary: row.reasoningSummary,
    sourceRefs: parseProposalSourceRefs(row.sourceRefsJson),
    warnings: parseProposalWarnings(row.warningsJson),
    expectedState: parseJson(row.expectedStateJson) ?? null,
    isStale: stale.isStale,
    staleReasons: stale.reasons,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    changes: row.changes.map((change) => ({
      id: change.id,
      proposalType: stateChangeProposalTypeSchema.parse(change.proposalType),
      path: change.changePath ?? "",
      operation: proposedChangeOperationSchema.parse(change.operation),
      category: proposedChangeCategorySchema.parse(change.category),
      severity: proposedChangeSeveritySchema.parse(change.severity),
      before: parseJson(change.beforeJson),
      after: parseJson(change.afterJson),
      payload: parseRecord(change.payloadJson),
      reason: change.summary,
      sourceRefs: parseProposalSourceRefs(change.sourceRefsJson),
      evidence: parseStringArray(change.evidenceJson),
      status: stateChangeProposalStatusSchema.parse(change.status),
      reviewDecision: change.reviewDecision
        ? proposedChangeReviewDecisionSchema.parse(change.reviewDecision)
        : null,
      userEditedPayload: change.userEditedPayloadJson
        ? parseRecord(change.userEditedPayloadJson)
        : null,
      createdAt: change.createdAt.toISOString(),
      updatedAt: change.updatedAt.toISOString(),
    })),
  };
}
