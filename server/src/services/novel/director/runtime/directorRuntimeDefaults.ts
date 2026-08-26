import type {
  DirectorPolicyMode,
  DirectorRuntimePolicySnapshot,
  DirectorRuntimeSnapshot,
} from "@ai-novel/shared/types/directorRuntime";
import {
  proposalAutonomyLevelSchema,
  type ProposalAutonomyLevel,
} from "@ai-novel/shared/types/proposalRuntime";

export function buildDefaultDirectorPolicy(
  mode: DirectorPolicyMode = "run_until_gate",
  proposalAutonomyLevel: ProposalAutonomyLevel = "L1",
): DirectorRuntimePolicySnapshot {
  return {
    mode,
    proposalAutonomyLevel,
    mayOverwriteUserContent: false,
    maxAutoRepairAttempts: 1,
    allowExpensiveReview: false,
    modelTier: "balanced",
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeDirectorRuntimePolicy(
  value: Partial<DirectorRuntimePolicySnapshot> | null | undefined,
): DirectorRuntimePolicySnapshot {
  const fallback = buildDefaultDirectorPolicy();
  return {
    ...fallback,
    ...value,
    mode: value?.mode ?? fallback.mode,
    proposalAutonomyLevel: proposalAutonomyLevelSchema.safeParse(value?.proposalAutonomyLevel).data
      ?? "L1",
    maxAutoRepairAttempts: 1,
    updatedAt: value?.updatedAt ?? fallback.updatedAt,
  };
}

export function buildEmptyDirectorRuntimeSnapshot(input: {
  runId: string;
  novelId?: string | null;
  entrypoint?: string | null;
  policyMode?: DirectorPolicyMode;
}): DirectorRuntimeSnapshot {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    runId: input.runId,
    novelId: input.novelId ?? null,
    entrypoint: input.entrypoint ?? null,
    policy: {
      ...buildDefaultDirectorPolicy(input.policyMode),
      updatedAt: now,
    },
    steps: [],
    events: [],
    artifacts: [],
    lastWorkspaceAnalysis: null,
    updatedAt: now,
  };
}
