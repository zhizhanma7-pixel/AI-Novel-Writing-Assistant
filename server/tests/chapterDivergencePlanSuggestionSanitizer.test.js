const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeDivergencePlanSuggestions,
} = require("../dist/services/novel/proposal/chapterExecution/domain/ChapterDivergencePlanSuggestionSanitizer.js");
const {
  MAX_DIVERGENCE_PLAN_SUGGESTIONS,
} = require("../../shared/dist/types/chapterDivergencePlanSuggestion.js");

const DOWNSTREAM = [
  { chapterOrder: 10, title: "接头" },
  { chapterOrder: 11, title: "追兵" },
  { chapterOrder: 12, title: "渡口" },
];

function sanitize(suggestions, downstream = DOWNSTREAM, currentChapterOrder = 9) {
  return sanitizeDivergencePlanSuggestions({
    result: { suggestions },
    downstreamChapters: downstream,
    currentChapterOrder,
  });
}

test("sanitizer keeps a well-formed suggestion and attaches the chapter title", () => {
  const result = sanitize([
    { chapterOrder: 10, purpose: "改到城外接应", reason: "主角已经离城，城内接头不再成立。" },
  ]);

  assert.deepEqual(result.suggestions, [{
    patch: { chapterOrder: 10, purpose: "改到城外接应" },
    reason: "主角已经离城，城内接头不再成立。",
    chapterTitle: "接头",
  }]);
  assert.deepEqual(result.discarded, []);
});

test("sanitizer refuses to touch the current chapter or anything before it", () => {
  const result = sanitize([
    { chapterOrder: 9, purpose: "回头改本章", reason: "模型想改发生偏离的这一章。" },
    { chapterOrder: 8, purpose: "改更早的章", reason: "模型想改已经写完的章。" },
    { chapterOrder: 10, purpose: "改到城外接应", reason: "这条是合法的。" },
  ]);

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].patch.chapterOrder, 10);
  assert.deepEqual(result.discarded.map((item) => item.chapterOrder), [9, 8]);
});

test("sanitizer drops chapters that do not exist downstream", () => {
  const result = sanitize([
    { chapterOrder: 99, purpose: "改一个不存在的章", reason: "模型编了一个章节序号。" },
  ]);

  assert.deepEqual(result.suggestions, []);
  assert.equal(result.discarded.length, 1);
  assert.equal(result.discarded[0].chapterOrder, 99);
});

test("sanitizer keeps only the first suggestion per chapter", () => {
  const result = sanitize([
    { chapterOrder: 10, purpose: "第一条", reason: "先到的。" },
    { chapterOrder: 10, purpose: "第二条", reason: "重复目标。" },
  ]);

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].patch.purpose, "第一条");
  assert.equal(result.discarded.length, 1);
});

test("sanitizer strips fields that are not part of the executable patch", () => {
  const result = sanitize([
    {
      chapterOrder: 10,
      purpose: "改到城外接应",
      // 这些字段的权威来源是 Chapter 数据列，写进 patch 会在下一次 hydrate
      // 时被静默还原，因此必须在这里就丢掉。
      title: "模型想改标题",
      summary: "模型想改摘要",
      targetWordCount: 3000,
      reason: "只有 purpose 应该留下。",
    },
  ]);

  assert.deepEqual(result.suggestions[0].patch, { chapterOrder: 10, purpose: "改到城外接应" });
});

test("sanitizer drops a suggestion that would not change any planning field", () => {
  const result = sanitize([
    { chapterOrder: 10, title: "只想改标题", reason: "剥掉不可写字段后什么都不剩。" },
  ]);

  assert.deepEqual(result.suggestions, []);
  assert.equal(result.discarded.length, 1);
});

test("sanitizer caps how many downstream chapters one acceptance can touch", () => {
  const downstream = [];
  const suggestions = [];
  for (let offset = 1; offset <= MAX_DIVERGENCE_PLAN_SUGGESTIONS + 2; offset += 1) {
    const chapterOrder = 9 + offset;
    downstream.push({ chapterOrder, title: `第${chapterOrder}章` });
    suggestions.push({ chapterOrder, purpose: `改第${chapterOrder}章`, reason: "批量改动。" });
  }

  const result = sanitize(suggestions, downstream);

  assert.equal(result.suggestions.length, MAX_DIVERGENCE_PLAN_SUGGESTIONS);
  assert.equal(result.discarded.length, 2);
});

test("an empty suggestion list is a valid answer, not an error", () => {
  const result = sanitize([]);

  assert.deepEqual(result.suggestions, []);
  assert.deepEqual(result.discarded, []);
});

test("sanitizer accepts an explicit null as clearing a planning field", () => {
  const result = sanitize([
    { chapterOrder: 11, exclusiveEvent: null, reason: "这一章不再需要独占事件。" },
  ]);

  assert.deepEqual(result.suggestions[0].patch, { chapterOrder: 11, exclusiveEvent: null });
});
