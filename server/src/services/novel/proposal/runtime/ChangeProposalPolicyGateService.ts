import type {
  ChangeProposal,
  ProposedChange,
  ProposedChangeSeverity,
} from "@ai-novel/shared/types/changeProposal";
import type {
  DirectorPolicyDecision,
  DirectorPolicyMode,
  DirectorRuntimePolicySnapshot,
} from "@ai-novel/shared/types/directorRuntime";
import {
  directorPolicyModeToProposalAutonomyLevel,
  proposalAutonomyLevelToPolicyMode,
  type ProposalAutonomyLevel,
} from "@ai-novel/shared/types/proposalRuntime";
import { DirectorPolicyEngine } from "../../director/runtime/DirectorPolicyEngine";
import { DirectorRuntimeService } from "../../director/runtime/DirectorRuntimeService";
import { buildDefaultDirectorPolicy } from "../../director/runtime/directorRuntimeDefaults";

type RuntimePolicyReader = Pick<DirectorRuntimeService, "getSnapshot">;

export interface ChangeProposalPolicyEvaluation {
  autonomyLevel: ProposalAutonomyLevel;
  policyMode: DirectorPolicyMode;
  policy: DirectorRuntimePolicySnapshot;
  decision: DirectorPolicyDecision;
}

export interface ChangeProposalPolicyEvaluationOptions {
  changes?: Array<Pick<ProposedChange, "severity">>;
}

function highestSeverity(
  changes: Array<Pick<ProposedChange, "severity">>,
): ProposedChangeSeverity {
  return changes.some((change) => change.severity === "major") ? "major" : "minor";
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
    const autonomyLevel = directorPolicyModeToProposalAutonomyLevel(policy.mode);
    const changes = options.changes ?? proposal.changes;
    const decision = this.policyEngine.decide({
      action: "run_node",
      policy,
      targetType: proposal.chapterId ? "chapter" : "novel",
      targetId: proposal.chapterId ?? proposal.novelId,
      writes: [proposal.proposalType],
      proposalSeverity: highestSeverity(changes),
      outlineFidelity: proposal.outlineFidelity ?? undefined,
      // L1 is the recommended explicit-approval level. L0 is already blocked
      // by suggest_only; L2/L3 may run minor, non-strict proposals.
      requiresApprovalByDefault: autonomyLevel === "L1",
    });

    return {
      autonomyLevel,
      policyMode: policy.mode,
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
    return buildDefaultDirectorPolicy(proposalAutonomyLevelToPolicyMode("L1"));
  }
}

export const changeProposalPolicyGateService = new ChangeProposalPolicyGateService();
