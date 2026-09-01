const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  SkillMatcherService,
  MAX_MATCHED_SKILLS,
} = require("../dist/services/skillPackage/SkillMatcherService.js");
const {
  buildMatchedSkillsBlock,
  MATCHED_SKILLS_BLOCK_PRIORITY,
} = require("../dist/prompting/prompts/novel/context/chapterContextBlocks.js");

function profile(id, tasks, overrides = {}) {
  return {
    id,
    name: `写法 ${id}`,
    description: "说明",
    applicableTasksJson: JSON.stringify(tasks),
    narrativeRulesJson: JSON.stringify({ summary: `${id} 的叙事规则` }),
    characterRulesJson: null,
    languageRulesJson: null,
    rhythmRulesJson: null,
    ...overrides,
  };
}

async function withProfiles(rows, run) {
  const original = prisma.styleProfile.findMany;
  prisma.styleProfile.findMany = async () => rows;
  try {
    return await run();
  } finally {
    prisma.styleProfile.findMany = original;
  }
}

test("the writer agent matches skills declared for the writer task", async () => {
  await withProfiles(
    [profile("a", ["writer"]), profile("b", ["planner"])],
    async () => {
      const matched = await new SkillMatcherService().matchForAgent({ agent: "writer" });

      assert.deepEqual(matched.map((item) => item.styleProfileId), ["a"]);
      assert.equal(matched[0].matchedTask, "writer");
      assert.match(matched[0].ruleSummary, /叙事规则/);
    },
  );
});

test("the reviewer agent maps onto the review task, not a made-up name", async () => {
  // StyleBindingAgent 是 writer/planner/reviewer，任务取值域是 ModelRouteTaskType，
  // 只有 reviewer/review 一处对不上，映射错了就永远命不中。
  await withProfiles(
    [profile("a", ["review"]), profile("b", ["reviewer"])],
    async () => {
      const matched = await new SkillMatcherService().matchForAgent({ agent: "reviewer" });

      assert.deepEqual(matched.map((item) => item.styleProfileId), ["a"]);
      assert.equal(matched[0].matchedTask, "review");
    },
  );
});

test("an already bound profile is not matched again", async () => {
  // 既绑了又命中就会注入两遍：挤占预算，预览里还会出现两条一样的。
  await withProfiles(
    [profile("a", ["writer"]), profile("b", ["writer"])],
    async () => {
      const matched = await new SkillMatcherService().matchForAgent({
        agent: "writer",
        boundProfileIds: ["a"],
      });

      assert.deepEqual(matched.map((item) => item.styleProfileId), ["b"]);
    },
  );
});

test("a matched profile with no usable rules is skipped", async () => {
  await withProfiles(
    [profile("empty", ["writer"], { narrativeRulesJson: JSON.stringify({}) })],
    async () => {
      const matched = await new SkillMatcherService().matchForAgent({ agent: "writer" });
      assert.deepEqual(matched, [], "命中了却没有可用规则，带进去只是噪声");
    },
  );
});

test("the number of auto-matched skills is capped", async () => {
  const many = Array.from({ length: MAX_MATCHED_SKILLS + 3 }, (_, index) => profile(`p${index}`, ["writer"]));
  await withProfiles(many, async () => {
    const matched = await new SkillMatcherService().matchForAgent({ agent: "writer" });
    assert.equal(matched.length, MAX_MATCHED_SKILLS, "自动命中不能把上下文顶满");
  });
});

test("collectBoundProfileIds dedupes what is already bound", () => {
  const ids = SkillMatcherService.collectBoundProfileIds([
    { styleProfileId: "a" },
    { styleProfileId: "a" },
    { styleProfileId: "b" },
  ]);
  assert.deepEqual(ids, ["a", "b"]);
});

test("matched skills render as their own block, marked auto-selected", () => {
  // 验收要求提示词预览能看出 Skill 已被注入，并且能分辨来源。
  const block = buildMatchedSkillsBlock([{
    styleProfileId: "a",
    name: "慢热恋爱节奏",
    description: "距离变化",
    matchedTask: "writer",
    ruleSummary: "推进靠距离变化。",
  }]);

  assert.ok(block);
  assert.equal(block.id, "matched_skills");
  assert.match(block.content, /慢热恋爱节奏/);
  assert.match(block.content, /推进靠距离变化/);
  assert.match(block.content, /auto-selected/, "要标明是自动命中而不是人工绑定");
  // 人工绑定的写法契约是 74；预算不够时必须先丢自动命中的那一块。
  assert.ok(MATCHED_SKILLS_BLOCK_PRIORITY < 74, "人工绑定不能被自动命中挤掉");
  // 附件与原文不进提示词，只有规则摘要进。
  assert.equal(block.required, false);
});

test("no matched skills means no block at all", () => {
  assert.equal(buildMatchedSkillsBlock([]), null);
  assert.equal(buildMatchedSkillsBlock(undefined), null);
});
