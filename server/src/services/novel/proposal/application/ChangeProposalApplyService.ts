import type { ChangeProposal, ChangeProposalStatus } from "@ai-novel/shared/types/changeProposal";
import { prisma } from "../../../../db/prisma";
import { directorAutomationLedgerEventService } from "../../director/runtime/DirectorAutomationLedgerEventService";
import { stateCommitService } from "../../state/StateCommitService";
import { getStateProposalApplicationMode } from "../../state/StateProposalApplierRegistry";
import { stateChangeProposalTypeSchema } from "@ai-novel/shared/types/canonicalState";
import { ChangeProposalError } from "../domain/ChangeProposalError";
import { assertChangeProposalTransition } from "../domain/ChangeProposalStateMachine";
import { changeProposalArtifactService } from "../infrastructure/ChangeProposalArtifactService";
import {
  mapChangeProposal,
  parseProposalSourceRefs,
  type ChangeProposalRow,
} from "../infrastructure/ChangeProposalMapper";
import { changeProposalStalenessService } from "../infrastructure/ChangeProposalStalenessService";
import { findConflictingDownstreamTarget } from "../chapterExecution/domain/ChapterDivergenceThreshold";
import { changeProposalPolicyGateService } from "../runtime/ChangeProposalPolicyGateService";
import { changeProposalService } from "./ChangeProposalService";
import { assertProposedValueMatchesPayload } from "../domain/ProposedChangeValueMapper";

const proposalInclude = {
  changes: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
  },
};

type ProposalReader = Pick<typeof changeProposalService, "getProposal">;
type ProposalCommitService = Pick<typeof stateCommitService, "commitExistingProposals">;
type ProposalArtifactService = Pick<typeof changeProposalArtifactService, "markStatus">;
type ProposalEventService = Pick<typeof directorAutomationLedgerEventService, "recordEvent">;
type ProposalStalenessService = Pick<typeof changeProposalStalenessService, "inspect">;
type ProposalPolicyGate = Pick<typeof changeProposalPolicyGateService, "evaluate">;

export type ChangeProposalExecutionAuthority = "explicit_review" | "automation";

export interface ChangeProposalExecutionOptions {
  authority?: ChangeProposalExecutionAuthority;
}

function artifactSnapshot(proposal: ChangeProposal) {
  return {
    id: proposal.id,
    novelId: proposal.novelId,
    chapterId: proposal.chapterId,
    taskId: proposal.taskId,
    status: proposal.status,
    summary: proposal.summary,
    version: proposal.version,
    sourceRefs: proposal.sourceRefs,
    content: proposal,
  };
}

