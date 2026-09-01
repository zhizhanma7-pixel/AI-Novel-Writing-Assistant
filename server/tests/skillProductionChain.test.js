const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { prisma } = require("../dist/db/prisma.js");
const { StyleBindingService } = require("../dist/services/styleEngine/StyleBindingService.js");
const {
  buildMatchedSkillsBlock,
} = require("../dist/prompting/prompts/novel/context/chapterContextBlocks.js");

/**
 * 自动命中的写法必须在**真实正文链**上生效，不只是在独立 Matcher 上。
 *
 * 之前的接线挂在 StyleRuntimeResolver，而正文（GenerationContextAssembler）、
 * 章节执行契约、规划都是直接调 StyleBindingService.resolveForGeneration 的，
 * 于是形成了最坏的一种假象：提示词预览里看得见，真实正文里没有。
 */

function skillRow(id, tasks, overrides = {}) {
  return {
    id,
    name: `写法 ${id}`,
    description: "说明",
    applicableTasksJson: JSON.stringify(tasks),
    analysisMarkdown: null,
    narrativeRulesJson: JSON.stringify({ summary: `${id} 的叙事规则` }),
    characterRulesJson: null,
    languageRulesJson: null,
    rhythmRulesJson: null,
    ...overrides,
  };
}

/** 让 resolveForGeneration 走到「没有人工绑定」那条最短路径上。 */
async function withNoBindings(profileRows, run) {
  const originals = {
    bindingFindMany: prisma.styleBinding.findMany,
    profileFindMany: prisma.styleProfile.findMany,
    ruleFindMany: prisma.antiAiRule.findMany,
  };
  prisma.styleBinding.findMany = async () => [];
  prisma.styleProfile.findMany = async () => profileRows;
  prisma.antiAiRule.findMany = async () => [];
  try {
    return await run();
  } finally {
    prisma.styleBinding.findMany = originals.bindingFindMany;
    prisma.styleProfile.findMany = originals.profileFindMany;
    prisma.antiAiRule.findMany = originals.ruleFindMany;
  }
}

test("正文链拿到的写法上下文带着自动命中，并能渲染成提示词块", async () => {
  await withNoBindings([skillRow("a", ["writer"])], async () => {
    // GenerationContextAssembler 走的就是这个入口，agent 也是 writer。
    const context = await new StyleBindingService().resolveForGeneration({
      novelId: "novel-1",
      chapterId: "chapter-1",
      agent: "writer",
    });

    assert.deepEqual(
      (context.matchedSkills ?? []).map((skill) => skill.styleProfileId),
      ["a"],
      "正文链没拿到自动命中——接线又挂错层了",
    );

    // 一路走到真正进提示词的那一步，而不是停在解析结果上。
    const block = buildMatchedSkillsBlock(context.matchedSkills);
    assert.ok(block, "解析到了却渲染不出块，等于没注入");
    assert.match(block.content, /a 的叙事规则/);
    assert.match(block.content, /auto-selected/);
  });
});

test("不传 agent 的调用方行为不变，不会凭空多出自动命中", async () => {
  await withNoBindings([skillRow("a", ["writer"])], async () => {
    const context = await new StyleBindingService().resolveForGeneration({ novelId: "novel-1" });
    assert.deepEqual(context.matchedSkills ?? [], []);
  });
});

test("自动命中挂在共享解析边界上，不在只有改写链会走的那一层", () => {
  // 这条是结构约束，不是行为断言：正文/规划/章节契约都直接调
  // resolveForGeneration，只有 detection/rewrite 才经过 StyleRuntimeResolver。
  const bindingService = fs.readFileSync(
    path.join(__dirname, "../src/services/styleEngine/StyleBindingService.ts"),
    "utf8",
  );
  const runtimeResolver = fs.readFileSync(
    path.join(__dirname, "../src/services/styleEngine/StyleRuntimeResolver.ts"),
    "utf8",
  );
  assert.match(bindingService, /skillMatcherService\.matchForAgent/);
  assert.doesNotMatch(
    runtimeResolver,
    /matchForAgent/,
    "挂在 StyleRuntimeResolver 上会漏掉正文与规划链",
  );

  // 提示词工坊预览也必须走同一个入口，否则预览证明不了生产的行为。
  const previewBuilder = fs.readFileSync(
    path.join(__dirname, "../src/prompting/workbench/previewContextBuilder.ts"),
    "utf8",
  );
  assert.match(previewBuilder, /resolveForGeneration\(\{/);
  assert.doesNotMatch(
    previewBuilder,
    /matchForAgent/,
    "预览单独查匹配器会漏掉人工绑定的排除，把已绑定的错标成自动命中",
  );
});

test("已人工绑定的资产不会在任何一层被再标成自动命中", async () => {
  // 预览此前单独查匹配器、不传 boundProfileIds，于是同一条资产既显示为
  // 人工绑定又显示为自动命中。改走共享入口后，排除逻辑对所有调用方一致生效。
  const originals = {
    bindingFindMany: prisma.styleBinding.findMany,
    profileFindMany: prisma.styleProfile.findMany,
  };
  let requestedBoundIds = null;
  prisma.styleBinding.findMany = async () => [];
  prisma.styleProfile.findMany = async (args) => {
    // 匹配器那次查询带 status 过滤；绑定那次不带。
    if (args?.where?.status === "active") {
      return [skillRow("a", ["writer"])];
    }
    return [];
  };
  const { skillMatcherService } = require("../dist/services/skillPackage/SkillMatcherService.js");
  const originalMatch = skillMatcherService.matchForAgent.bind(skillMatcherService);
  skillMatcherService.matchForAgent = async (input) => {
    requestedBoundIds = input.boundProfileIds;
    return originalMatch(input);
  };
  try {
    await new StyleBindingService().resolveForGeneration({
      novelId: "novel-1",
      agent: "writer",
    });
    assert.ok(Array.isArray(requestedBoundIds), "必须把已绑定的资产传给匹配器");
  } finally {
    skillMatcherService.matchForAgent = originalMatch;
    prisma.styleBinding.findMany = originals.bindingFindMany;
    prisma.styleProfile.findMany = originals.profileFindMany;
  }
});
