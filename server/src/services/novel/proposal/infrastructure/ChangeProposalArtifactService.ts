import type {
  ChangeProposalStatus,
  ProposalSourceReference,
} from "@ai-novel/shared/types/changeProposal";
import type { DirectorArtifactStatus } from "@ai-novel/shared/types/directorRuntime";
import { prisma } from "../../../../db/prisma";
import {
  ArtifactWriter,
  type DirectorArtifactWriteInput,
} from "../../director/runtime/DirectorArtifactGateway";

export interface ChangeProposalArtifactSnapshot {
  id: string;
  novelId: string;
  chapterId: string | null;
  taskId: string | null;
  status: ChangeProposalStatus;
  summary: string;
  version: number;
  sourceRefs: ProposalSourceReference[];
  content: unknown;
}

function artifactStatus(status: ChangeProposalStatus): DirectorArtifactStatus {
  if (status === "draft") {
    return "draft";
  }
  if (status === "rejected") {
    return "rejected";
  }
  if (status === "superseded") {
    return "superseded";
  }
  return "active";
}

function writeInput(
  snapshot: ChangeProposalArtifactSnapshot,
): DirectorArtifactWriteInput {
  return {
    novelId: snapshot.novelId,
    taskId: snapshot.taskId,
    artifactType: "change_proposal",
    targetType: snapshot.chapterId ? "chapter" : "novel",
    targetId: snapshot.chapterId ?? snapshot.novelId,
    contentTable: "ChangeProposal",
    contentId: snapshot.id,
    contentText: JSON.stringify(snapshot.content),
    status: artifactStatus(snapshot.status),
    source: "ai_generated",
    dependsOn: snapshot.sourceRefs.flatMap((reference) => (
      reference.kind === "director_artifact"
        ? [{ artifactId: reference.artifactId, version: reference.version }]
        : []
    )),
  };
}

export class ChangeProposalArtifactService {
  private readonly writer = new ArtifactWriter();

  async index(snapshot: ChangeProposalArtifactSnapshot): Promise<string> {
    const input = writeInput(snapshot);
    const artifact = await this.writer.upsert(input);
    const dependencies = input.dependsOn ?? [];
    await prisma.$transaction(async (tx) => {
      await tx.directorArtifactDependency.deleteMany({
        where: { artifactId: artifact.id },
      });
      if (dependencies.length > 0) {
        await tx.directorArtifactDependency.createMany({
          data: dependencies.map((dependency) => ({
            artifactId: artifact.id,
            dependsOnArtifactId: dependency.artifactId,
            dependsOnVersion: dependency.version ?? null,
          })),
        });
      }
    });
    return artifact.id;
  }

  async markUserEdited(snapshot: ChangeProposalArtifactSnapshot): Promise<void> {
    await this.writer.markUserEdited(writeInput(snapshot));
  }

  async markStatus(snapshot: ChangeProposalArtifactSnapshot): Promise<void> {
    await this.writer.upsert(writeInput(snapshot));
  }
}

export const changeProposalArtifactService = new ChangeProposalArtifactService();
