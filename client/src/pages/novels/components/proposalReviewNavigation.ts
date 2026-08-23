import type { NovelWorkflowCheckpoint } from "@ai-novel/shared/types/novelWorkflow";

export function buildProposalReviewHref(input: {
  checkpointType?: NovelWorkflowCheckpoint | null;
  routeNovelId?: string | null;
  resumeTargetNovelId?: string | null;
  taskId: string;
}): string | null {
  if (input.checkpointType !== "proposal_review_required") {
    return null;
  }
  const novelId = input.routeNovelId?.trim() || input.resumeTargetNovelId?.trim();
  const taskId = input.taskId.trim();
  if (!novelId || !taskId) {
    return null;
  }
  return `/novels/${encodeURIComponent(novelId)}/edit?directorTaskId=${encodeURIComponent(taskId)}&proposalPanel=1`;
}
