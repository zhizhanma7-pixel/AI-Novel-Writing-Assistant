export const QUEUED_PROPOSAL_ACTION_TIMEOUT_MS = 60_000;

const FAILED_COMMAND_STATUSES = new Set(["failed", "cancelled", "stale"]);

export type QueuedProposalCommandOutcome = "waiting" | "failed" | "timed_out";

export function resolveQueuedProposalCommandOutcome(input: {
  status?: string | null;
  elapsedMs: number;
}): QueuedProposalCommandOutcome {
  if (input.status && FAILED_COMMAND_STATUSES.has(input.status)) {
    return "failed";
  }
  if (input.elapsedMs >= QUEUED_PROPOSAL_ACTION_TIMEOUT_MS) {
    return "timed_out";
  }
  return "waiting";
}

export function queuedProposalFailureMessage(outcome: Exclude<QueuedProposalCommandOutcome, "waiting">): string {
  return outcome === "failed"
    ? "导演未能处理这次提案操作。请重试，或打开任务详情检查运行状态。"
    : "等待导演处理已超时。系统已停止自动刷新，请重试或打开任务详情。";
}
