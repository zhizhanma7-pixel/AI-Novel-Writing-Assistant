const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findDownstreamPatchViolations,
} = require("../dist/services/novel/proposal/chapterExecution/domain/ChapterExecutionPatchBoundary.js");

const EXISTING = [1, 5, 9, 10, 11];

function check(patches, currentChapterOrder = 9) {
  return findDownstreamPatchViolations({
    currentChapterOrder,
    patches,
    existingChapterOrders: EXISTING,
  });
}

test("a downstream patch on an existing later chapter is accepted", () => {
  assert.deepEqual(check([{ chapterOrder: 10, purpose: "改到城外接应" }]), []);
});

test("the diverging chapter itself cannot be patched", () => {
  const violations = check([{ chapterOrder: 9, purpose: "回头改本章" }]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "not_downstream");
  assert.equal(violations[0].chapterOrder, 9);
});

test("an earlier chapter cannot be patched even though it exists", () => {
  // 第 5 章真实存在，所以这一条只可能被「不在下游」挡住，不是「章节不存在」。
  const violations = check([{ chapterOrder: 5, purpose: "改已经写完的章" }]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "not_downstream");
});

test("a chapter that does not exist is rejected", () => {
  const violations = check([{ chapterOrder: 44, purpose: "编出来的章" }]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "unknown_chapter");
});

test("two patches on the same chapter are rejected instead of silently merged", () => {
  // applier 用 Map 建索引，不挡住的话后一条会静默盖掉前一条，
  // 作者看到的和真正写进去的就不是一回事了。
  const violations = check([
    { chapterOrder: 10, purpose: "第一条" },
    { chapterOrder: 10, purpose: "第二条" },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "duplicate_chapter");
  assert.equal(violations[0].chapterOrder, 10);
});

test("every offending patch is reported, not just the first", () => {
  const violations = check([
    { chapterOrder: 10, purpose: "合法" },
    { chapterOrder: 9, purpose: "本章" },
    { chapterOrder: 44, purpose: "不存在" },
    { chapterOrder: 10, purpose: "重复" },
  ]);
  assert.deepEqual(
    violations.map((violation) => [violation.code, violation.chapterOrder]),
    [["not_downstream", 9], ["unknown_chapter", 44], ["duplicate_chapter", 10]],
  );
});

test("an empty patch list has nothing to violate", () => {
  assert.deepEqual(check([]), []);
});
