const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AiChangeProposalProducerService,
  aiChangeProposalInputSchema,
} = require("../dist/services/novel/proposal/runtime/AiChangeProposalProducerService.js");
const { canAgentUseTool } = require("../dist/agents/approvalPolicy.js");
const { getAgentToolDefinition } = require("../dist/agents/toolRegistry.js");
const { compileIntentToPlan } = require("../dist/agents/planner/compiler.js");
const { intentSchema } = require("../dist/agents/planner/intentPromptSupport.js");

function proposal(status = "pending_review") {
  return {
    id: "proposal-1",
    novelId: "novel-1",
    chapterId: null,
    taskId: "task-1",
    proposalType: "relationship_change",
    version: 1,
    supersedesId: null,
    status,
    outlineFidelity: "balanced",
    summary: "Trust changes.",
    reasoningSummary: "New evidence changes the relationship.",
    sourceRefs: [],
    warnings: [],
    expectedState: null,
    isStale: false,
    staleReasons: [],
    approvedAt: status === "approved" || status === "executed" ? "2026-08-26T00:00:00.000Z" : null,
    executedAt: status === "executed" ? "2026-08-26T00:01:00.000Z" : null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    changes: [{
      id: "change-1",
      proposalType: "relation_state_update",
      path: "Character.A.relationship.B.trust",
      operation: "replace",
      category: "relationship",
      severity: "minor",
      before: 50,
      after: 55,
      payload: {},
      reason: "Trust improves.",
      sourceRefs: [],
      evidence: [],
      status: "pending_review",
      reviewDecision: null,
      userEditedPayload: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    }],
  };
}

function input() {
  return {
    taskId: "task-1",
    proposalType: "relationship_change",
    outlineFidelity: "balanced",
    summary: "Trust changes.",
    reasoningSummary: "New evidence changes the relationship.",
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
      reason: "Trust improves.",
      sourceRefs: [],
      evidence: [],
    }],
  };
}

function evaluation({ canRun, requiresApproval, mode }) {
  return {
    autonomyLevel: mode === "auto_safe_scope" ? "L3" : "L1",
    policyMode: mode,
    policy: { mode },
    decision: {
      canRun,
      requiresApproval,
      reason: requiresApproval ? "review required" : "safe to run",
    },
  };
}

test("AI proposal producer leaves gated proposals pending without approving or applying", async () => {
  const calls = [];
  const created = proposal();
  const service = new AiChangeProposalProducerService(
    {
      createProposal: async (_novelId, _input, options) => {
        calls.push(["create", options]);
        return created;
      },
      markTaskProposalReviewRequired: async (value) => calls.push(["checkpoint", value.status]),
    },
    { approveProposal: async () => { throw new Error("must not approve"); } },
    { executeProposal: async () => { throw new Error("must not apply"); } },
    { evaluate: async () => evaluation({ canRun: false, requiresApproval: true, mode: "run_next_step" }) },
  );

  const result = await service.produce("novel-1", input());

  assert.equal(result.disposition, "pending_review");
  assert.equal(result.autonomyLevel, "L1");
  assert.deepEqual(calls, [
    ["create", { deferTaskCheckpoint: true }],
    ["checkpoint", "pending_review"],
  ]);
});

test("AI proposal producer auto-approves and applies only through automation authority", async () => {
  const calls = [];
  const service = new AiChangeProposalProducerService(
    {
      createProposal: async () => proposal(),
      markTaskProposalReviewRequired: async () => calls.push(["checkpoint"]),
    },
    {
      approveProposal: async (_novelId, _proposalId, review) => {
        calls.push(["approve", review]);
        return proposal("approved");
      },
    },
    {
      executeProposal: async (_novelId, _proposalId, options) => {
        calls.push(["execute", options]);
        return proposal("executed");
      },
    },
    { evaluate: async () => evaluation({ canRun: true, requiresApproval: false, mode: "auto_safe_scope" }) },
  );

  const result = await service.produce("novel-1", input());

  assert.equal(result.disposition, "executed");
  assert.equal(result.autonomyLevel, "L3");
  assert.deepEqual(calls, [
    ["approve", { expectedVersion: 1 }],
    ["execute", { authority: "automation" }],
  ]);
});

test("AI proposal input cannot self-assign policy or autonomy", () => {
  assert.throws(() => aiChangeProposalInputSchema.parse({
    ...input(),
    autonomyLevel: "L3",
  }));
  assert.throws(() => aiChangeProposalInputSchema.parse({
    ...input(),
    policyMode: "auto_safe_scope",
  }));
});

test("proposal tool is planner-only and does not add a static approval gate", () => {
  const definition = getAgentToolDefinition("propose_novel_change");
  assert.equal(canAgentUseTool("Planner", "propose_novel_change"), true);
  assert.equal(canAgentUseTool("Writer", "propose_novel_change"), false);
  assert.equal(canAgentUseTool("Reviewer", "propose_novel_change"), false);
  assert.equal(definition.approvalRequired, undefined);
  assert.equal(definition.category, "mutate");
});

test("structured proposal intent compiles into the registered Planner tool", () => {
  const { taskId: _taskId, ...changeProposal } = input();
  const plan = compileIntentToPlan({
    goal: "把这次关系变化做成提案",
    intent: "propose_novel_change",
    confidence: 0.95,
    requiresNovelContext: true,
    interactionMode: "execute",
    assistantResponse: "execute",
    shouldAskFollowup: false,
    missingInfo: [],
    chapterSelectors: {},
    changeProposal,
  }, {
    goal: "把这次关系变化做成提案",
    messages: [],
    contextMode: "novel",
    novelId: "novel-1",
  });

  assert.deepEqual(plan.actions.map((action) => action.tool), ["propose_novel_change"]);
  assert.equal(plan.actions[0].input.novelId, "novel-1");
  assert.equal(plan.actions[0].input.taskId, undefined);
  assert.equal(plan.actions[0].input.policyMode, undefined);
});

test("Planner intent schema accepts proposal facts but rejects embedded policy authority", () => {
  const { taskId: _taskId, ...changeProposal } = input();
  const base = {
    goal: "把这次关系变化做成提案",
    intent: "propose_novel_change",
    requiresNovelContext: true,
    chapterSelectors: {},
    changeProposal,
  };

  assert.equal(intentSchema.parse(base).intent, "propose_novel_change");
  assert.throws(() => intentSchema.parse({
    ...base,
    changeProposal: {
      ...changeProposal,
      policyMode: "auto_safe_scope",
    },
  }));
});
