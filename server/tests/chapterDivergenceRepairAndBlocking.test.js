const test = require("node:test");
const assert = require("node:assert/strict");

const {
  toRepairObligation,
  buildDivergenceRepairObligations,
} = require("../dist/services/novel/proposal/chapterExecution/domain/ChapterDivergenceRepairMapper.js");
const {
  buildBlockingPendingReviewProposalWhere,
} = require("../dist/services/novel/runtime/context/pendingReviewContext.js");

function divergence(kind) {
  return {
    kind,
    summary: "计划要求章末留城，正文写成离城。",
    expected: "章末主角留在城内等待接头",
    actual: "主角连夜带队离城。",
    evidence: null,
    references: {
      affectedCharacterContractEntries: [],
      affectedPayoffContractEntries: [],
      touchedProtectedReveals: [],
      contractQuotes: ["章末主角留在城内等待接头"],
    },
  };
}

// ---- 2C.5 修正分支：复用既有修复链路 ----

test("every divergence kind maps onto an existing obligation kind", () => {
  const expected = {
    next_entry_state_changed: "must_preserve",
    cross_chapter_commitment: "must_preserve",
    character_life_status: "must_preserve",
    relation_direction_reversed: "must_preserve",
    protected_reveal_touched: "forbidden_crossing",
    payoff_timing_shifted: "payoff_touch",
  };
  for (const [kind, obligationKind] of Object.entries(expected)) {
    // 复用既有六类义务码，现有修复 Prompt 无需改动即可理解。
    assert.equal(toRepairObligation(divergence(kind)).kind, obligationKind);
  }
});

test("a corrected divergence carries the Expected text as the repair target", () => {
  const obligation = toRepairObligation(divergence("next_entry_state_changed"));

  assert.match(obligation.summary, /章末主角留在城内等待接头/);
  assert.equal(obligation.evidence, "主角连夜带队离城。");
});

test("divergence repair obligations preserve input order", () => {
  const result = buildDivergenceRepairObligations([
    divergence("payoff_timing_shifted"),
    divergence("protected_reveal_touched"),
  ]);

  assert.deepEqual(result.map((item) => item.kind), ["payoff_touch", "forbidden_crossing"]);
});

// ---- 2C.6 G4：待审 Change Proposal 不阻塞正文生成 ----

test("G4 — a pending Change Proposal never blocks the next chapter", () => {
  // D5 定稿：停链只由 replan_required / stop_for_replan / 不可恢复生成失败 /
  // 数据安全问题决定，不经由 pending Proposal 间接阻塞。
  // `changeProposalId: null` 把信封逐项排除在阻塞集合之外，这是**有意为之**，
  // 不是漏接线——CODE_REVIEW_PROPOSAL_CORE.md 当初记为待接线缺口的前提
  // （「提案要能拦住正文」）在 D2 定稿后已不成立。
  const where = buildBlockingPendingReviewProposalWhere("novel-1", "chapter-9");

  assert.equal(where.changeProposalId, null);
  assert.equal(where.status, "pending_review");
  assert.equal(where.novelId, "novel-1");
  assert.deepEqual(where.OR, [{ chapterId: "chapter-9" }, { chapterId: null }]);
});
