import {
  createChangeProposalInputSchema,
  proposedChangeInputSchema,
  regenerateChangeProposalInputSchema,
  type ChangeProposal,
  type ChangeProposalStatus,
  type CreateChangeProposalInput,
  type ProposedChangeInput,
  type RegenerateChangeProposalInput,
} from "@ai-novel/shared/types/changeProposal";
import { prisma } from "../../../../db/prisma";
import { directorAutomationLedgerEventService } from "../../director/runtime/DirectorAutomationLedgerEventService";
import { ChangeProposalError } from "../domain/ChangeProposalError";
import {
  assertChangeProposalTransition,
  assertExpectedProposalVersion,
} from "../domain/ChangeProposalStateMachine";
import {
  changeProposalArtifactService,
  type ChangeProposalArtifactSnapshot,
} from "../infrastructure/ChangeProposalArtifactService";
import {
  mapChangeProposal,
  parseProposalSourceRefs,
  type ChangeProposalRow,
} from "../infrastructure/ChangeProposalMapper";
import { changeProposalStalenessService } from "../infrastructure/ChangeProposalStalenessService";

const proposalInclude = {
  changes: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
  },
};

type ProposalArtifactService = Pick<
  typeof changeProposalArtifactService,
  "index" | "markStatus"
>;
type ProposalEventService = Pick<
  typeof directorAutomationLedgerEventService,
  "recordEvent"
>;
type ProposalStalenessService = Pick<
  typeof changeProposalStalenessService,
  "inspect"
>;

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
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

function severityRiskLevel(severity: ProposedChangeInput["severity"]): "low" | "high" {
  return severity === "major" ? "high" : "low";
}

function changeCreateData(
  novelId: string,
  chapterId: string | null,
  change: ProposedChangeInput,
) {
  return {
    novelId,
    chapterId,
    sourceSnapshotId: null,
    sourceType: "change_proposal",
    sourceStage: "proposal_core",
    proposalType: change.proposalType,
    riskLevel: severityRiskLevel(change.severity),
    status: "pending_review",
    summary: change.reason,
    payloadJson: json(change.payload),
    evidenceJson: json(change.evidence),
    validationNotesJson: json([]),
    changePath: change.path,
    operation: change.operation,
    category: change.category,
    severity: change.severity,
    beforeJson: change.before === undefined ? null : json(change.before),
    afterJson: change.after === undefined ? null : json(change.after),
    sourceRefsJson: json(change.sourceRefs),
  };
}

function allSourceRefs(input: CreateChangeProposalInput) {
  const byKey = new Map<string, CreateChangeProposalInput["sourceRefs"][number]>();
  for (const reference of input.sourceRefs.concat(input.changes.flatMap((change) => change.sourceRefs))) {
    byKey.set(JSON.stringify(reference), reference);
  }
  return [...byKey.values()];
}

export class ChangeProposalService {
  constructor(
    private readonly artifactService: ProposalArtifactService = changeProposalArtifactService,
    private readonly eventService: ProposalEventService = directorAutomationLedgerEventService,
    private readonly stalenessService: ProposalStalenessService = changeProposalStalenessService,
  ) {}

