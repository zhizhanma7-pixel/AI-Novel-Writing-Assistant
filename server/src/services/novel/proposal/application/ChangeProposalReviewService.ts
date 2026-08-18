import {
  editProposedChangeInputSchema,
  rejectChangeProposalInputSchema,
  reviewChangeProposalInputSchema,
  type ChangeProposal,
  type ChangeProposalStatus,
  type EditProposedChangeInput,
  type ProposedChangeItemDecision,
  type RejectChangeProposalInput,
  type ReviewChangeProposalInput,
} from "@ai-novel/shared/types/changeProposal";
import { prisma } from "../../../../db/prisma";
import { directorAutomationLedgerEventService } from "../../director/runtime/DirectorAutomationLedgerEventService";
import { ChangeProposalError } from "../domain/ChangeProposalError";
import {
  assertChangeProposalTransition,
  assertExpectedProposalVersion,
} from "../domain/ChangeProposalStateMachine";
import { changeProposalArtifactService } from "../infrastructure/ChangeProposalArtifactService";
import {
  parseProposalSourceRefs,
  type ChangeProposalRow,
} from "../infrastructure/ChangeProposalMapper";
import { changeProposalStalenessService } from "../infrastructure/ChangeProposalStalenessService";
import { changeProposalService } from "./ChangeProposalService";

const proposalInclude = {
  changes: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
  },
};

type ProposalReader = Pick<typeof changeProposalService, "getProposal">;
type ProposalArtifactService = Pick<
  typeof changeProposalArtifactService,
  "markStatus" | "markUserEdited"
>;
type ProposalEventService = Pick<
  typeof directorAutomationLedgerEventService,
  "recordEvent"
>;
type ProposalStalenessService = Pick<
  typeof changeProposalStalenessService,
  "inspect"
>;

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

function decisionMap(decisions: ProposedChangeItemDecision[] | undefined) {
  if (!decisions) {
    return null;
  }
  const byId = new Map<string, ProposedChangeItemDecision>();
  for (const decision of decisions) {
    if (byId.has(decision.id)) {
      throw new ChangeProposalError(
        "invalid_review",
        `Proposed change ${decision.id} has more than one review decision.`,
      );
    }
    byId.set(decision.id, decision);
  }
  return byId;
}

export class ChangeProposalReviewService {
  constructor(
    private readonly proposalReader: ProposalReader = changeProposalService,
    private readonly artifactService: ProposalArtifactService = changeProposalArtifactService,
    private readonly eventService: ProposalEventService = directorAutomationLedgerEventService,
    private readonly stalenessService: ProposalStalenessService = changeProposalStalenessService,
  ) {}

  async editProposedChange(
    novelId: string,
    proposalId: string,
    itemId: string,
    rawInput: EditProposedChangeInput,
  ): Promise<ChangeProposal> {
    const input = editProposedChangeInputSchema.parse(rawInput);
    const row = await this.findRow(novelId, proposalId);
    if (row.status !== "draft" && row.status !== "pending_review") {
      throw new ChangeProposalError(
        "invalid_transition",
        `Proposed values cannot be edited while proposal status is ${row.status}.`,
      );
    }
    const item = row.changes.find((change) => change.id === itemId);
    if (!item) {
      throw new ChangeProposalError("not_found", "Proposed change was not found.");
    }
    const userEditedPayloadJson = input.payload !== undefined
      ? JSON.stringify(input.payload)
      : input.after !== undefined
        ? item.userEditedPayloadJson ?? item.payloadJson
        : undefined;
    await prisma.stateChangeProposal.update({
      where: { id: itemId },
      data: {
        ...(userEditedPayloadJson !== undefined
          ? { userEditedPayloadJson }
          : {}),
        ...(input.after !== undefined
          ? { afterJson: JSON.stringify(input.after) }
          : {}),
        reviewDecision: null,
        status: "pending_review",
      },
    });
    const proposal = await this.proposalReader.getProposal(novelId, proposalId);
    await this.artifactService.markUserEdited(artifactSnapshot(proposal));
    await this.eventService.recordEvent({
      type: "proposal_reviewed",
      idempotencyKey: `${proposal.id}:${proposal.version}:item:${itemId}:edited:${proposal.updatedAt}`,
      taskId: proposal.taskId,
      novelId,
      artifactType: "change_proposal",
      summary: `Proposed change ${itemId} was edited before approval.`,
      affectedScope: proposal.chapterId ? `chapter:${proposal.chapterId}` : `novel:${novelId}`,
      severity: item.severity === "major" ? "high" : "low",
      metadata: {
        proposalId,
        version: proposal.version,
        itemId,
        action: "edited_before_approval",
      },
    });
    return proposal;
  }

