const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isProposalWorthyDivergence,
  routeChapterDivergences,
} = require("../dist/services/novel/proposal/chapterExecution/domain/ChapterDivergenceThreshold.js");
const {
  chapterAcceptanceAssessmentPrompt,
} = require("../dist/prompting/prompts/novel/chapterAcceptance.prompts.js");

const OBLIGATION_CONTRACT = {
  mustHitNow: ["主角识破敌方试探"],
  mustPreserve: ["春桃仍不知道主角的真实身份"],
  requiredPayoffTouches: ["reveal: 玉佩来历"],
  requiredCharacterAppearances: ["春桃"],
  requiredGoalChanges: [],
  canDefer: [],
  forbiddenCrossings: ["主角提前离城"],
};

const BOUNDARY_CONTRACT = {
  exclusiveEvent: "城内接头",
  entryState: "主角在城内待命",
  endingState: "主角仍在城内",
  nextChapterEntryState: "章末主角留在城内等待接头",
  doNotCross: [],
  protectedReveals: ["主角的真实身份"],
};

function divergence(overrides = {}) {
  return {
    kind: overrides.kind ?? "next_entry_state_changed",
    summary: overrides.summary ?? "计划要求章末留城，正文写成离城。",
    expected: overrides.expected ?? "章末主角留在城内等待接头",
    actual: overrides.actual ?? "主角连夜带队离城。",
    evidence: overrides.evidence ?? null,
    references: {
      affectedCharacterContractEntries: overrides.characters ?? [],
      affectedPayoffContractEntries: overrides.payoffs ?? [],
      touchedProtectedReveals: overrides.reveals ?? [],
      contractQuotes: overrides.quotes ?? ["章末主角留在城内等待接头"],
    },
  };
}

function judge(input) {
  return isProposalWorthyDivergence({
    divergence: input,
    obligationContract: OBLIGATION_CONTRACT,
    boundaryContract: BOUNDARY_CONTRACT,
  });
}

test("verified cross-chapter divergences pass the proposal threshold", () => {
  for (const kind of [
    "next_entry_state_changed",
    "cross_chapter_commitment",
    "character_life_status",
    "relation_direction_reversed",
  ]) {
    assert.equal(judge(divergence({ kind })), true, `${kind} should be proposal-worthy`);
  }
});

test("protected reveal and payoff divergences pass when their entries resolve", () => {
  assert.equal(
    judge(divergence({
      kind: "protected_reveal_touched",
      quotes: ["主角的真实身份"],
      reveals: ["主角的真实身份"],
    })),
    true,
  );
  assert.equal(
    judge(divergence({
      kind: "payoff_timing_shifted",
      quotes: ["reveal: 玉佩来历"],
      payoffs: ["reveal: 玉佩来历"],
    })),
    true,
  );
});

test("empty references never reach the proposal threshold", () => {
  assert.equal(judge(divergence({ quotes: [] })), false);
});

test("a fabricated contract quote cannot pass the threshold on kind alone", () => {
  // 这是 M1/M3 的教训：AI 自报的 kind 永远不足以单独过门槛。
  assert.equal(
    judge(divergence({ kind: "character_life_status", quotes: ["合同里根本没有这句话"] })),
    false,
  );
});

test("a reveal or payoff outside this chapter's contract falls back to quality debt", () => {
  // contractQuotes 可回查，但引用的具体条目不在本章保护揭露 / 必触伏笔清单里，
  // 说明跨章影响面不成立，应降级而不是建提案。
  assert.equal(
    judge(divergence({
      kind: "protected_reveal_touched",
      reveals: ["不在清单里的揭露"],
    })),
    false,
  );
  assert.equal(
    judge(divergence({
      kind: "payoff_timing_shifted",
      payoffs: ["reveal: 不在清单里的伏笔"],
    })),
    false,
  );
});

test("routing splits one chapter's divergences into proposal and quality debt buckets", () => {
  const result = routeChapterDivergences({
    divergences: [
      divergence({ kind: "next_entry_state_changed" }),
      divergence({ kind: "cross_chapter_commitment", quotes: ["主角提前离城"] }),
      divergence({ kind: "character_life_status", quotes: [] }),
    ],
    obligationContract: OBLIGATION_CONTRACT,
    boundaryContract: BOUNDARY_CONTRACT,
  });

  assert.equal(result.proposalWorthy.length, 2);
  assert.equal(result.qualityDebt.length, 1);
  assert.equal(result.qualityDebt[0].references.contractQuotes.length, 0);
});

test("a missing contract degrades every divergence instead of passing them through", () => {
  assert.equal(
    isProposalWorthyDivergence({
      divergence: divergence(),
      obligationContract: null,
      boundaryContract: null,
    }),
    false,
  );
});

test("acceptance prompt is registered at v3 with a one-shot semantic retry", () => {
  assert.equal(chapterAcceptanceAssessmentPrompt.id, "novel.chapter.acceptance_assessment");
  assert.equal(chapterAcceptanceAssessmentPrompt.version, "v3");
  assert.equal(chapterAcceptanceAssessmentPrompt.semanticRetryPolicy.maxAttempts, 1);
});

test("acceptance postValidate rejects unverifiable divergences and recovery strips them", () => {
  const promptInput = {
    novelTitle: "测试",
    chapterOrder: 12,
    chapterTitle: "城内",
    targetWordCount: null,
    content: "正文",
    obligationContract: OBLIGATION_CONTRACT,
    boundaryContract: BOUNDARY_CONTRACT,
  };
  const verified = divergence();
  const unverified = divergence({ quotes: ["凭空捏造的合同条目"] });
  const rawOutput = {
    ...chapterAcceptanceAssessmentPrompt.structuredOutputHint.example,
    divergences: [verified, unverified],
  };

  assert.throws(
    () => chapterAcceptanceAssessmentPrompt.postValidate(rawOutput, promptInput, {}),
    /无法在本章合同中回查/,
  );

  const recovered = chapterAcceptanceAssessmentPrompt.postValidateFailureRecovery({
    promptInput,
    context: {},
    rawOutput,
    validationError: "unverified",
    semanticRetryAttempts: 1,
  });
  assert.deepEqual(recovered.divergences, [verified]);
});

test("acceptance postValidate passes through when every divergence resolves", () => {
  const promptInput = {
    novelTitle: "测试",
    chapterOrder: 12,
    chapterTitle: "城内",
    targetWordCount: null,
    content: "正文",
    obligationContract: OBLIGATION_CONTRACT,
    boundaryContract: BOUNDARY_CONTRACT,
  };
  const rawOutput = {
    ...chapterAcceptanceAssessmentPrompt.structuredOutputHint.example,
    divergences: [divergence()],
  };

  assert.equal(
    chapterAcceptanceAssessmentPrompt.postValidate(rawOutput, promptInput, {}).divergences.length,
    1,
  );
});
