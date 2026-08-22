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
import { stateChangeProposalTypeSchema } from "@ai-novel/shared/types/canonicalState";
import { prisma } from "../../../../db/prisma";
import { directorAutomationLedgerEventService } from "../../director/runtime/DirectorAutomationLedgerEventService";
import { ChangeProposalError } from "../domain/ChangeProposalError";
import {
  applyEditedValueToPayload,
  resolveEditedValueFromPayload,
} from "../domain/ProposedChangeValueMapper";
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

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
    assertExpectedProposalVersion(row.version, input.expectedVersion);
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
    const basePayload = input.payload
      ?? parseJsonRecord(item.userEditedPayloadJson ?? item.payloadJson);
    const editedPayload = input.after !== undefined
      ? applyEditedValueToPayload({
          proposalType: stateChangeProposalTypeSchema.parse(item.proposalType),
          path: item.changePath ?? "",
          payload: basePayload,
          editedValue: input.after,
        })
      : basePayload;
    const userEditedPayloadJson = JSON.stringify(editedPayload);
    const proposalType = stateChangeProposalTypeSchema.parse(item.proposalType);
    const effectiveAfter = input.after !== undefined
      ? { mapped: true as const, value: input.after }
      : resolveEditedValueFromPayload({
          proposalType,
          path: item.changePath ?? "",
          payload: editedPayload,
        });
    await prisma.$transaction(async (tx) => {
      const lockedProposal = await tx.changeProposal.updateMany({
        where: {
          id: proposalId,
          novelId,
          version: row.version,
          status: { in: ["draft", "pending_review"] },
        },
        data: { updatedAt: new Date() },
      });
      if (lockedProposal.count !== 1) {
        throw new ChangeProposalError(
          "version_conflict",
          "Change proposal changed during item editing.",
        );
      }

      const updatedItem = await tx.stateChangeProposal.updateMany({
        where: {
          id: itemId,
          changeProposalId: proposalId,
          status: "pending_review",
        },
        data: {
          ...(userEditedPayloadJson !== undefined
            ? { userEditedPayloadJson }
            : {}),
          afterJson: effectiveAfter.mapped ? JSON.stringify(effectiveAfter.value) : null,
          reviewDecision: null,
          status: "pending_review",
        },
      });
      if (updatedItem.count !== 1) {
        throw new ChangeProposalError(
          "version_conflict",
          "Proposed change changed during item editing.",
        );
      }
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
      const hasExplicitEdit = explicit?.editedPayload !== undefined
        || explicit?.editedValue !== undefined;
      if (
        change.userEditedPayloadJson
        && explicit?.decision === "accepted"
      ) {
        throw new ChangeProposalError(
          "invalid_review",
          `Proposed change ${change.id} was edited and must be approved as modified or regenerated.`,
        );
      }
      if (
        explicit?.decision === "modified"
        && !hasExplicitEdit
        && !change.userEditedPayloadJson
      ) {
        throw new ChangeProposalError(
          "invalid_review",
          `Proposed change ${change.id} has no stored or submitted edited payload.`,
        );
      }
      const unlistedDecision = change.userEditedPayloadJson
        ? "modified"
        : input.unlistedDecision;
      const decision = explicit?.decision
        ?? (byId
          ? unlistedDecision
          : (change.userEditedPayloadJson ? "modified" : "accepted"));
      if (!decision) {
        throw new ChangeProposalError(
          "invalid_review",
          `Review decision for proposed change ${change.id} is missing. Set unlistedDecision or include every item.`,
        );
      }
      const baseEditedPayload = explicit?.editedPayload
        ?? parseJsonRecord(change.userEditedPayloadJson ?? change.payloadJson);
      const editedPayload = explicit?.editedValue !== undefined
        ? applyEditedValueToPayload({
            proposalType: stateChangeProposalTypeSchema.parse(change.proposalType),
            path: change.changePath ?? "",
            payload: baseEditedPayload,
            editedValue: explicit.editedValue,
          })
        : baseEditedPayload;
      const editedPayloadJson = decision === "modified"
        ? JSON.stringify(editedPayload)
        : null;
      const effectiveAfter = explicit?.editedValue !== undefined
        ? { mapped: true as const, value: explicit.editedValue }
        : resolveEditedValueFromPayload({
            proposalType: stateChangeProposalTypeSchema.parse(change.proposalType),
            path: change.changePath ?? "",
            payload: editedPayload,
          });
      return {
        change,
        decision,
        editedPayloadJson,
        editedAfterJson: decision === "modified" && effectiveAfter.mapped
          ? JSON.stringify(effectiveAfter.value)
          : null,
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
            ...(item.decision === "modified"
              ? { afterJson: item.editedAfterJson }
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
