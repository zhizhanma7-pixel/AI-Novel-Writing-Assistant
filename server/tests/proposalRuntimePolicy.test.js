const test = require("node:test");
const assert = require("node:assert/strict");

const {
  directorPolicyModeToProposalAutonomyLevel,
  proposalAutonomyLevelToPolicyMode,
} = require("../../shared/dist/types/proposalRuntime.js");
const {
  ChangeProposalPolicyGateService,
} = require("../dist/services/novel/proposal/runtime/ChangeProposalPolicyGateService.js");
const {
  normalizeDirectorRuntimePolicy,
} = require("../dist/services/novel/director/runtime/directorRuntimeDefaults.js");

function buildPolicy(mode, proposalAutonomyLevel = "L1") {
  return {
    mode,
    proposalAutonomyLevel,
    mayOverwriteUserContent: false,
    maxAutoRepairAttempts: 1,
    allowExpensiveReview: false,
    modelTier: "balanced",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

function buildProposal({ severity = "minor", fidelity = "balanced", before = 50, after = 55 } = {}) {
  return {
    novelId: "novel-1",
    chapterId: null,
    taskId: "task-1",
    proposalType: "outline_edit",
    outlineFidelity: fidelity,
    changes: [{
      proposalType: "relation_state_update",
      path: "Character.A.relationship.B.trust",
      operation: "replace",
      severity,
      before,
      after,
      payload: { trustScore: after },
    }],
  };
}

function gateForLevel(proposalAutonomyLevel, mode = "run_until_gate") {
  return new ChangeProposalPolicyGateService(
    undefined,
    { getSnapshot: async () => ({ policy: buildPolicy(mode, proposalAutonomyLevel) }) },
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

test("legacy runtime policy snapshots default proposal authority to L1", () => {
  const normalized = normalizeDirectorRuntimePolicy({
    mode: "auto_safe_scope",
    mayOverwriteUserContent: false,
    maxAutoRepairAttempts: 1,
    allowExpensiveReview: false,
    modelTier: "balanced",
    updatedAt: "2026-08-26T00:00:00.000Z",
  });

  assert.equal(normalized.mode, "auto_safe_scope");
  assert.equal(normalized.proposalAutonomyLevel, "L1");
});

test("L0 and L1 keep minor AI proposals behind explicit review", async () => {
  for (const level of ["L0", "L1"]) {
    const evaluation = await gateForLevel(level, "auto_safe_scope").evaluate(buildProposal());
    assert.equal(evaluation.decision.canRun, false);
    assert.equal(evaluation.decision.requiresApproval, true);
    assert.equal(evaluation.directorPolicyMode, "auto_safe_scope");
  }
});

test("L2 and L3 may execute minor proposals outside strict fidelity", async () => {
  for (const level of ["L2", "L3"]) {
    const evaluation = await gateForLevel(level, "suggest_only").evaluate(buildProposal());
    assert.equal(evaluation.decision.canRun, true);
    assert.equal(evaluation.decision.requiresApproval, false);
    assert.equal(evaluation.directorPolicyMode, "suggest_only");
  }
});

test("major and strict proposals require review even at L3", async () => {
  const gate = gateForLevel("L3");
  const major = await gate.evaluate(buildProposal({ severity: "major" }));
  const strict = await gate.evaluate(buildProposal({ fidelity: "strict" }));

  assert.equal(major.decision.requiresApproval, true);
  assert.deepEqual(major.decision.riskTags, ["proposal_major"]);
  assert.equal(strict.decision.requiresApproval, true);
  assert.deepEqual(strict.decision.riskTags, ["outline_fidelity_strict"]);
});

test("deterministic severity floor prevents a large relation change from self-reporting minor", async () => {
  const evaluation = await gateForLevel("L3").evaluate(buildProposal({
    severity: "minor",
    before: 62,
    after: 10,
  }));

  assert.equal(evaluation.decision.requiresApproval, true);
  assert.deepEqual(evaluation.decision.riskTags, ["proposal_major"]);
});

test("deterministic severity floor uses payload and rejects a misleading displayed delta", async () => {
  const proposal = buildProposal({ severity: "minor", before: 62, after: 61 });
  proposal.changes[0].payload.trustScore = 5;
  const evaluation = await gateForLevel("L3").evaluate(proposal);

  assert.equal(evaluation.decision.requiresApproval, true);
  assert.deepEqual(evaluation.decision.riskTags, ["proposal_major"]);
});

test("character state changes cannot self-report below the major severity floor", async () => {
  const proposal = buildProposal();
  proposal.changes = [{
    proposalType: "character_state_update",
    path: "Character.A.currentGoal",
    operation: "replace",
    severity: "minor",
    before: "survive",
    after: "betray the team",
    payload: { characterId: "character-a", currentGoal: "betray the team" },
  }];
  const evaluation = await gateForLevel("L3").evaluate(proposal);

  assert.equal(evaluation.decision.requiresApproval, true);
  assert.deepEqual(evaluation.decision.riskTags, ["proposal_major"]);
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
