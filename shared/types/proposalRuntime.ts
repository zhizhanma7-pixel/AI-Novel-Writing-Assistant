import { z } from "zod";
import type { DirectorPolicyMode } from "./directorRuntime.js";

export const proposalAutonomyLevelSchema = z.enum(["L0", "L1", "L2", "L3"]);

export type ProposalAutonomyLevel = z.infer<typeof proposalAutonomyLevelSchema>;

export const PROPOSAL_AUTONOMY_POLICY_MODES = {
  L0: "suggest_only",
  L1: "run_next_step",
  L2: "run_until_gate",
  L3: "auto_safe_scope",
} as const satisfies Record<ProposalAutonomyLevel, DirectorPolicyMode>;

const PROPOSAL_POLICY_MODE_AUTONOMY_LEVELS = {
  suggest_only: "L0",
  run_next_step: "L1",
  run_until_gate: "L2",
  auto_safe_scope: "L3",
} as const satisfies Record<DirectorPolicyMode, ProposalAutonomyLevel>;

export function proposalAutonomyLevelToPolicyMode(
  level: ProposalAutonomyLevel,
): DirectorPolicyMode {
  return PROPOSAL_AUTONOMY_POLICY_MODES[level];
}

export function directorPolicyModeToProposalAutonomyLevel(
  mode: DirectorPolicyMode,
): ProposalAutonomyLevel {
  return PROPOSAL_POLICY_MODE_AUTONOMY_LEVELS[mode];
}
