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

/**
 * 稳定偏离标识。用 kind 作 resolution 键会让同一章后续同类偏离覆盖历史记录
 * （复审 M5），因此这里生成含章节与序号的稳定 id。
 */
function buildDivergenceId(
  chapterOrder: number,
  divergence: ChapterDivergence,
  index: number,
): string {
  return `ch${chapterOrder}:${divergence.kind}:${index}`;
}

/**
 * **生产者必须直接产出 applier 可执行的完整 payload**（复审 H1）。
 *
 * 此前只写了展示字段，缺 `chapterId`，导致批准后 apply 稳定判为 `invalid_payload`；
 * 而 2C.4 的真实 SQLite 用例手写了另一份完整 payload，所以没能覆盖到这个断点。
 * 教训与 Phase 1 的 O2 同类：fixture 与真实生产输出不一致时，测试证明不了链路。
 */
function toProposedChange(input: {
  chapterId: string;
  chapterOrder: number;
  divergence: ChapterDivergence;
  index: number;
  obligationContract?: unknown;
  boundaryContract?: unknown;
}): ProposedChangeInput {
  const { chapterId, chapterOrder, divergence, index } = input;
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
      chapterId,
      chapterOrder,
      divergenceId: buildDivergenceId(chapterOrder, divergence, index),
      kind: divergence.kind,
      expected: divergence.expected,
      actual: divergence.actual,
      references: divergence.references,
      // 审计证据：偏离发生时的本章原始合同，applier 只读不写。
      originalExpected: {
        obligationContract: input.obligationContract ?? null,
        boundaryContract: input.boundaryContract ?? null,
      },
      // 本阶段不自动推导下游计划变换：AI 只给出「哪里不一致」，
      // 「下游该怎么改」需要用户在审阅时决定。空数组时 applier 只记录
      // accepted_divergence 解决结果，不改任何计划——这比伪造一个
      // 看似可执行的 patch 诚实。
      downstreamPlanPatches: [],
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

    const changes = routed.proposalWorthy.map((divergence, index) => toProposedChange({
      chapterId: input.chapterId,
      chapterOrder: input.chapterOrder,
      divergence,
      index,
      obligationContract: input.obligationContract,
      boundaryContract: input.boundaryContract,
    }));
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
