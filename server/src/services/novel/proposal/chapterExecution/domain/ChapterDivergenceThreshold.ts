import {
  collectChapterDivergenceContractEntries,
  isVerifiableChapterDivergence,
  type ChapterDivergence,
} from "@ai-novel/shared/types/chapterDivergence";
import type {
  ChapterBoundaryContract,
  ChapterExecutionObligationContract,
} from "@ai-novel/shared/types/chapterRuntime";

export interface ChapterDivergenceThresholdInput {
  divergence: ChapterDivergence;
  obligationContract?: ChapterExecutionObligationContract | null;
  boundaryContract?: ChapterBoundaryContract | null;
}

/**
 * 判定一条偏离是否值得创建 Change Proposal。
 *
 * 原则：AI 自报的 `kind` 只是展示分类，永远不足以单独过门槛。真正的判据是它给出的
 * 合同原文引用能否在本章 Expected 合同里精确回查——门禁的入参不能由被门禁的一方
 * 独自提供（Phase 2A 的 M1/M3 教训）。
 *
 * 保守方向是「少建提案」而不是「多写状态」：无法核验一律返回 false，由调用方降级为
 * 质量债，不会静默放行到正式写入。
 */
export function isProposalWorthyDivergence(input: ChapterDivergenceThresholdInput): boolean {
  const entries = collectChapterDivergenceContractEntries({
    obligationContract: input.obligationContract,
    boundaryContract: input.boundaryContract,
  });
  const divergence = input.divergence;

  if (!isVerifiableChapterDivergence(divergence, entries)) {
    return false;
  }

  const protectedRevealSet = new Set(entries.protectedReveals);
  if (divergence.references.touchedProtectedReveals.some((reveal) =>
    protectedRevealSet.has(reveal.trim()))) {
    return true;
  }

  const payoffSet = new Set(entries.requiredPayoffTouches);
  if (divergence.references.affectedPayoffContractEntries.some((entry) =>
    payoffSet.has(entry.trim()))) {
    return true;
  }

  // 余下四类没有可独立回查的专用合同字段，但上面的 contractQuotes 核验已经成立，
  // 因此这里只需按 kind 归类即可。protected_reveal_touched 与 payoff_timing_shifted
  // 若走到这里，说明它们引用的具体条目不在本章的保护揭露 / 必触伏笔清单里，
  // 属于跨章影响面之外，交给质量债。
  return divergence.kind === "next_entry_state_changed"
    || divergence.kind === "cross_chapter_commitment"
    || divergence.kind === "character_life_status"
    || divergence.kind === "relation_direction_reversed";
}

export interface ChapterDivergenceRoutingResult {
  /** 通过阈值、需要创建提案的偏离。 */
  proposalWorthy: ChapterDivergence[];
  /** 未达阈值、降级为质量债的偏离。 */
  qualityDebt: ChapterDivergence[];
}

/** 把一章的全部偏离按阈值分流。同章多条偏离由调用方聚合成一份提案。 */
export function routeChapterDivergences(input: {
  divergences: ChapterDivergence[];
  obligationContract?: ChapterExecutionObligationContract | null;
  boundaryContract?: ChapterBoundaryContract | null;
}): ChapterDivergenceRoutingResult {
  const proposalWorthy: ChapterDivergence[] = [];
  const qualityDebt: ChapterDivergence[] = [];
  for (const divergence of input.divergences) {
    const worthy = isProposalWorthyDivergence({
      divergence,
      obligationContract: input.obligationContract,
      boundaryContract: input.boundaryContract,
    });
    (worthy ? proposalWorthy : qualityDebt).push(divergence);
  }
  return { proposalWorthy, qualityDebt };
}
