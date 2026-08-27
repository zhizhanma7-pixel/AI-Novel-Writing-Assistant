import type { ChapterDivergence } from "@ai-novel/shared/types/chapterDivergence";
import type { ChapterExecutionMissingObligation } from "@ai-novel/shared/types/chapterRuntime";

/**
 * 「按计划修正」分支（Phase 2C.5）。
 *
 * 用户拒绝一条偏离、要求正文改回 Expected 时，**不新建修复链路**：把偏离翻译成
 * 既有的 `ChapterExecutionMissingObligation`，交给
 * `chapterRepairRuntime.buildRepairIssuesPayload` 已经在消费的那条通路，
 * 从而自动复用既有修复预算与 `maxAutoRepairAttempts`。
 *
 * kind 刻意复用既有六类义务码，这样现有修复 Prompt 不需要任何改动就能理解。
 */
const DIVERGENCE_TO_OBLIGATION_KIND: Record<
  ChapterDivergence["kind"],
  ChapterExecutionMissingObligation["kind"]
> = {
  next_entry_state_changed: "must_preserve",
  cross_chapter_commitment: "must_preserve",
  character_life_status: "must_preserve",
  relation_direction_reversed: "must_preserve",
  protected_reveal_touched: "forbidden_crossing",
  payoff_timing_shifted: "payoff_touch",
};

export function toRepairObligation(
  divergence: ChapterDivergence,
): ChapterExecutionMissingObligation {
  return {
    kind: DIVERGENCE_TO_OBLIGATION_KIND[divergence.kind],
    summary: `把正文改回计划要求：${divergence.expected}`,
    evidence: divergence.actual,
  };
}

/**
 * 把一章中被要求修正的偏离转成修复输入。
 *
 * 与既有 `obligationCoverage.missing` 合并时放在**后面**：既有的「该写没写」
 * 缺口先修，偏离纠正后修，避免修复器把两类问题混成一次大改写。
 */
export function buildDivergenceRepairObligations(
  divergences: ChapterDivergence[],
): ChapterExecutionMissingObligation[] {
  return divergences.map(toRepairObligation);
}
