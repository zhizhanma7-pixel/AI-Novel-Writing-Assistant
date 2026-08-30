const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AiChangeProposalProducerService,
} = require("../dist/services/novel/proposal/runtime/AiChangeProposalProducerService.js");

// Phase 2C / D2：待审提案的两种投影。
// 章节局部偏离必须用 non_blocking，否则每次偏离都会把任务推进
// waiting_approval，停住全书执行链，正面违反 AGENTS.md 的自动导演质量门规则。
// 2A 的既有默认行为必须逐字不变——新调用方忘记传参时应当落到更保守的一侧。

function proposal(status = "pending_review") {
  return {
    id: "proposal-1",
    novelId: "novel-1",
    chapterId: "chapter-9",
    taskId: "task-1",
    proposalType: "chapter_execution",
    version: 1,
    supersedesId: null,
    status,
    outlineFidelity: "balanced",
    summary: "章末状态与计划不一致。",
    reasoningSummary: "正文让主角离城，计划要求留城。",
    sourceRefs: [],
    warnings: [],
    expectedState: null,
    isStale: false,
    staleReasons: [],
    approvedAt: null,
    executedAt: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    changes: [],
  };
}

function input() {
  return {
    taskId: "task-1",
    chapterId: "chapter-9",
    proposalType: "chapter_execution",
    outlineFidelity: "balanced",
    summary: "章末状态与计划不一致。",
    reasoningSummary: "正文让主角离城，计划要求留城。",
    sourceRefs: [],
    warnings: [],
    changes: [{
      proposalType: "relation_state_update",
      path: "Character.A.relationship.B.trust",
      operation: "replace",
      category: "relationship",
      severity: "minor",
      before: 50,
      after: 55,
      payload: {},
      reason: "占位变更，本用例只关心投影方式。",
      sourceRefs: [],
      evidence: [],
    }],
  };
}

function evaluation({ canRun, requiresApproval }) {
  return {
    autonomyLevel: canRun && !requiresApproval ? "L3" : "L1",
    directorPolicyMode: "run_until_gate",
    policyMode: canRun && !requiresApproval ? "auto_safe_scope" : "run_next_step",
    policy: {},
    decision: {
      canRun,
      requiresApproval,
      reason: requiresApproval ? "review required" : "safe to run",
    },
  };
}

function buildService({ gate, apply, events, checkpoints, warnings }) {
  return new AiChangeProposalProducerService(
    {
      createProposal: async () => proposal(),
      markTaskProposalReviewRequired: async (value) => {
        checkpoints.push(value.status);
      },
    },
    { approveProposal: async () => proposal("approved") },
    { executeProposal: apply ?? (async () => proposal("executed")) },
    { evaluate: async () => gate },
    { recordEvent: async (event) => { events.push(event); } },
    (message, details) => warnings.push({ message, details }),
  );
}

test("default review projection keeps the Phase 2A checkpoint behavior unchanged", async () => {
  const events = [];
  const checkpoints = [];
  const warnings = [];
  const service = buildService({
    gate: evaluation({ canRun: false, requiresApproval: true }),
    events,
    checkpoints,
    warnings,
  });

  const result = await service.produce("novel-1", input());

  assert.equal(result.disposition, "pending_review");
  assert.equal(result.reviewProjection, "task_checkpoint");
  assert.deepEqual(checkpoints, ["pending_review"]);
  assert.equal(events.length, 0, "default projection must not swap the checkpoint for an event");
});

test("non-blocking projection records a ledger event instead of stopping the task", async () => {
  const events = [];
  const checkpoints = [];
  const warnings = [];
  const service = buildService({
    gate: evaluation({ canRun: false, requiresApproval: true }),
    events,
    checkpoints,
    warnings,
  });

  const result = await service.produce("novel-1", input(), {
    reviewProjection: "non_blocking",
  });

  assert.equal(result.disposition, "pending_review");
  assert.equal(result.reviewProjection, "non_blocking");
  assert.deepEqual(checkpoints, [], "non-blocking must never move the task into waiting_approval");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "proposal_review_deferred");
  assert.equal(events[0].severity, "medium");
  assert.equal(events[0].novelId, "novel-1");
  assert.equal(events[0].affectedScope, "change_proposal:proposal-1");
  assert.equal(events[0].metadata.changeProposalId, "proposal-1");
});

