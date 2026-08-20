export function buildLegacyPendingReviewWhere(novelId: string) {
  return {
    novelId,
    status: "pending_review" as const,
    changeProposalId: null,
  };
}
