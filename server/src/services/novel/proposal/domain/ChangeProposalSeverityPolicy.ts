import type {
  ProposedChange,
  ProposedChangeSeverity,
} from "@ai-novel/shared/types/changeProposal";
import { resolveProposedChangePayloadKey } from "@ai-novel/shared/types/stateProposalApplication";

type SeverityChange = Pick<
  ProposedChange,
  "proposalType" | "path" | "operation" | "severity" | "before" | "after" | "payload"
>;

const RELATION_MAJOR_DELTA = 20;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function relationScoreDelta(change: SeverityChange): number | null {
  const payloadKey = resolveProposedChangePayloadKey({
    proposalType: change.proposalType,
    path: change.path,
    payload: change.payload,
  });
  if (!payloadKey) {
    return null;
  }
  const payloadAfter = finiteNumber(change.payload[payloadKey]);
  if (payloadAfter == null) {
    return null;
  }
  const declaredAfter = finiteNumber(change.after);
  if (change.after !== undefined && declaredAfter !== payloadAfter) {
    return null;
  }
  const directBefore = finiteNumber(change.before);
  if (directBefore != null) {
    return Math.abs(payloadAfter - directBefore);
  }
  const objectBefore = change.before && typeof change.before === "object" && !Array.isArray(change.before)
    ? finiteNumber((change.before as Record<string, unknown>)[payloadKey])
    : null;
  return objectBefore == null ? null : Math.abs(payloadAfter - objectBefore);
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