test("non-blocking apply failure stays non-blocking but escalates to high severity", async () => {
  const events = [];
  const checkpoints = [];
  const warnings = [];
  const { ChangeProposalError } = require("../dist/services/novel/proposal/domain/ChangeProposalError.js");
  const service = buildService({
    gate: evaluation({ canRun: true, requiresApproval: false }),
    apply: async () => {
      throw new ChangeProposalError("approval_required", "policy changed before apply");
    },
    events,
    checkpoints,
    warnings,
  });

  const result = await service.produce("novel-1", input(), {
    reviewProjection: "non_blocking",
  });

  // 信封原子回滚，正文仍可用，因此不满足 AGENTS.md 任何一条停链条件。
  assert.equal(result.reviewProjection, "non_blocking");
  assert.deepEqual(checkpoints, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "proposal_review_deferred");
  assert.equal(events[0].severity, "high", "a silent apply failure must be loud in the ledger");

  // H3：disposition 必须如实反映提案的真实状态。此前这里返回 pending_review，
  // 而提案其实停在 approved——状态机从 approved 回不到待审，用户要做的是
  // 重新执行或重新生成。
  assert.equal(result.disposition, "apply_failed");
  assert.equal(result.proposal.status, "approved");
  assert.equal(events[0].metadata.proposalStatus, "approved");
  assert.match(events[0].summary, /重新执行或重新生成/);
});

test("apply failure under the default projection still checkpoints the task", async () => {
  const events = [];
  const checkpoints = [];
  const warnings = [];
  const { ChangeProposalError } = require("../dist/services/novel/proposal/domain/ChangeProposalError.js");
  const service = buildService({
    gate: evaluation({ canRun: true, requiresApproval: false }),
    apply: async () => {
      throw new ChangeProposalError("approval_required", "policy changed before apply");
    },
    events,
    checkpoints,
    warnings,
  });

  const result = await service.produce("novel-1", input());

  assert.equal(result.reviewProjection, "task_checkpoint");
  assert.deepEqual(checkpoints, ["approved"]);
  assert.equal(events.length, 0);
  // 默认投影下同样如实报告：任务被 checkpoint 了，但提案本身是 approved 未执行。
  assert.equal(result.disposition, "apply_failed");
  assert.equal(result.proposal.status, "approved");
});

test("a failing ledger write degrades to a warning instead of stopping the chain", async () => {
  const events = [];
  const checkpoints = [];
  const warnings = [];
  const service = new AiChangeProposalProducerService(
    {
      createProposal: async () => proposal(),
      markTaskProposalReviewRequired: async (value) => { checkpoints.push(value.status); },
    },
    { approveProposal: async () => proposal("approved") },
    { executeProposal: async () => proposal("executed") },
    { evaluate: async () => evaluation({ canRun: false, requiresApproval: true }) },
    { recordEvent: async () => { throw new Error("ledger unavailable"); } },
    (message, details) => warnings.push({ message, details }),
  );

  const result = await service.produce("novel-1", input(), {
    reviewProjection: "non_blocking",
  });

  assert.equal(result.disposition, "pending_review");
  assert.deepEqual(checkpoints, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /deferred review event/);
  assert.equal(warnings[0].details.changeProposalId, "proposal-1");
});

test("non-blocking auto-execution success records no deferred-review event", async () => {
  const events = [];
  const checkpoints = [];
  const warnings = [];
  const service = buildService({
    gate: evaluation({ canRun: true, requiresApproval: false }),
    events,
    checkpoints,
    warnings,
  });

  const result = await service.produce("novel-1", input(), {
    reviewProjection: "non_blocking",
  });

  assert.equal(result.disposition, "executed");
  assert.equal(result.reviewProjection, "non_blocking");
  assert.deepEqual(checkpoints, []);
  assert.equal(events.length, 0);
});