function parseJson(value: string | null | undefined): unknown {
  if (!value?.trim()) {
    return undefined;
  }
  return JSON.parse(value) as unknown;
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

export class ChangeProposalApplyService {
  constructor(
    private readonly proposalReader: ProposalReader = changeProposalService,
    private readonly commitService: ProposalCommitService = stateCommitService,
    private readonly artifactService: ProposalArtifactService = changeProposalArtifactService,
    private readonly eventService: ProposalEventService = directorAutomationLedgerEventService,
    private readonly stalenessService: ProposalStalenessService = changeProposalStalenessService,
    private readonly policyGate: ProposalPolicyGate = changeProposalPolicyGateService,
  ) {}

  async executeProposal(
    novelId: string,
    proposalId: string,
    options: ChangeProposalExecutionOptions = {},
  ): Promise<ChangeProposal> {
    const authority = options.authority ?? "explicit_review";
    const row = await this.findRow(novelId, proposalId);
    assertChangeProposalTransition(row.status as ChangeProposalStatus, "executed");
    const stale = await this.stalenessService.inspect({
      proposalId: row.id,
      novelId,
      sourceRefs: parseProposalSourceRefs(row.sourceRefsJson),
    });
    if (stale.isStale) {
      throw new ChangeProposalError(
        "stale_proposal",
        "Change proposal sources changed before execution.",
        { reasons: stale.reasons },
      );
    }

    const approvedChanges = row.changes.filter((change) => (
      change.reviewDecision === "accepted" || change.reviewDecision === "modified"
    ));
    if (approvedChanges.length === 0) {
      throw new ChangeProposalError(
        "no_approved_changes",
        "Change proposal has no approved changes to execute.",
      );
    }
    if (authority === "automation") {
      const mappedProposal = mapChangeProposal(row, stale);
      const approvedIds = new Set(approvedChanges.map((change) => change.id));
      const policyEvaluation = await this.policyGate.evaluate(mappedProposal, {
        changes: mappedProposal.changes.filter((change) => approvedIds.has(change.id)),
      });
      if (!policyEvaluation.decision.canRun || policyEvaluation.decision.requiresApproval) {
        throw new ChangeProposalError(
          "approval_required",
          "Change proposal policy requires explicit review before execution.",
          {
            authority,
            autonomyLevel: policyEvaluation.autonomyLevel,
            directorPolicyMode: policyEvaluation.directorPolicyMode,
            policyMode: policyEvaluation.policyMode,
            policyDecision: policyEvaluation.decision,
          },
        );
      }
    }
    const ledgerOnlyChanges = approvedChanges.filter((change) => (
      getStateProposalApplicationMode(stateChangeProposalTypeSchema.parse(change.proposalType))
        === "ledger_only"
    ));
    if (ledgerOnlyChanges.length > 0) {
      throw new ChangeProposalError(
        "unsupported_change",
        "Change proposal contains approved items without a formal state applier.",
        {
          itemIds: ledgerOnlyChanges.map((change) => change.id),
          proposalTypes: [...new Set(ledgerOnlyChanges.map((change) => change.proposalType))],
        },
      );
    }
    // 复审 M4：下游写目标冲突必须在**最终 payload** 上校验。生产期
    // `downstreamPlanPatches` 恒为空，patch 是用户审阅时补的，因此只有这里
    // 才拿得到完整输入。两个已批准项写同一个 `chapterOrder + 字段` 会让结果
    // 依赖执行顺序，写入前必须拒绝。
    const divergenceChanges = approvedChanges.filter((change) => (
      change.proposalType === "chapter_execution_plan_update"
    ));
    if (divergenceChanges.length > 1) {
      const conflict = findConflictingDownstreamTarget(divergenceChanges.map((change) => ({
        path: change.changePath ?? undefined,
        payload: parseJsonRecord(
          change.reviewDecision === "modified" && change.userEditedPayloadJson
            ? change.userEditedPayloadJson
            : change.payloadJson,
        ),
      })));
      if (conflict) {
        throw new ChangeProposalError(
          "invalid_review",
          `Approved changes write the same downstream target ${conflict.target}; `
          + "reject one of them or merge the patches before executing.",
          { target: conflict.target, first: conflict.first, second: conflict.second },
        );
      }
    }

    for (const change of approvedChanges) {
      const isModified = change.reviewDecision === "modified";
      if (isModified && !change.userEditedPayloadJson) {
        throw new ChangeProposalError(
          "invalid_review",
          `Modified proposed change ${change.id} has no executable edited payload.`,
        );
      }
      const proposedValue = parseJson(change.afterJson);
      if (proposedValue !== undefined) {
        assertProposedValueMatchesPayload({
          proposalType: stateChangeProposalTypeSchema.parse(change.proposalType),
          path: change.changePath ?? "",
          payload: parseJsonRecord(isModified ? change.userEditedPayloadJson : change.payloadJson),
          proposedValue,
        });
      }
    }
    const invalidStatuses = approvedChanges.filter((change) => (
      change.status !== "pending_review" && change.status !== "committed"
    ));
    if (invalidStatuses.length > 0) {
      throw new ChangeProposalError(
        "invalid_review",
        "Approved changes are not in an executable state.",
        { itemIds: invalidStatuses.map((change) => change.id) },
      );
    }
    const pendingIds = approvedChanges
      .filter((change) => change.status === "pending_review")
      .map((change) => change.id);
    const chapterOrder = row.chapterId
      ? (await prisma.chapter.findFirst({
          where: { id: row.chapterId, novelId },
          select: { order: true },
        }))?.order ?? null
      : null;
    if (pendingIds.length > 0) {
      const result = await this.commitService.commitExistingProposals({
        novelId,
        proposalIds: pendingIds,
        chapterId: row.chapterId,
        chapterOrder,
        sourceType: "change_proposal_execution",
        sourceStage: "proposal_core",
        reason: `${proposalId}:v${row.version}:approved_items_only`,
      });
      if (result.committed.length !== pendingIds.length) {
        throw new ChangeProposalError(
          "version_conflict",
          "Not all approved proposal items were available for execution.",
          {
            expectedItemIds: pendingIds,
            committedItemIds: result.committed.flatMap((change) => change.id ? [change.id] : []),
          },
        );
      }
    }

    const committedCount = await prisma.stateChangeProposal.count({
      where: {
        id: { in: approvedChanges.map((change) => change.id) },
        changeProposalId: proposalId,
        status: "committed",
        reviewDecision: { in: ["accepted", "modified"] },
      },
    });
    if (committedCount !== approvedChanges.length) {
      throw new ChangeProposalError(
        "version_conflict",
        "Approved changes were not fully committed.",
        { expected: approvedChanges.length, committed: committedCount },
      );
    }
    const updated = await prisma.changeProposal.updateMany({
      where: {
        id: proposalId,
        novelId,
        version: row.version,
        status: { in: ["approved", "partially_approved"] },
      },
      data: {
        status: "executed",
        executedAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      throw new ChangeProposalError("version_conflict", "Change proposal changed during execution.");
    }
    const proposal = await this.proposalReader.getProposal(novelId, proposalId);
    await this.artifactService.markStatus(artifactSnapshot(proposal));
    await this.eventService.recordEvent({
      type: "proposal_applied",
      idempotencyKey: `${proposal.id}:${proposal.version}:applied`,
      taskId: proposal.taskId,
      novelId,
      artifactType: "change_proposal",
      summary: `Applied ${approvedChanges.length} approved proposal changes.`,
      affectedScope: proposal.chapterId ? `chapter:${proposal.chapterId}` : `novel:${novelId}`,
      severity: approvedChanges.some((change) => change.severity === "major") ? "high" : "low",
      metadata: {
        proposalId,
        version: proposal.version,
        appliedItemIds: approvedChanges.map((change) => change.id),
        rejectedItemIds: row.changes
          .filter((change) => change.reviewDecision === "rejected")
          .map((change) => change.id),
      },
    });
    return proposal;
  }

  private async findRow(novelId: string, proposalId: string): Promise<ChangeProposalRow> {
    const row = await prisma.changeProposal.findFirst({
      where: { id: proposalId, novelId },
      include: proposalInclude,
    });
    if (!row) {
      throw new ChangeProposalError("not_found", "Change proposal was not found.");
    }
    return row as unknown as ChangeProposalRow;
  }
}

export const changeProposalApplyService = new ChangeProposalApplyService();
