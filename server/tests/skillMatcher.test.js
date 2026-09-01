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

test("提示词工坊预览与正文链走同一个入口", () => {
  // 验收要求「预览里能看到 Skill 已被注入」。但预览若自己单独查一次匹配器，
  // 就会漏掉人工绑定的排除，而且预览与生产成了两条路——预览再也证明不了生产的行为。
  // 结构约束的正本在 skillProductionChain.test.js，这里只钉住预览确实接了上下文。
  const fs = require("node:fs");
  const path = require("node:path");
  const previewCtx = fs.readFileSync(
    path.join(__dirname, "../src/prompting/workbench/writerPreviewContext.ts"),
    "utf8",
  );
  assert.match(previewCtx, /matchedSkills: input\.matchedSkills \?\? \[\]/);
});

test("自动命中的规则文本也要过禁用实体这道", () => {
  // 同一条写法人工绑定时会经 collectProfileText 进实体提取并在契约里被遮蔽；
  // 自动命中是 StyleRuntimeResolver 之后才挂上去的，赶不上 StyleBindingService
  // 里那一趟。不补这道，别人原作里的人名就原样进提示词了——Skill 恰恰全是别人的原作。
  const {
    sanitizeMatchedSkillsForGeneration,
  } = require("../dist/services/styleEngine/styleGenerationSanitizer.js");

  const sanitized = sanitizeMatchedSkillsForGeneration({
    matchedBindings: [],
    compiledBlocks: null,
    effectiveStyleProfileId: null,
    taskStyleProfileId: null,
    activeSourceTargets: [],
    activeSourceLabels: [],
    maturity: "summary_only",
    usesGlobalAntiAiBaseline: false,
    globalAntiAiRuleIds: [],
    styleAntiAiRuleIds: [],
    sanitizedGenerationProfile: {
      writingGuidance: [],
      forbiddenEntities: [],
      sourceProfileNames: [],
      sanitizedAt: new Date().toISOString(),
      strategy: "deterministic",
    },
    matchedSkills: [{
      styleProfileId: "a",
      name: "慢热恋爱节奏",
      description: "距离变化",
      matchedTask: "writer",
      ruleSummary: "推进靠《寒江雪》里那种距离变化。",
    }],
  });

  const skill = sanitized.matchedSkills[0];
  assert.doesNotMatch(skill.ruleSummary, /寒江雪/, "原作名不能原样进提示词");
  assert.match(skill.ruleSummary, /\[source-entity\]/);
  // 名字留着：预览要靠它说明这一条为什么会出现。
  assert.equal(skill.name, "慢热恋爱节奏");
  // 扩过的禁用清单要写回去，成稿检查才查得到这些词。
  assert.ok(sanitized.sanitizedGenerationProfile.forbiddenEntities.includes("寒江雪"));
});

test("没有自动命中时消毒是空操作", () => {
  const {
    sanitizeMatchedSkillsForGeneration,
  } = require("../dist/services/styleEngine/styleGenerationSanitizer.js");
  const context = { matchedBindings: [], matchedSkills: [] };
  assert.equal(sanitizeMatchedSkillsForGeneration(context), context);
});

test("只有自由正文、没有四维小节的包也能命中", async () => {
  // 解析层明确允许这种包（只留一条 empty_rules 告警，全文进 analysisMarkdown）。
  // 匹配器若只认四维 summary，它就成了「导入成功、显示正常、永远不生效」——
  // 比读不进来更糟，因为作者看不出问题在哪。
  await withProfiles(
    [profile("free", ["writer"], {
      narrativeRulesJson: null,
      analysisMarkdown: "写悬疑揭露时不要一次给完答案。",
    })],
    async () => {
      const matched = await new SkillMatcherService().matchForAgent({ agent: "writer" });
      assert.deepEqual(matched.map((item) => item.styleProfileId), ["free"]);
      assert.match(matched[0].ruleSummary, /不要一次给完答案/);
    },
  );
});

test("自由正文进上下文前会截断", async () => {
  // 四维规则是作者压缩过的摘要；自由正文可能是整篇 SKILL.md，
  // 原样塞进去会把上下文预算吃掉。截断优于丢弃。
  await withProfiles(
    [profile("long", ["writer"], {
      narrativeRulesJson: null,
      analysisMarkdown: "字".repeat(5000),
    })],
    async () => {
      const matched = await new SkillMatcherService().matchForAgent({ agent: "writer" });
      assert.ok(matched[0].ruleSummary.length < 700, matched[0].ruleSummary.length);
      assert.match(matched[0].ruleSummary, /…$/);
    },
  );
});

test("四维和正文都空才真的跳过", async () => {
  await withProfiles(
    [profile("empty", ["writer"], { narrativeRulesJson: null, analysisMarkdown: "   " })],
    async () => {
      assert.deepEqual(await new SkillMatcherService().matchForAgent({ agent: "writer" }), []);
    },
  );
});
