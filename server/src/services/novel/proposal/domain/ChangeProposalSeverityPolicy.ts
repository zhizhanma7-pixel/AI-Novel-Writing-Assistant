import type {
  ProposedChange,
  ProposedChangeSeverity,
} from "@ai-novel/shared/types/changeProposal";

type SeverityChange = Pick<
  ProposedChange,
  "proposalType" | "path" | "operation" | "severity" | "before" | "after" | "payload"
>;

const RELATION_SCORE_KEYS = [
  "trustScore",
  "intimacyScore",
  "conflictScore",
  "dependencyScore",
] as const;
const RELATION_MAJOR_DELTA = 20;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function relationScoreDelta(change: SeverityChange): number | null {
  const directBefore = finiteNumber(change.before);
  const directAfter = finiteNumber(change.after);
  if (directBefore != null && directAfter != null) {
    return Math.abs(directAfter - directBefore);
  }
  for (const key of RELATION_SCORE_KEYS) {
    const after = finiteNumber(change.payload[key]);
    if (after == null) {
      continue;
    }
    const before = change.before && typeof change.before === "object" && !Array.isArray(change.before)
      ? finiteNumber((change.before as Record<string, unknown>)[key])
      : null;
    if (before != null) {
      return Math.abs(after - before);
    }
  }
  return null;
}

export function deriveChangeSeverityFloor(change: SeverityChange): ProposedChangeSeverity {
  if (change.operation === "remove") {
    return "major";
  }
  if (
    change.proposalType === "character_state_update"
    || change.proposalType === "character_resource_update"
  ) {
    return "major";
  }
  if (change.proposalType !== "relation_state_update") {
    return "major";
  }
  const terminalPath = change.path.split(".").at(-1)?.trim() ?? "";
  if (!["trust", "trustScore", "intimacy", "intimacyScore", "conflict", "conflictScore", "dependency", "dependencyScore"].includes(terminalPath)) {
    return "major";
  }
  const delta = relationScoreDelta(change);
  return delta != null && delta < RELATION_MAJOR_DELTA ? "minor" : "major";
}

export function effectiveProposalSeverity(
  changes: SeverityChange[],
): ProposedChangeSeverity {
  return changes.some((change) => (
    change.severity === "major" || deriveChangeSeverityFloor(change) === "major"
  )) ? "major" : "minor";
}
