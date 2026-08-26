const test = require("node:test");
const assert = require("node:assert/strict");

const {
  directorPolicyModeToProposalAutonomyLevel,
  proposalAutonomyLevelToPolicyMode,
} = require("../../shared/dist/types/proposalRuntime.js");
const {
  ChangeProposalPolicyGateService,
} = require("../dist/services/novel/proposal/runtime/ChangeProposalPolicyGateService.js");

function buildPolicy(mode) {
  return {
    mode,
    mayOverwriteUserContent: false,
    maxAutoRepairAttempts: 1,
    allowExpensiveReview: false,
    modelTier: "balanced",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

function buildProposal({ severity = "minor", fidelity = "balanced" } = {}) {
  return {
    novelId: "novel-1",
    chapterId: null,
    taskId: "task-1",
    proposalType: "outline_edit",
    outlineFidelity: fidelity,
    changes: [{ severity }],
  };
}

function gateForMode(mode) {
  return new ChangeProposalPolicyGateService(
    undefined,
    { getSnapshot: async () => ({ policy: buildPolicy(mode) }) },
  );
}

test("proposal autonomy levels map one-to-one to director policy modes", () => {
  const pairs = [
    ["L0", "suggest_only"],
    ["L1", "run_next_step"],
    ["L2", "run_until_gate"],
    ["L3", "auto_safe_scope"],
  ];
  for (const [level, mode] of pairs) {
    assert.equal(proposalAutonomyLevelToPolicyMode(level), mode);
    assert.equal(directorPolicyModeToProposalAutonomyLevel(mode), level);
  }
});

test("L0 and L1 keep minor AI proposals behind explicit review", async () => {
  for (const mode of ["suggest_only", "run_next_step"]) {
    const evaluation = await gateForMode(mode).evaluate(buildProposal());
    assert.equal(evaluation.decision.canRun, false);
    assert.equal(evaluation.decision.requiresApproval, true);
  }
});

test("L2 and L3 may execute minor proposals outside strict fidelity", async () => {
  for (const mode of ["run_until_gate", "auto_safe_scope"]) {
    const evaluation = await gateForMode(mode).evaluate(buildProposal());
    assert.equal(evaluation.decision.canRun, true);
    assert.equal(evaluation.decision.requiresApproval, false);
  }
});

test("major and strict proposals require review even at L3", async () => {
  const gate = gateForMode("auto_safe_scope");
  const major = await gate.evaluate(buildProposal({ severity: "major" }));
  const strict = await gate.evaluate(buildProposal({ fidelity: "strict" }));

  assert.equal(major.decision.requiresApproval, true);
  assert.deepEqual(major.decision.riskTags, ["proposal_major"]);
  assert.equal(strict.decision.requiresApproval, true);
  assert.deepEqual(strict.decision.riskTags, ["outline_fidelity_strict"]);
});

test("unbound proposals use the safe L1 policy fallback", async () => {
  const gate = new ChangeProposalPolicyGateService(
    undefined,
    { getSnapshot: async () => null },
  );
  const evaluation = await gate.evaluate({
    ...buildProposal(),
    taskId: null,
  });

  assert.equal(evaluation.autonomyLevel, "L1");
  assert.equal(evaluation.policyMode, "run_next_step");
  assert.equal(evaluation.decision.requiresApproval, true);
});
