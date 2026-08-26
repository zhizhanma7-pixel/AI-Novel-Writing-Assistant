import type {
  ChangeProposal,
  ProposedChange,
} from "@ai-novel/shared/types/changeProposal";
import type {
  DirectorPolicyDecision,
  DirectorPolicyMode,
  DirectorRuntimePolicySnapshot,
} from "@ai-novel/shared/types/directorRuntime";
import {
  proposalAutonomyLevelToPolicyMode,
  type ProposalAutonomyLevel,
} from "@ai-novel/shared/types/proposalRuntime";
import { DirectorPolicyEngine } from "../../director/runtime/DirectorPolicyEngine";
import { DirectorRuntimeService } from "../../director/runtime/DirectorRuntimeService";
import { buildDefaultDirectorPolicy } from "../../director/runtime/directorRuntimeDefaults";
import { effectiveProposalSeverity } from "../domain/ChangeProposalSeverityPolicy";

type RuntimePolicyReader = Pick<DirectorRuntimeService, "getSnapshot">;

export interface ChangeProposalPolicyEvaluation {
  autonomyLevel: ProposalAutonomyLevel;
  directorPolicyMode: DirectorPolicyMode;
  policyMode: DirectorPolicyMode;
  policy: DirectorRuntimePolicySnapshot;
  decision: DirectorPolicyDecision;
}

export interface ChangeProposalPolicyEvaluationOptions {
  changes?: Array<Pick<
    ProposedChange,
    "proposalType" | "path" | "operation" | "severity" | "before" | "after" | "payload"
  >>;
}

export class ChangeProposalPolicyGateService {
  constructor(
    private readonly policyEngine = new DirectorPolicyEngine(),
    private readonly runtimePolicyReader: RuntimePolicyReader = new DirectorRuntimeService(),
  ) {}

  async evaluate(
    proposal: Pick<
      ChangeProposal,
      "novelId" | "chapterId" | "taskId" | "proposalType" | "outlineFidelity" | "changes"
    >,
    options: ChangeProposalPolicyEvaluationOptions = {},
  ): Promise<ChangeProposalPolicyEvaluation> {
    const policy = await this.resolvePolicy(proposal.taskId);
    const autonomyLevel = policy.proposalAutonomyLevel;
    const proposalPolicyMode = proposalAutonomyLevelToPolicyMode(autonomyLevel);
    const changes = options.changes ?? proposal.changes;
    const decision = this.policyEngine.decide({
      action: "run_node",
      policy: { ...policy, mode: proposalPolicyMode },
      targetType: proposal.chapterId ? "chapter" : "novel",
      targetId: proposal.chapterId ?? proposal.novelId,
      writes: [proposal.proposalType],
      proposalSeverity: effectiveProposalSeverity(changes),
      outlineFidelity: proposal.outlineFidelity ?? undefined,
      // L1 is the recommended explicit-approval level. L0 is already blocked
      // by suggest_only; L2/L3 may run minor, non-strict proposals.
      requiresApprovalByDefault: autonomyLevel === "L1",
    });

    return {
      autonomyLevel,
      directorPolicyMode: policy.mode,
      policyMode: proposalPolicyMode,
      policy,
      decision,
    };
  }

  private async resolvePolicy(taskId: string | null): Promise<DirectorRuntimePolicySnapshot> {
    if (taskId) {
      const snapshot = await this.runtimePolicyReader.getSnapshot(taskId);
      if (snapshot) {
        return snapshot.policy;
      }
    }
    return buildDefaultDirectorPolicy();
  }
}

export const changeProposalPolicyGateService = new ChangeProposalPolicyGateService();