  async createProposal(novelId: string, rawInput: CreateChangeProposalInput): Promise<ChangeProposal> {
    const input = createChangeProposalInputSchema.parse(rawInput);
    await this.assertScope(novelId, input.chapterId ?? null, input.taskId ?? null);
    const status: ChangeProposalStatus = input.submitForReview ? "pending_review" : "draft";
    const sourceRefs = allSourceRefs(input);
    const created = await prisma.changeProposal.create({
      data: {
        novelId,
        chapterId: input.chapterId ?? null,
        taskId: input.taskId ?? null,
        proposalType: input.proposalType,
        version: 1,
        status,
        outlineFidelity: input.outlineFidelity ?? null,
        summary: input.summary,
        reasoningSummary: input.reasoningSummary ?? null,
        sourceRefsJson: json(sourceRefs),
        warningsJson: json(input.warnings),
        expectedStateJson: input.expectedState === undefined ? null : json(input.expectedState),
        changes: {
          create: input.changes.map((change) => changeCreateData(
            novelId,
            input.chapterId ?? null,
            change,
          )),
        },
      },
      include: proposalInclude,
    }) as unknown as ChangeProposalRow;
    const proposal = mapChangeProposal(created);
    const artifactId = await this.artifactService.index(this.toArtifactSnapshot(proposal));
    await this.eventService.recordEvent({
      type: "proposal_created",
      idempotencyKey: `${proposal.id}:${proposal.version}:created`,
      taskId: proposal.taskId,
      novelId: proposal.novelId,
      artifactId,
      artifactType: "change_proposal",
      summary: proposal.summary,
      affectedScope: proposal.chapterId ? `chapter:${proposal.chapterId}` : `novel:${proposal.novelId}`,
      severity: proposal.changes.some((change) => change.severity === "major") ? "high" : "low",
      metadata: {
        proposalId: proposal.id,
        version: proposal.version,
        proposalType: proposal.proposalType,
        status: proposal.status,
        changeCount: proposal.changes.length,
        reasoningSummary: proposal.reasoningSummary,
      },
    });
    return this.getProposal(novelId, proposal.id);
  }

  async getProposal(novelId: string, proposalId: string): Promise<ChangeProposal> {
    const row = await this.findRow(novelId, proposalId);
    const stale = await this.stalenessService.inspect({
      proposalId: row.id,
      novelId,
      sourceRefs: parseProposalSourceRefs(row.sourceRefsJson),
    });
    return mapChangeProposal(row, stale);
  }

