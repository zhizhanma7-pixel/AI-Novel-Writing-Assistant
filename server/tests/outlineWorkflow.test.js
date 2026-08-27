const test = require("node:test");
const assert = require("node:assert/strict");

const {
  outlineFaithfulPolishPrompt,
} = require("../dist/prompting/prompts/novel/outlineWorkflow.prompts.js");

function strictInput() {
  return {
    fidelity: "strict",
    currentPlanningContext: "",
    draft: {
      title: "测试大纲",
      sourceSummary: "三个连续事件",
      coreEvents: [
        { id: "e22", sourceText: "22 吃饭", sourceOrder: 0, inferredChapterOrder: 22, title: "吃饭", characters: [], causes: [], outcomes: [], confidence: 1 },
        { id: "e23", sourceText: "23 A离开", sourceOrder: 1, inferredChapterOrder: 23, title: "A离开", characters: ["A"], causes: [], outcomes: [], confidence: 1 },
        { id: "e24", sourceText: "24 B调查", sourceOrder: 2, inferredChapterOrder: 24, title: "B调查", characters: ["B"], causes: [], outcomes: [], confidence: 1 },
      ],
    },
  };
}

function output(chapters, preservedEventIds = ["e22", "e23", "e24"]) {
  return {
    polishedSummary: "保留三件事并补足转场。",
    preservationObligations: preservedEventIds.map((eventId, index) => ({
      id: `ob_${eventId}`,
      eventId,
      kind: "event",
      description: `保留 ${eventId}`,
      requiredOrder: index,
    })),
    preservedEventIds,
    chapters,
    dependencyImpacts: [],
    warnings: [],
  };
}

test("strict outline preservation accepts all core events in source order", () => {
  const result = outlineFaithfulPolishPrompt.postValidate(output([
    { order: 22, title: "吃饭", summary: "吃饭", purpose: "铺垫", sourceEventIds: ["e22"], beats: ["吃饭"] },
    { order: 23, title: "离开", summary: "A离开", purpose: "转折", sourceEventIds: ["e23"], beats: ["离开"] },
    { order: 24, title: "调查", summary: "B调查", purpose: "推进", sourceEventIds: ["e24"], beats: ["调查"] },
  ]), strictInput(), {});
  assert.equal(result.chapters.length, 3);
});

test("strict outline preservation rejects a missing or reordered core event", () => {
  assert.throws(() => outlineFaithfulPolishPrompt.postValidate(output([
    { order: 22, title: "吃饭", summary: "吃饭", purpose: "铺垫", sourceEventIds: ["e22"], beats: ["吃饭"] },
    { order: 23, title: "调查", summary: "B调查", purpose: "推进", sourceEventIds: ["e24"], beats: ["调查"] },
  ], ["e22", "e24"]), strictInput(), {}), /outline_preservation_failed/);

  assert.throws(() => outlineFaithfulPolishPrompt.postValidate(output([
    { order: 22, title: "离开", summary: "A离开", purpose: "转折", sourceEventIds: ["e23"], beats: ["离开"] },
    { order: 23, title: "吃饭", summary: "吃饭", purpose: "铺垫", sourceEventIds: ["e22"], beats: ["吃饭"] },
    { order: 24, title: "调查", summary: "B调查", purpose: "推进", sourceEventIds: ["e24"], beats: ["调查"] },
  ]), strictInput(), {}), /event order changed/);
});
