import assert from "node:assert/strict";
import test from "node:test";
import { chapterExecutionPlanPatchSchema } from "@ai-novel/shared/types/chapterExecutionPlan";
import {
  PLAN_PATCH_FIELDS,
  isChapterDivergenceChange,
  readDivergencePayload,
  withDownstreamPatches,
} from "./divergenceCopy.ts";

function buildChange(overrides = {}) {
  return {
    id: "item-1",
    proposalType: "chapter_execution_plan_update",
    path: "chapters.9.divergence.0",
    severity: "major",
    category: "plot",
    reason: "计划要求章末留城，正文写成离城。",
    evidence: [],
    before: "章末主角留在城内等待接头",
    after: "主角连夜带队离城。",
    reviewDecision: null,
    userEditedPayload: null,
    payload: {
      chapterId: "chapter-9",
      chapterOrder: 9,
      divergenceId: "ch9:next_entry_state_changed:0",
      kind: "next_entry_state_changed",
      expected: "章末主角留在城内等待接头",
      actual: "主角连夜带队离城。",
      downstreamPlanPatches: [],
    },
    ...overrides,
  };
}

test("the form offers exactly the fields the executable patch accepts", () => {
  // 表单字段多一个，作者就会填一个写下去会被静默还原的值；少一个，
  // 本来能改的东西改不了。两边必须锁死。
  for (const field of PLAN_PATCH_FIELDS) {
    const parsed = chapterExecutionPlanPatchSchema.safeParse({
      chapterOrder: 10,
      [field.key]: "改成这样",
    });
    assert.equal(parsed.success, true, `${field.key} should be accepted by the patch schema`);
  }

  // 这些字段的权威来源是章节本身，写进补丁会在下一次同步时消失。
  for (const key of ["title", "summary", "taskSheet", "targetWordCount", "revealLevel", "sceneCards"]) {
    const parsed = chapterExecutionPlanPatchSchema.safeParse({ chapterOrder: 10, [key]: "改成这样" });
    assert.equal(parsed.success, false, `${key} must stay out of the patch schema`);
  }
});

test("a patch that only names a chapter is not executable", () => {
  assert.equal(chapterExecutionPlanPatchSchema.safeParse({ chapterOrder: 10 }).success, false);
});

test("only chapter execution divergences take the dedicated card", () => {
  assert.equal(isChapterDivergenceChange(buildChange()), true);
  assert.equal(
    isChapterDivergenceChange(buildChange({ proposalType: "character_state_update" })),
    false,
  );
});

test("a saved edit is what the author sees when reopening the item", () => {
  const change = buildChange({
    userEditedPayload: {
      chapterId: "chapter-9",
      chapterOrder: 9,
      expected: "章末主角留在城内等待接头",
      actual: "主角连夜带队离城。",
      downstreamPlanPatches: [{ chapterOrder: 10, purpose: "改到城外接应" }],
    },
  });

  const view = readDivergencePayload(change);
  assert.deepEqual(view.downstreamPlanPatches, [{ chapterOrder: 10, purpose: "改到城外接应" }]);
  assert.equal(view.chapterOrder, 9);
});

test("reading a payload ignores entries that do not name a chapter", () => {
  const change = buildChange({
    payload: {
      ...buildChange().payload,
      downstreamPlanPatches: [{ purpose: "没有章节号" }, { chapterOrder: 11, purpose: "有效" }],
    },
  });

  assert.deepEqual(readDivergencePayload(change).downstreamPlanPatches, [
    { chapterOrder: 11, purpose: "有效" },
  ]);
});

test("writing patches back preserves the rest of the payload", () => {
  const change = buildChange();
  const next = withDownstreamPatches(change, [{ chapterOrder: 10, purpose: "改到城外接应" }]);

  // originalExpected 之类的审计字段必须原样带回去，applier 只读但不能丢。
  assert.equal(next.divergenceId, "ch9:next_entry_state_changed:0");
  assert.equal(next.expected, "章末主角留在城内等待接头");
  assert.deepEqual(next.downstreamPlanPatches, [{ chapterOrder: 10, purpose: "改到城外接应" }]);
});

test("clearing the patches keeps the item recordable without plan changes", () => {
  const change = buildChange({
    userEditedPayload: {
      ...buildChange().payload,
      downstreamPlanPatches: [{ chapterOrder: 10, purpose: "先前存过的调整" }],
    },
  });

  assert.deepEqual(withDownstreamPatches(change, []).downstreamPlanPatches, []);
});