  async approveProposal(
    novelId: string,
    proposalId: string,
    rawInput: ReviewChangeProposalInput = {},
  ): Promise<ChangeProposal> {
    const input = reviewChangeProposalInputSchema.parse(rawInput);
    const row = await this.findRow(novelId, proposalId);
    assertExpectedProposalVersion(row.version, input.expectedVersion);
    await this.assertReviewableAndFresh(row);
    const byId = decisionMap(input.itemDecisions);
    if (byId) {
      const knownIds = new Set(row.changes.map((change) => change.id));
      const unknownIds = [...byId.keys()].filter((id) => !knownIds.has(id));
      if (unknownIds.length > 0) {
        throw new ChangeProposalError(
          "invalid_review",
          "Review contains proposed changes outside this proposal.",
          { unknownIds },
        );
      }
    }

    const resolved = row.changes.map((change) => {
      const explicit = byId?.get(change.id);
      const decision = explicit?.decision
        ?? (byId ? "rejected" : (change.userEditedPayloadJson ? "modified" : "accepted"));
      const editedPayloadJson = explicit?.editedPayload !== undefined
        ? JSON.stringify(explicit.editedPayload)
        : change.userEditedPayloadJson;
      if (decision === "modified" && !editedPayloadJson) {
        throw new ChangeProposalError(
          "invalid_review",
          `Modified proposed change ${change.id} requires an edited payload.`,
        );
      }
      return {
        change,
        decision,
        editedPayloadJson,
        editedValue: explicit?.editedValue,
      };
    });
    const approvedCount = resolved.filter((item) => item.decision !== "rejected").length;
    if (approvedCount === 0) {
      throw new ChangeProposalError(
        "invalid_review",
        "Partial approval must approve or modify at least one proposed change.",
      );
    }
    const nextStatus: ChangeProposalStatus = approvedCount === resolved.length
      ? "approved"
      : "partially_approved";
    assertChangeProposalTransition(row.status as ChangeProposalStatus, nextStatus);

    await prisma.$transaction(async (tx) => {
      const updated = await tx.changeProposal.updateMany({
        where: {
          id: proposalId,
          novelId,
          status: "pending_review",
          version: row.version,
        },
        data: {
          status: nextStatus,
          approvedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        throw new ChangeProposalError("version_conflict", "Change proposal changed during review.");
      }
      for (const item of resolved) {
        await tx.stateChangeProposal.update({
          where: { id: item.change.id },
          data: {
            status: item.decision === "rejected" ? "rejected" : "pending_review",
            reviewDecision: item.decision,
            userEditedPayloadJson: item.editedPayloadJson,
            ...(item.editedValue !== undefined
              ? { afterJson: JSON.stringify(item.editedValue) }
              : {}),
          },
        });
      }
    });

    const proposal = await this.proposalReader.getProposal(novelId, proposalId);
    if (resolved.some((item) => item.decision === "modified")) {
      await this.artifactService.markUserEdited(artifactSnapshot(proposal));
    } else {
      await this.artifactService.markStatus(artifactSnapshot(proposal));
    }
    await this.recordReviewEvent(proposal, {
      acceptedCount: resolved.filter((item) => item.decision === "accepted").length,
      modifiedCount: resolved.filter((item) => item.decision === "modified").length,
      rejectedCount: resolved.filter((item) => item.decision === "rejected").length,
    });
    return proposal;
  }

  async rejectProposal(
    novelId: string,
    proposalId: string,
    rawInput: RejectChangeProposalInput = {},
  ): Promise<ChangeProposal> {
    const input = rejectChangeProposalInputSchema.parse(rawInput);
    const row = await this.findRow(novelId, proposalId);
    assertExpectedProposalVersion(row.version, input.expectedVersion);
    assertChangeProposalTransition(row.status as ChangeProposalStatus, "rejected");
    await prisma.$transaction(async (tx) => {
      const updated = await tx.changeProposal.updateMany({
        where: {
          id: proposalId,
          novelId,
          status: "pending_review",
          version: row.version,
        },
        data: { status: "rejected" },
      });
      if (updated.count !== 1) {
        throw new ChangeProposalError("version_conflict", "Change proposal changed during rejection.");
      }
      await tx.stateChangeProposal.updateMany({
        where: { changeProposalId: proposalId },
        data: {
          status: "rejected",
          reviewDecision: "rejected",
          validationNotesJson: JSON.stringify([
            ...(input.reason ? [`proposal_rejected:${input.reason}`] : ["proposal_rejected"]),
          ]),
        },
      });
    });
    const proposal = await this.proposalReader.getProposal(novelId, proposalId);
    await this.artifactService.markStatus(artifactSnapshot(proposal));
    await this.recordReviewEvent(proposal, {
      acceptedCount: 0,
      modifiedCount: 0,
      rejectedCount: row.changes.length,
      rejectionReason: input.reason ?? null,
    });
    return proposal;
  }

  private async assertReviewableAndFresh(row: ChangeProposalRow): Promise<void> {
    if (row.status !== "pending_review") {
      assertChangeProposalTransition(row.status as ChangeProposalStatus, "approved");
    }
    const stale = await this.stalenessService.inspect({
      proposalId: row.id,
      novelId: row.novelId,
      sourceRefs: parseProposalSourceRefs(row.sourceRefsJson),
    });
    if (stale.isStale) {
      throw new ChangeProposalError(
        "stale_proposal",
        "Change proposal sources changed before approval.",
        { reasons: stale.reasons },
      );
    }
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

  private async recordReviewEvent(
    proposal: ChangeProposal,
    counts: {
      acceptedCount: number;
      modifiedCount: number;
      rejectedCount: number;
      rejectionReason?: string | null;
    },
  ): Promise<void> {
    await this.eventService.recordEvent({
      type: "proposal_reviewed",
      idempotencyKey: `${proposal.id}:${proposal.version}:reviewed`,
      taskId: proposal.taskId,
      novelId: proposal.novelId,
      artifactType: "change_proposal",
      summary: `Proposal review completed with status ${proposal.status}.`,
      affectedScope: proposal.chapterId
        ? `chapter:${proposal.chapterId}`
        : `novel:${proposal.novelId}`,
      severity: proposal.changes.some((change) => change.severity === "major") ? "high" : "low",
      metadata: {
        proposalId: proposal.id,
        version: proposal.version,
        status: proposal.status,
        ...counts,
      },
    });
  }
}

export const changeProposalReviewService = new ChangeProposalReviewService();
