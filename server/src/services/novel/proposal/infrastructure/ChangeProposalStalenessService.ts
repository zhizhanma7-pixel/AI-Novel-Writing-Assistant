import type { ProposalSourceReference } from "@ai-novel/shared/types/changeProposal";
import { prisma } from "../../../../db/prisma";
import { stableDirectorContentHash } from "../../director/runtime/DirectorArtifactLedger";
import type { ChangeProposalStaleState } from "./ChangeProposalMapper";

const STALE_ARTIFACT_STATUSES = new Set(["stale", "superseded", "rejected"]);

interface ArtifactDependencyRow {
  dependsOnVersion: number | null;
  dependsOn: {
    id: string;
    version: number;
    status: string;
  };
}

interface ArtifactRow {
  id: string;
  version: number;
  status: string;
  contentHash: string | null;
  dependencies: ArtifactDependencyRow[];
}

export class ChangeProposalStalenessService {
  async inspect(input: {
    proposalId: string;
    novelId: string;
    sourceRefs: ProposalSourceReference[];
  }): Promise<ChangeProposalStaleState> {
    const artifactRefs = input.sourceRefs.filter(
      (reference): reference is Extract<ProposalSourceReference, { kind: "director_artifact" }> => (
        reference.kind === "director_artifact"
      ),
    );
    const chapterRefs = input.sourceRefs.filter(
      (reference): reference is Extract<ProposalSourceReference, { kind: "chapter" }> => (
        reference.kind === "chapter"
      ),
    );
    const [artifactRows, proposalArtifact, chapterRows] = await Promise.all([
      artifactRefs.length > 0
        ? prisma.directorArtifact.findMany({
            where: {
              novelId: input.novelId,
              id: { in: artifactRefs.map((reference) => reference.artifactId) },
            },
            select: {
              id: true,
              version: true,
              status: true,
              contentHash: true,
              dependencies: {
                select: {
                  dependsOnVersion: true,
                  dependsOn: {
                    select: { id: true, version: true, status: true },
                  },
                },
              },
            },
          }) as Promise<ArtifactRow[]>
        : Promise.resolve([] as ArtifactRow[]),
      prisma.directorArtifact.findFirst({
        where: {
          novelId: input.novelId,
          artifactType: "change_proposal",
          contentTable: "ChangeProposal",
          contentId: input.proposalId,
        },
        select: { status: true },
      }),
      chapterRefs.length > 0
        ? prisma.chapter.findMany({
            where: {
              novelId: input.novelId,
              id: { in: chapterRefs.map((reference) => reference.chapterId) },
            },
            select: { id: true, content: true },
          })
        : Promise.resolve([]),
    ]);

    const reasons = new Set<string>();
    if (proposalArtifact && STALE_ARTIFACT_STATUSES.has(proposalArtifact.status)) {
      reasons.add(`proposal_artifact:${proposalArtifact.status}`);
    }

    const artifactById = new Map(artifactRows.map((row) => [row.id, row]));
    for (const reference of artifactRefs) {
      const row = artifactById.get(reference.artifactId);
      if (!row) {
        reasons.add(`source_artifact_missing:${reference.artifactId}`);
        continue;
      }
      if (STALE_ARTIFACT_STATUSES.has(row.status)) {
        reasons.add(`source_artifact_${row.status}:${row.id}`);
      }
      if (row.version !== reference.version) {
        reasons.add(`source_artifact_version_changed:${row.id}:${reference.version}->${row.version}`);
      }
      if (reference.contentHash && row.contentHash !== reference.contentHash) {
        reasons.add(`source_artifact_content_changed:${row.id}`);
      }
      for (const dependency of row.dependencies) {
        if (STALE_ARTIFACT_STATUSES.has(dependency.dependsOn.status)) {
          reasons.add(`source_dependency_${dependency.dependsOn.status}:${dependency.dependsOn.id}`);
          continue;
        }
        if (
          dependency.dependsOnVersion !== null
          && dependency.dependsOnVersion !== dependency.dependsOn.version
        ) {
          reasons.add(
            `source_dependency_version_changed:${dependency.dependsOn.id}:${dependency.dependsOnVersion}->${dependency.dependsOn.version}`,
          );
        }
      }
    }

    const chapterById = new Map(chapterRows.map((row) => [row.id, row]));
    for (const reference of chapterRefs) {
      const row = chapterById.get(reference.chapterId);
      if (!row) {
        reasons.add(`source_chapter_missing:${reference.chapterId}`);
        continue;
      }
      if (reference.contentHash && stableDirectorContentHash(row.content) !== reference.contentHash) {
        reasons.add(`source_chapter_content_changed:${reference.chapterId}`);
      }
    }

    const normalizedReasons = [...reasons].sort();
    return {
      isStale: normalizedReasons.length > 0,
      reasons: normalizedReasons,
    };
  }
}

export const changeProposalStalenessService = new ChangeProposalStalenessService();
