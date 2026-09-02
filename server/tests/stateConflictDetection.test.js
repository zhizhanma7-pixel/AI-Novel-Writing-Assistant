const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectStateDiffConflicts,
} = require("../dist/services/state/stateConflictDetection.js");

/**
 * Regression tests for the status ranking used by cross-chapter conflict
 * detection.
 *
 * Both ranking helpers match on substrings, so a negated status contains its
 * own positive term: "unknown" contains "known", "unresolved" contains
 * "resolved", "未公开" contains "公开", "未兑现" contains "兑现". Matching the
 * positive terms first ranks "not X" as "X", which silently disables the
 * corresponding conflict checks.
 */

const CHARACTERS = [
  { id: "hero", name: "Shen Yan" },
  { id: "rival", name: "Lu Zhao" },
];

function snapshot(overrides = {}) {
  return {
    characterStates: [],
    relationStates: [],
    informationStates: [],
    foreshadowStates: [],
    ...overrides,
  };
}

function detect(previous, current) {
  return detectStateDiffConflicts({
    characters: CHARACTERS,
    previousSnapshot: previous,
    currentSnapshot: current,
  });
}

function conflictTypes(result) {
  return result.conflicts.map((item) => item.conflictType).sort();
}

function info(overrides = {}) {
  return {
    holderType: "character",
    holderRefId: "hero",
    fact: "Lu Zhao is a shadow guard",
    status: "known",
    ...overrides,
  };
}

function foreshadow(overrides = {}) {
  return {
    title: "Origin of the broken sword",
    status: "setup",
    setupChapterId: "chapter-3",
    ...overrides,
  };
}

test("a fact moving from known back to unknown is reported", () => {
  // "unknown" contains "known". Ranked by the positive term first, both sides
  // score as "known" and no regression is ever detected.
  for (const status of ["unknown", "未知", "未公开"]) {
    const result = detect(
      snapshot({ informationStates: [info({ status: "known" })] }),
      snapshot({ informationStates: [info({ status })] }),
    );

    assert.deepEqual(
      conflictTypes(result),
      ["information_regression"],
      `"${status}" was ranked as known, so the regression went unreported`,
    );
  }
});

test("a fact moving forward in confidence is not reported", () => {
  const result = detect(
    snapshot({ informationStates: [info({ status: "suspected" })] }),
    snapshot({ informationStates: [info({ status: "known" })] }),
  );

  assert.deepEqual(result.conflicts, []);
});

test("an unresolved foreshadow is not treated as a payoff", () => {
  // "unresolved" contains "resolved", "incomplete" contains "complete", and
  // "未兑现" contains "兑现". Ranking those at the payoff tier makes a
  // still-open thread look like a payoff that never had a setup.
  for (const status of ["unresolved", "incomplete", "未兑现", "未回收"]) {
    const result = detect(
      snapshot(),
      snapshot({ foreshadowStates: [foreshadow({ status, setupChapterId: null })] }),
    );

    assert.deepEqual(
      result.conflicts,
      [],
      `"${status}" was ranked as a payoff, so a missing setup was falsely reported`,
    );
  }
});

test("a foreshadow regressing away from resolved is reported", () => {
  const result = detect(
    snapshot({ foreshadowStates: [foreshadow({ status: "resolved" })] }),
    snapshot({ foreshadowStates: [foreshadow({ status: "unresolved" })] }),
  );

  assert.ok(
    conflictTypes(result).includes("foreshadow_regression"),
    "a resolved thread reopening is a real conflict and must not be hidden by the substring match",
  );
});

test("a payoff without any prior setup is still reported", () => {
  // The fix must not suppress the check it protects.
  const result = detect(
    snapshot(),
    snapshot({ foreshadowStates: [foreshadow({ status: "resolved", setupChapterId: null })] }),
  );

  assert.deepEqual(conflictTypes(result), ["foreshadow_missing_setup"]);
});

test("a payoff that names its setup chapter is not reported", () => {
  const result = detect(
    snapshot(),
    snapshot({ foreshadowStates: [foreshadow({ status: "resolved" })] }),
  );

  assert.deepEqual(result.conflicts, []);
});
