const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ChapterDivergenceProposalService,
} = require("../dist/services/novel/proposal/chapterExecution/application/ChapterDivergenceProposalService.js");
const {
  ChapterContentFinalizationService,
} = require("../dist/services/novel/runtime/ChapterContentFinalizationService.js");
const {
  getStateProposalApplicationMode,
} = require("../../shared/dist/types/stateProposalApplication.js");

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
      affectedCharacterContractEntries: [],
      affectedPayoffContractEntries: [],
      touchedProtectedReveals: [],
      contractQuotes: overrides.quotes ?? ["章末主角留在城内等待接头"],
    },
  };
}

function buildService(calls) {
  return new ChapterDivergenceProposalService({
    produce: async (novelId, input, options) => {
      calls.push({ novelId, input, options });
      return { proposal: { id: "proposal-1", ...input }, disposition: "pending_review" };
    },
  });
}

function baseInput(overrides = {}) {
  return {
    novelId: "novel-1",
    chapterId: "chapter-9",
    chapterOrder: 9,
    taskId: "task-1",
    divergences: overrides.divergences ?? [divergence()],
    obligationContract: OBLIGATION_CONTRACT,
    boundaryContract: BOUNDARY_CONTRACT,
    ...overrides,
  };
}

test("chapter divergence proposals are always produced with the non-blocking projection", async () => {
  const calls = [];
  const result = await buildService(calls).createForChapter(baseInput());

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { reviewProjection: "non_blocking" });
  assert.equal(calls[0].input.proposalType, "chapter_execution");
  assert.notEqual(result.proposal, null);
});

test("one chapter's divergences aggregate into a single envelope with one change each", async () => {
  const calls = [];
  const result = await buildService(calls).createForChapter(baseInput({
    divergences: [
      divergence({ kind: "next_entry_state_changed" }),
      divergence({ kind: "cross_chapter_commitment", quotes: ["主角提前离城"] }),
      divergence({ kind: "character_life_status", quotes: ["春桃"] }),
    ],
  }));

  assert.equal(calls.length, 1, "must be one envelope, not one per divergence");
  assert.equal(calls[0].input.changes.length, 3);
  assert.deepEqual(
    calls[0].input.changes.map((change) => change.proposalType),
    ["chapter_execution_plan_update", "chapter_execution_plan_update", "chapter_execution_plan_update"],
  );
  assert.equal(result.qualityDebt.length, 0);
});

test("divergences below the threshold become quality debt without an envelope", async () => {
  const calls = [];
  const result = await buildService(calls).createForChapter(baseInput({
    divergences: [divergence({ quotes: [] })],
  }));

  assert.equal(calls.length, 0, "no verifiable divergence must not create a proposal");
  assert.equal(result.proposal, null);
  assert.equal(result.qualityDebt.length, 1);
});

test("a replan-bound chapter skips the divergence proposal entirely", async () => {
  for (const overrides of [
    { failureClassificationCode: "replan_required" },
    { repairability: "plan_misalignment" },
  ]) {
    const calls = [];
    const result = await buildService(calls).createForChapter(baseInput(overrides));

    assert.equal(calls.length, 0, "replan and proposal must not both claim the same problem");
    assert.equal(result.skippedForReplan, true);
    assert.equal(result.proposal, null);
  }
});

test("每个 change 的展示值与可执行 payload 一致（沿用 2A 的 M3 不变量）", async () => {
  const calls = [];
  await buildService(calls).createForChapter(baseInput());

  const change = calls[0].input.changes[0];
  const terminalKey = change.path.split(".").at(-1);
  assert.equal(change.after, change.payload[terminalKey]);
  assert.equal(change.before, change.payload.expected);
});

test("two divergences targeting the same path are rejected at production time", async () => {
  const calls = [];
  const service = buildService(calls);

  await assert.rejects(
    () => service.createForChapter(baseInput({
      divergences: [
        divergence({ kind: "next_entry_state_changed" }),
        divergence({ kind: "next_entry_state_changed", summary: "重复目标" }),
      ],
    })),
    /would write .* twice/,
  );
  assert.equal(calls.length, 0);
});

test("chapter_execution_plan_update is a domain-state type with a real applier (2C.4)", () => {
  assert.equal(getStateProposalApplicationMode("chapter_execution_plan_update"), "domain_state");
});

// ---- T1 核心断言：偏离提案不得改变章节推进决定 ----

function buildFinalizationService(overrides = {}) {
  const warnings = [];
  const service = new ChapterContentFinalizationService({
    qualityGateService: {
      runAcceptanceGateOnly: async () => ({
        acceptance: {
          score: {
            coherence: 80, pacing: 80, repetition: 80, engagement: 80, voice: 80, overall: 80,
          },
          issues: [],
          auditReports: [],
          assessment: {
            status: "accepted",
            summary: "可以继续。",
            blockingIssues: [],
            repairDirectives: [],
            missingObligations: [],
            divergences: [divergence()],
            repairability: "none",
            decisionReason: "正文可继续推进。",
            riskTags: [],
            continuePolicy: "continue",
            score: {
              coherence: 80, pacing: 80, repetition: 80, engagement: 80, voice: 80, overall: 80,
            },
            assetSyncRecommendation: {
              priority: "normal", reason: "无", requiresFullPayoffReconcile: false,
            },
          },
        },
        timelineGate: { result: { status: "passed" } },
      }),
    },
    artifactSyncService: { syncChapterArtifacts: async () => ({}) },
    plannerService: {},
    agentRuntime: { finishChapterGenRun: async () => {} },
    divergenceProposalService: overrides.divergenceProposalService,
    warn: (message, details) => warnings.push({ message, details }),
  });
  return { service, warnings };
}

test("T1 — a throwing divergence producer never escapes chapter finalization", async () => {
  const { service, warnings } = buildFinalizationService({
    divergenceProposalService: {
      createForChapter: async () => {
        throw new Error("divergence producer exploded");
      },
    },
  });

  // 只验证旁路本身被隔离：produceChapterDivergenceProposal 是 private，
  // 通过对象自身调用以避免拉起完整定稿链路所需的全部 Prisma 依赖。
  await service.produceChapterDivergenceProposal(
    {
      novelId: "novel-1",
      chapterId: "chapter-9",
      request: { workflowTaskId: "task-1" },
      contextPackage: {
        chapter: { order: 9 },
        chapterReviewContext: {
          obligationContract: OBLIGATION_CONTRACT,
          chapterBoundary: BOUNDARY_CONTRACT,
        },
      },
    },
    { divergences: [divergence()], repairability: "none" },
  );

  assert.equal(warnings.length, 1, "failure must be surfaced as a warning, not thrown");
  assert.match(warnings[0].message, /failed to produce divergence proposal/);
  assert.equal(warnings[0].details.divergenceCount, 1);
});

test("T1 — no divergences means the bypass never calls the producer at all", async () => {
  const calls = [];
  const { service } = buildFinalizationService({
    divergenceProposalService: {
      createForChapter: async (value) => { calls.push(value); return {}; },
    },
  });

  await service.produceChapterDivergenceProposal(
    {
      novelId: "novel-1",
      chapterId: "chapter-9",
      request: {},
      contextPackage: { chapter: { order: 9 } },
    },
    { divergences: [] },
  );

  assert.equal(calls.length, 0);
});
