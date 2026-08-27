import type {
  ChangeProposal,
  ProposedChangeInput,
} from "@ai-novel/shared/types/changeProposal";
import type { ChapterDivergence } from "@ai-novel/shared/types/chapterDivergence";
import type {
  ChapterBoundaryContract,
  ChapterExecutionObligationContract,
} from "@ai-novel/shared/types/chapterRuntime";
import { aiChangeProposalProducerService } from "../../runtime/AiChangeProposalProducerService";
import { routeChapterDivergences } from "../domain/ChapterDivergenceThreshold";

type ProposalProducer = Pick<typeof aiChangeProposalProducerService, "produce">;

export interface ChapterDivergenceProposalInput {
  novelId: string;
  chapterId: string;
  chapterOrder: number;
  taskId?: string | null;
  divergences: ChapterDivergence[];
  obligationContract?: ChapterExecutionObligationContract | null;
  boundaryContract?: ChapterBoundaryContract | null;
  /** acceptance 的 repairability，用于识别「已经要求重规划」的情形。 */
  repairability?: string | null;
  /** 章节失败分类码，`replan_required` 时不建偏离提案。 */
  failureClassificationCode?: string | null;
}

export interface ChapterDivergenceProposalResult {
  /** 已创建的偏离提案；没有够格的偏离时为 null。 */
  proposal: ChangeProposal | null;
  /** 未达阈值、应记入既有质量债 / riskTags 的偏离。 */
  qualityDebt: ChapterDivergence[];
  /** 命中既有 replan 路径而整体跳过。 */
  skippedForReplan: boolean;
}

/** 同一件事不应该既走 replan 又留一份待审提案。 */
function requiresReplan(input: ChapterDivergenceProposalInput): boolean {
  return input.failureClassificationCode === "replan_required"
    || input.repairability === "plan_misalignment";
}

function divergenceChangePath(chapterOrder: number, divergence: ChapterDivergence): string {
  // 末段必须是 payload 里真实存在的键：apply 边界会用
  // resolveProposedChangePayloadKey + assertProposedValueMatchesPayload
  // 校验「界面展示值」与「可执行值」一致（Phase 2A 的 M3 修复）。
  return `Chapter.${chapterOrder}.divergence.${divergence.kind}.actual`;
}

function toProposedChange(
  chapterOrder: number,
  divergence: ChapterDivergence,
): ProposedChangeInput {
  return {
    proposalType: "chapter_execution_plan_update",
    path: divergenceChangePath(chapterOrder, divergence),
    operation: "replace",
    category: "plot",
    // 确定性下界会把非 relation_state_update 的变更抬到 major，这里给出的
    // severity 只是初值，最终以 ChangeProposalSeverityPolicy 为准。
    severity: "major",
    before: divergence.expected,
    after: divergence.actual,
    payload: {
      chapterOrder,
      kind: divergence.kind,
      expected: divergence.expected,
      actual: divergence.actual,
      references: divergence.references,
    },
    reason: divergence.summary,
    sourceRefs: [],
    evidence: divergence.evidence ? [divergence.evidence] : [],
  };
}

/**
 * 把一章的执行偏离聚合成**一份**非阻塞 Change Proposal。
 *
 * 三条硬约束（Phase 2C 定稿口径）：
 * 1. 只有能在本章 Expected 合同里回查的跨章偏离才建提案，其余降级为质量债。
 * 2. 同章多条偏离聚合成一份信封，每条一个 ProposedChange。
 * 3. **无论本方法结果如何，调用方都不得改变章节执行链的推进决定。** 提案以
 *    `reviewProjection: "non_blocking"` 投递，不投 checkpoint、不改任务状态；
 *    停链只能由既有结构化判据（replan_required / stop_for_replan / 不可恢复
 *    生成失败 / 数据安全问题）决定，这是 `AGENTS.md` 的最高优先级硬规则。
 */
export class ChapterDivergenceProposalService {
  constructor(
    private readonly producer: ProposalProducer = aiChangeProposalProducerService,
  ) {}

  async createForChapter(
    input: ChapterDivergenceProposalInput,
  ): Promise<ChapterDivergenceProposalResult> {
    if (requiresReplan(input)) {
      return {
        proposal: null,
        qualityDebt: input.divergences,
        skippedForReplan: true,
      };
    }

    const routed = routeChapterDivergences({
      divergences: input.divergences,
      obligationContract: input.obligationContract,
      boundaryContract: input.boundaryContract,
    });
    if (routed.proposalWorthy.length === 0) {
      return {
        proposal: null,
        qualityDebt: routed.qualityDebt,
        skippedForReplan: false,
      };
    }

    const changes = routed.proposalWorthy.map((divergence) =>
      toProposedChange(input.chapterOrder, divergence));
    this.assertNoConflictingDownstreamWrites(changes);

    const produced = await this.producer.produce(
      input.novelId,
      {
        taskId: input.taskId ?? null,
        chapterId: input.chapterId,
        proposalType: "chapter_execution",
        outlineFidelity: null,
        summary: `第 ${input.chapterOrder} 章有 ${routed.proposalWorthy.length} 处与计划不一致，需要你确认。`,
        reasoningSummary: routed.proposalWorthy
          .map((divergence) => divergence.summary)
          .join("；"),
        sourceRefs: [],
        warnings: [],
        changes,
      },
      { reviewProjection: "non_blocking" },
    );

    return {
      proposal: produced.proposal,
      qualityDebt: routed.qualityDebt,
      skippedForReplan: false,
    };
  }

  /**
   * 部分审批下逐项是可以被单独接受的，如果两项写同一个下游目标，
   * 最终结果就会依赖执行顺序。生产期直接拒绝这种信封，而不是留到 apply 期。
   */
  private assertNoConflictingDownstreamWrites(changes: ProposedChangeInput[]): void {
    const seen = new Set<string>();
    for (const change of changes) {
      if (seen.has(change.path)) {
        throw new Error(
          `Chapter divergence proposal would write ${change.path} twice; `
          + "aggregate the divergences before creating the envelope.",
        );
      }
      seen.add(change.path);
    }
  }
}

export const chapterDivergenceProposalService = new ChapterDivergenceProposalService();