  async listProposals(input: {
    novelId: string;
    status?: string;
    proposalType?: string;
    chapterId?: string;
  }): Promise<ChangeProposal[]> {
    const rows = await prisma.changeProposal.findMany({
      where: {
        novelId: input.novelId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.proposalType ? { proposalType: input.proposalType } : {}),
        ...(input.chapterId ? { chapterId: input.chapterId } : {}),
      },
      include: proposalInclude,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: 100,
    }) as unknown as ChangeProposalRow[];
    return Promise.all(rows.map(async (row) => {
      const stale = await this.stalenessService.inspect({
        proposalId: row.id,
        novelId: input.novelId,
        sourceRefs: parseProposalSourceRefs(row.sourceRefsJson),
      });
      return mapChangeProposal(row, stale);
    }));
  }

  async submitForReview(
    novelId: string,
    proposalId: string,
    expectedVersion?: number,
  ): Promise<ChangeProposal> {
    const row = await this.findRow(novelId, proposalId);
    assertExpectedProposalVersion(row.version, expectedVersion);
    assertChangeProposalTransition(row.status as ChangeProposalStatus, "pending_review");
    await this.assertNotStale(row);
    const updated = await prisma.changeProposal.updateMany({
      where: { id: proposalId, novelId, status: "draft", version: row.version },
      data: { status: "pending_review" },
    });
    if (updated.count !== 1) {
      throw new ChangeProposalError("version_conflict", "Change proposal changed before submission.");
    }
    const proposal = await this.getProposal(novelId, proposalId);
    await this.artifactService.markStatus(this.toArtifactSnapshot(proposal));
    return proposal;
  }

  async regenerateProposal(
    novelId: string,
    proposalId: string,
    rawInput: RegenerateChangeProposalInput,
  ): Promise<ChangeProposal> {
    const input = regenerateChangeProposalInputSchema.parse(rawInput);
    const previous = await this.findRow(novelId, proposalId);
    assertChangeProposalTransition(previous.status as ChangeProposalStatus, "superseded");
    const changes = input.changes ?? previous.changes.map((change) => proposedChangeInputSchema.parse({
      proposalType: change.proposalType,
      path: change.changePath,
      operation: change.operation,
      category: change.category,
      severity: change.severity,
      before: parseJson(change.beforeJson),
      after: parseJson(change.afterJson),
      payload: parseRecord(change.userEditedPayloadJson ?? change.payloadJson),
      reason: change.summary,
      sourceRefs: parseProposalSourceRefs(change.sourceRefsJson),
      evidence: parseStringArray(change.evidenceJson),
    }));
    const sourceRefs = input.sourceRefs ?? parseProposalSourceRefs(previous.sourceRefsJson);
    const status: ChangeProposalStatus = input.submitForReview ? "pending_review" : "draft";
    const created = await prisma.$transaction(async (tx) => {
      const superseded = await tx.changeProposal.updateMany({
        where: {
          id: previous.id,
          novelId,
          status: previous.status,
          version: previous.version,
        },
        data: { status: "superseded" },
      });
      if (superseded.count !== 1) {
        throw new ChangeProposalError("version_conflict", "Change proposal changed before regeneration.");
      }
      return tx.changeProposal.create({
        data: {
          novelId,
          chapterId: previous.chapterId,
          taskId: previous.taskId,
          proposalType: previous.proposalType,
          version: previous.version + 1,
          supersedesId: previous.id,
          status,
          outlineFidelity: previous.outlineFidelity,
          summary: input.summary ?? previous.summary,
          reasoningSummary: input.reasoningSummary === undefined
            ? previous.reasoningSummary
            : input.reasoningSummary,
          sourceRefsJson: json(sourceRefs),
          warningsJson: input.warnings === undefined
            ? previous.warningsJson
            : json(input.warnings),
          expectedStateJson: input.expectedState === undefined
            ? previous.expectedStateJson
            : json(input.expectedState),
          changes: {
            create: changes.map((change) => changeCreateData(novelId, previous.chapterId, change)),
          },
        },
        include: proposalInclude,
      });
    }) as unknown as ChangeProposalRow;
    const oldProposal = mapChangeProposal({ ...previous, status: "superseded" });
    await this.artifactService.markStatus(this.toArtifactSnapshot(oldProposal));
    const proposal = mapChangeProposal(created);
    const artifactId = await this.artifactService.index(this.toArtifactSnapshot(proposal));
    await this.eventService.recordEvent({
      type: "proposal_superseded",
      idempotencyKey: `${previous.id}:${previous.version}:superseded`,
      taskId: previous.taskId,
      novelId,
      artifactId,
      artifactType: "change_proposal",
      summary: `Proposal v${previous.version} superseded by v${proposal.version}.`,
      affectedScope: previous.chapterId ? `chapter:${previous.chapterId}` : `novel:${novelId}`,
      severity: "low",
      metadata: {
        proposalId: previous.id,
        supersededByProposalId: proposal.id,
        previousVersion: previous.version,
        nextVersion: proposal.version,
      },
    });
    return this.getProposal(novelId, proposal.id);
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

  private async assertScope(
    novelId: string,
    chapterId: string | null,
    taskId: string | null,
  ): Promise<void> {
    const [novel, chapter, task] = await Promise.all([
      prisma.novel.findUnique({ where: { id: novelId }, select: { id: true } }),
      chapterId
        ? prisma.chapter.findFirst({ where: { id: chapterId, novelId }, select: { id: true } })
        : Promise.resolve({ id: "no-chapter" }),
      taskId
        ? prisma.novelWorkflowTask.findFirst({ where: { id: taskId, novelId }, select: { id: true } })
        : Promise.resolve({ id: "no-task" }),
    ]);
    if (!novel) {
      throw new ChangeProposalError("not_found", "Novel was not found.");
    }
    if (!chapter) {
      throw new ChangeProposalError("invalid_review", "Chapter does not belong to the novel.");
    }
    if (!task) {
      throw new ChangeProposalError("invalid_review", "Workflow task does not belong to the novel.");
    }
  }

  private async assertNotStale(row: ChangeProposalRow): Promise<void> {
    const stale = await this.stalenessService.inspect({
      proposalId: row.id,
      novelId: row.novelId,
      sourceRefs: parseProposalSourceRefs(row.sourceRefsJson),
    });
    if (stale.isStale) {
      throw new ChangeProposalError(
        "stale_proposal",
        "Change proposal sources changed before review.",
        { reasons: stale.reasons },
      );
    }
  }

  private toArtifactSnapshot(proposal: ChangeProposal): ChangeProposalArtifactSnapshot {
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
}

export const changeProposalService = new ChangeProposalService();
