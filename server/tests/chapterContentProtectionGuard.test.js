const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertChapterPlanWriteIsSafe,
  probeChapterPlanImpacts,
} = require("../dist/services/novel/planning/guards/ChapterContentProtectionGuard.js");

function fakeDb(chapters) {
  return {
    chapter: {
      findMany: async () => chapters,
    },
  };
}

test("chapter plan impact probe derives content risk from stored chapters", async () => {
  const impacts = await probeChapterPlanImpacts({
    novelId: "novel-1",
    mutations: [
      {
        operation: "update_plan_fields",
        chapterId: "chapter-written",
        currentChapterOrder: 2,
        fields: ["title", "expectation"],
      },
      {
        operation: "update_plan_fields",
        chapterId: "chapter-empty",
        currentChapterOrder: 3,
        fields: ["taskSheet"],
      },
    ],
  }, fakeDb([
    { id: "chapter-written", order: 2, content: "已有正文" },
    { id: "chapter-empty", order: 3, content: "  " },
  ]));

  assert.deepEqual(impacts, [
    {
      chapterOrder: 2,
      chapterId: "chapter-written",
      hasExistingContent: true,
      code: "existing_chapter_content",
      severityFloor: "major",
    },
    {
      chapterOrder: 3,
      chapterId: "chapter-empty",
      hasExistingContent: false,
      code: "chapter_plan_update",
      severityFloor: "minor",
    },
  ]);
});

test("chapter content guard blocks removing or reordering a written chapter", async () => {
  const tx = fakeDb([{ id: "chapter-written", order: 2, content: "已有正文" }]);

  for (const mutation of [
    { operation: "remove", chapterId: "chapter-written", currentChapterOrder: 2 },
    { operation: "reorder", chapterId: "chapter-written", currentChapterOrder: 2, nextChapterOrder: 5 },
  ]) {
    await assert.rejects(
      () => assertChapterPlanWriteIsSafe(tx, {
        novelId: "novel-1",
        proposalType: "outline_plan_update",
        mutations: [mutation],
      }),
      (error) => error?.reason === "chapter_content_protected",
    );
  }
});

test("chapter content guard allows planning-field updates on a written chapter", async () => {
  const tx = fakeDb([{ id: "chapter-written", order: 2, content: "已有正文" }]);

  await assert.doesNotReject(() => assertChapterPlanWriteIsSafe(tx, {
    novelId: "novel-1",
    proposalType: "outline_plan_update",
    mutations: [{
      operation: "update_plan_fields",
      chapterId: "chapter-written",
      currentChapterOrder: 2,
      fields: ["title", "expectation", "taskSheet"],
    }],
  }));
});

test("chapter content guard rejects a runtime attempt to write content", async () => {
  const tx = fakeDb([{ id: "chapter-written", order: 2, content: "已有正文" }]);

  await assert.rejects(
    () => assertChapterPlanWriteIsSafe(tx, {
      novelId: "novel-1",
      proposalType: "outline_plan_update",
      mutations: [{
        operation: "update_plan_fields",
        chapterId: "chapter-written",
        currentChapterOrder: 2,
        fields: ["content"],
      }],
    }),
    (error) => error?.reason === "invalid_payload",
  );
});
