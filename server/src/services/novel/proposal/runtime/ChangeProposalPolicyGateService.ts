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
  // 本模块导出的是一个顶层单例，构造器默认参数会在模块加载期求值。
  // 在循环加载中那会拿到尚未完成导出的构造器，所以默认依赖一律推迟到首次使用。
  private policyEngineInstance: DirectorPolicyEngine | null;
  private runtimePolicyReaderInstance: RuntimePolicyReader | null;

  constructor(
    policyEngine?: DirectorPolicyEngine,
    runtimePolicyReader?: RuntimePolicyReader,
  ) {
    this.policyEngineInstance = policyEngine ?? null;
    this.runtimePolicyReaderInstance = runtimePolicyReader ?? null;
  }

  private get policyEngine(): DirectorPolicyEngine {
    this.policyEngineInstance ??= new DirectorPolicyEngine();
    return this.policyEngineInstance;
  }

  private get runtimePolicyReader(): RuntimePolicyReader {
    this.runtimePolicyReaderInstance ??= new DirectorRuntimeService();
    return this.runtimePolicyReaderInstance;
  }

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
