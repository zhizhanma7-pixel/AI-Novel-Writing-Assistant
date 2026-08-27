import type { StateChangeProposal } from "@ai-novel/shared/types/canonicalState";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../db/prisma";
import { StateProposalDomainError } from "../../state/StateProposalDomainError";

const PLAN_FIELD_ALLOWLIST = new Set(["title", "expectation", "taskSheet"]);

export type ChapterPlanMutation = {
  operation: "update_plan_fields" | "remove" | "reorder";
  chapterId?: string;
  currentChapterOrder: number;
  nextChapterOrder?: number;
  fields?: Array<"title" | "expectation" | "taskSheet">;
};

export interface ChapterPlanImpactProbeInput {
  novelId: string;
  mutations: ChapterPlanMutation[];
}

export interface ChapterContentImpact {
  chapterOrder: number;
  chapterId: string;
  hasExistingContent: boolean;
  code:
    | "chapter_plan_update"
    | "existing_chapter_content"
    | "chapter_removal_blocked"
    | "chapter_reorder_blocked";
  severityFloor: "minor" | "major";
}

type ChapterReadClient = Pick<Prisma.TransactionClient, "chapter">;

type ExistingChapter = {
  id: string;
  order: number;
  content: string | null;
};

function hasExistingContent(chapter: ExistingChapter): boolean {
  return Boolean(chapter.content?.trim());
}

function resolveMutationTarget(
  chapters: ExistingChapter[],
  mutation: ChapterPlanMutation,
): ExistingChapter | null {
  const target = mutation.chapterId
    ? chapters.find((chapter) => chapter.id === mutation.chapterId)
    : chapters.find((chapter) => chapter.order === mutation.currentChapterOrder);
  if (!target || target.order !== mutation.currentChapterOrder) {
    return null;
  }
  return target;
}

function assertMutationShape(
  mutation: ChapterPlanMutation,
  proposalType: StateChangeProposal["proposalType"],
): void {
  if (!Number.isInteger(mutation.currentChapterOrder) || mutation.currentChapterOrder <= 0) {
    throw new StateProposalDomainError({
      proposalType,
      reason: "invalid_payload",
      message: "Chapter plan mutation has an invalid current chapter order.",
    });
  }
  if (!["update_plan_fields", "remove", "reorder"].includes(mutation.operation)) {
    throw new StateProposalDomainError({
      proposalType,
      reason: "invalid_payload",
      message: "Chapter plan mutation has an unsupported operation.",
    });
  }
  if (mutation.operation === "update_plan_fields") {
    if (
      !mutation.fields?.length
      || mutation.fields.some((field) => !PLAN_FIELD_ALLOWLIST.has(field))
    ) {
      throw new StateProposalDomainError({
        proposalType,
        reason: "invalid_payload",
        message: "Chapter plan mutation attempts to write a protected chapter field.",
      });
    }
    return;
  }
  if (mutation.operation === "reorder" && (
    !Number.isInteger(mutation.nextChapterOrder)
    || Number(mutation.nextChapterOrder) <= 0
    || mutation.nextChapterOrder === mutation.currentChapterOrder
  )) {
    throw new StateProposalDomainError({
      proposalType,
      reason: "invalid_payload",
      message: "Chapter plan reorder mutation has an invalid target order.",
    });
  }
}

async function readExistingChapters(
  db: ChapterReadClient,
  novelId: string,
): Promise<ExistingChapter[]> {
  return db.chapter.findMany({
    where: { novelId },
    orderBy: { order: "asc" },
    select: { id: true, order: true, content: true },
  });
}

export async function probeChapterPlanImpacts(
  input: ChapterPlanImpactProbeInput,
  db: ChapterReadClient = prisma,
): Promise<ChapterContentImpact[]> {
  const chapters = await readExistingChapters(db, input.novelId);
  return input.mutations.flatMap((mutation) => {
    const chapter = resolveMutationTarget(chapters, mutation);
    if (!chapter) return [];
    const contentExists = hasExistingContent(chapter);
    const code = contentExists && mutation.operation === "remove"
      ? "chapter_removal_blocked"
      : contentExists && mutation.operation === "reorder"
        ? "chapter_reorder_blocked"
        : contentExists
          ? "existing_chapter_content"
          : "chapter_plan_update";
    return [{
      chapterOrder: chapter.order,
      chapterId: chapter.id,
      hasExistingContent: contentExists,
      code,
      severityFloor: contentExists ? "major" : "minor",
    }];
  });
}

/**
 * Must run before the applier issues any write. This guard only reads current
 * chapter rows, so callers may safely surface its domain error inside the
 * surrounding state-proposal transaction.
 */
export async function assertChapterPlanWriteIsSafe(
  tx: Prisma.TransactionClient,
  input: ChapterPlanImpactProbeInput & {
    proposalType: StateChangeProposal["proposalType"];
  },
): Promise<void> {
  input.mutations.forEach((mutation) => assertMutationShape(mutation, input.proposalType));
  const chapters = await readExistingChapters(tx, input.novelId);
  for (const mutation of input.mutations) {
    const chapter = resolveMutationTarget(chapters, mutation);
    if (!chapter) {
      throw new StateProposalDomainError({
        proposalType: input.proposalType,
        reason: "invalid_payload",
        message: "Chapter plan mutation references a missing or stale chapter.",
      });
    }
    if (
      hasExistingContent(chapter)
      && (mutation.operation === "remove" || mutation.operation === "reorder")
    ) {
      throw new StateProposalDomainError({
        proposalType: input.proposalType,
        reason: "chapter_content_protected",
        message: "A chapter with existing content cannot be removed or reordered by a planning proposal.",
      });
    }
  }
}
