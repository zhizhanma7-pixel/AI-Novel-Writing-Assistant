import type { StateChangeProposal } from "@ai-novel/shared/types/canonicalState";
import { outlinePlanUpdatePayloadSchema } from "@ai-novel/shared/types/outlineWorkflow";
import type { Prisma } from "@prisma/client";
import { StateProposalDomainError } from "../../../state/StateProposalDomainError";

export async function applyOutlinePlanUpdate(
  tx: Prisma.TransactionClient,
  proposal: StateChangeProposal,
): Promise<void> {
  const parsed = outlinePlanUpdatePayloadSchema.safeParse(proposal.payload);
  if (!parsed.success) {
    throw new StateProposalDomainError({
      proposalType: "outline_plan_update",
      reason: "invalid_payload",
      message: "Outline plan proposal has an invalid payload.",
      cause: parsed.error,
    });
  }
  const payload = parsed.data;
  const existingChapters = await tx.chapter.findMany({
    where: { novelId: proposal.novelId },
    orderBy: { order: "asc" },
  });
  const existingByOrder = new Map(existingChapters.map((chapter) => [chapter.order, chapter]));
  const volume = await tx.volumePlan.upsert({
    where: { novelId_sortOrder: { novelId: proposal.novelId, sortOrder: 1 } },
    create: {
      novelId: proposal.novelId,
      sortOrder: 1,
      title: "第一卷",
      summary: payload.polishedSummary,
      mainPromise: payload.polishedSummary,
      status: "active",
    },
    update: {
      summary: payload.polishedSummary,
      mainPromise: payload.polishedSummary,
      status: "active",
    },
  });

  for (const chapterPlan of payload.chapters.slice().sort((left, right) => left.order - right.order)) {
    const existing = existingByOrder.get(chapterPlan.order);
    const chapter = existing
      ? await tx.chapter.update({
          where: { id: existing.id },
          data: {
            title: chapterPlan.title,
            expectation: chapterPlan.summary,
            taskSheet: chapterPlan.beats.join("\n"),
          },
        })
      : await tx.chapter.create({
          data: {
            novelId: proposal.novelId,
            order: chapterPlan.order,
            title: chapterPlan.title,
            content: "",
            expectation: chapterPlan.summary,
            taskSheet: chapterPlan.beats.join("\n"),
            generationState: "planned",
            chapterStatus: "unplanned",
          },
        });
    await tx.volumeChapterPlan.upsert({
      where: { volumeId_chapterOrder: { volumeId: volume.id, chapterOrder: chapterPlan.order } },
      create: {
        volumeId: volume.id,
        chapterId: chapter.id,
        chapterOrder: chapterPlan.order,
        title: chapterPlan.title,
        summary: chapterPlan.summary,
        purpose: chapterPlan.purpose,
        taskSheet: chapterPlan.beats.join("\n"),
      },
      update: {
        chapterId: chapter.id,
        title: chapterPlan.title,
        summary: chapterPlan.summary,
        purpose: chapterPlan.purpose,
        taskSheet: chapterPlan.beats.join("\n"),
      },
    });
  }

  const finalChapters = await tx.chapter.findMany({
    where: { novelId: proposal.novelId },
    orderBy: { order: "asc" },
    select: { order: true, title: true, expectation: true, taskSheet: true },
  });
  const structuredOutline = [{
    volumeTitle: volume.title,
    chapters: finalChapters.map((chapter) => ({
      order: chapter.order,
      title: chapter.title,
      summary: chapter.expectation ?? "",
      task_sheet: chapter.taskSheet ?? undefined,
    })),
  }];
  await tx.novel.update({
    where: { id: proposal.novelId },
    data: {
      outline: payload.sourceText,
      structuredOutline: JSON.stringify(structuredOutline, null, 2),
    },
  });
}
