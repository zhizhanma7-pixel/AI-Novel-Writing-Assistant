const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  SkillPackageService,
  SKILL_PACKAGE_MAX_BYTES,
} = require("../dist/services/skillPackage/SkillPackageService.js");

const MANIFEST = `---
name: 慢热恋爱节奏
description: 距离变化与递进
category: 恋爱
tags: 慢热, 情绪递进
applicableGenres: 都市
applicableTasks: writer, repair
future_field: 保留我
---

## 叙事规则

推进靠距离变化。

## 节奏规则

章末停在动作未完成处。
`;

function packageFiles() {
  return [
    { path: "SKILL.md", content: MANIFEST },
    { path: "references/背景.md", content: "参考资料：《寒江雪》里的沈砚。" },
  ];
}

test("preview reports what will take effect without writing anything", () => {
  const preview = new SkillPackageService().preview(packageFiles());

  assert.equal(preview.name, "慢热恋爱节奏");
  assert.deepEqual(preview.applicableTasks, ["writer", "repair"]);
  assert.equal(preview.attachmentCount, 1);
  assert.ok(preview.ruleLengths.narrative > 0);
  // 空的那两维要能一眼看出来，而不是让用户以为都填了。
  assert.equal(preview.ruleLengths.character, 0);
  assert.equal(preview.ruleLengths.language, 0);
  // 认不出的字段名如实列出；原值随包留存。
  assert.deepEqual(preview.unknownFields, ["future_field"]);
  assert.ok(preview.sizeBytes > 0);
  assert.ok(preview.warnings.some((warning) => warning.code === "story_state_scope_warning"));
  assert.ok(preview.warnings.some((warning) => (
    warning.code === "source_entities_detected" && /寒江雪/.test(warning.message)
  )), "预览必须把检测到的源作实体摆给作者看");
});

test("an oversized package is refused instead of being squeezed into one row", () => {
  const service = new SkillPackageService();
  const huge = [
    { path: "SKILL.md", content: MANIFEST },
    { path: "references/大.md", content: "字".repeat(SKILL_PACKAGE_MAX_BYTES) },
  ];

  assert.throws(
    () => service.preview(huge),
    (error) => error.code === "package_too_large" && /KB 上限/.test(error.message),
  );
});

test("超标的包在解析之前就被拒，而不是解析完再拒", () => {
  // 请求体上限是 20MB，而包上限是 256KB。体积检查放在解析之后等于没检查：
  // 一个 20MB 的包会被完整解析一遍才被拒。这里用一个既超标、又必然让
  // 解析抛别的错的包来定序——只要顺序反了，抛出来的就不是 package_too_large。
  const service = new SkillPackageService();
  const oversizedAndBroken = [
    { path: "references/大.md", content: "字".repeat(SKILL_PACKAGE_MAX_BYTES) },
  ];

  assert.throws(
    () => service.preview(oversizedAndBroken),
    (error) => error.code === "package_too_large",
    "缺 SKILL.md 的错先抛出来，说明解析跑在了体积检查前面",
  );
});

test("importing creates a style profile that carries the package back out unchanged", async () => {
  const originals = {
    create: prisma.styleProfile.create,
    findUnique: prisma.styleProfile.findUnique,
  };
  let stored = null;
  prisma.styleProfile.create = async ({ data }) => {
    stored = data;
    return {
      ...data,
      id: "style-skill-1",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      antiAiBindings: [],
    };
  };
  prisma.styleProfile.findUnique = async () => ({ ...stored, id: "style-skill-1" });

  try {
    const service = new SkillPackageService();
    const files = packageFiles();
    const { preview } = await service.importPackage({ files });

    assert.equal(preview.name, "慢热恋爱节奏");
    // Skill 不是新资产：落地的就是一条写法资产。
    assert.equal(stored.sourceType, "imported_skill");
    assert.deepEqual(JSON.parse(stored.applicableTasksJson), ["writer", "repair"]);
    assert.deepEqual(JSON.parse(stored.narrativeRulesJson), { summary: "推进靠距离变化。" });
    // 别人的一套写法，作者还没看过一眼，不该在下一次生成时就开始左右自己的文字。
    // 自动命中要作者自己开；手动绑定不受此限制。
    assert.equal(stored.status, "archived", "导入进来不能默认参与自动命中");
    // 没写的维度存空对象，不要塞一个假的 summary 进去。
    assert.deepEqual(JSON.parse(stored.characterRulesJson), {});
    // 整包原文进 sourceContent：既保证导出无损，也让示例里的源作实体进入脱敏候选。
    assert.match(stored.sourceContent, /沈砚/);

    const exported = await service.exportPackage("style-skill-1");
    assert.deepEqual(exported, files, "导出必须与导入逐字一致，否则分享一圈就少了东西");
  } finally {
    prisma.styleProfile.create = originals.create;
    prisma.styleProfile.findUnique = originals.findUnique;
  }
});

test("a profile that never came from a package can still be exported", async () => {
  // 「把自己炼的写法拷给别人」不该只对导入过的资产成立。
  const original = prisma.styleProfile.findUnique;
  prisma.styleProfile.findUnique = async () => ({
    id: "style-hand-1",
    name: "手工写法",
    description: "自己炼的",
    category: null,
    tagsJson: JSON.stringify(["冷硬"]),
    applicableGenresJson: JSON.stringify(["悬疑"]),
    applicableTasksJson: JSON.stringify(["writer"]),
    sourceType: "from_text",
    sourceContent: "原始素材",
    analysisMarkdown: "说明",
    narrativeRulesJson: JSON.stringify({ summary: "短句推进。" }),
    characterRulesJson: null,
    languageRulesJson: null,
    rhythmRulesJson: null,
  });

  try {
    const files = await new SkillPackageService().exportPackage("style-hand-1");
    const manifest = files.find((file) => file.path === "SKILL.md");

    assert.ok(manifest);
    assert.match(manifest.content, /name: 手工写法/);
    assert.match(manifest.content, /applicableTasks: writer/);
    assert.match(manifest.content, /## 叙事规则/);
    assert.match(manifest.content, /短句推进。/);
  } finally {
    prisma.styleProfile.findUnique = original;
  }
});

test("importing without a name is refused rather than creating a nameless asset", async () => {
  const service = new SkillPackageService();
  await assert.rejects(
    () => service.importPackage({
      files: [{ path: "SKILL.md", content: "---\ndescription: 没名字\n---\n\n## 叙事规则\n内容\n" }],
    }),
    (error) => error.code === "missing_name",
  );
});

test("a missing profile is refused with a readable reason", async () => {
  const original = prisma.styleProfile.findUnique;
  prisma.styleProfile.findUnique = async () => null;
  try {
    await assert.rejects(
      () => new SkillPackageService().exportPackage("nope"),
      (error) => error.code === "profile_not_found",
    );
  } finally {
    prisma.styleProfile.findUnique = original;
  }
});

test("编辑过的资产导出的是当前值，不是当初导入的那个包", async () => {
  // 作者改了名称和规则，导出却还是旧的，等于把自己都已经不用的版本拷给别人。
  const original = prisma.styleProfile.findUnique;
  const service = new SkillPackageService();
  const importedPackage = JSON.stringify({ version: 1, files: packageFiles() });

  prisma.styleProfile.findUnique = async () => ({
    id: "style-skill-1",
    sourceType: "imported_skill",
    // 库里是编辑之后的值。
    name: "改过的名字",
    description: "改过的说明",
    category: "悬疑",
    tagsJson: JSON.stringify(["改过的标签"]),
    applicableGenresJson: JSON.stringify([]),
    applicableTasksJson: JSON.stringify(["writer"]),
    narrativeRulesJson: JSON.stringify({ summary: "改过的叙事规则。" }),
    characterRulesJson: null,
    languageRulesJson: null,
    rhythmRulesJson: null,
    analysisMarkdown: "改过的说明正文",
    // sourceContent 仍是导入时那一份。
    sourceContent: importedPackage,
  });

  try {
    const files = await service.exportPackage("style-skill-1");
    const manifest = files.find((file) => file.path === "SKILL.md").content;

    assert.match(manifest, /改过的名字/);
    assert.match(manifest, /改过的叙事规则。/);
    assert.match(manifest, /改过的说明正文/, "规则存在时也不能吞掉编辑后的自由说明");
    assert.doesNotMatch(manifest, /慢热恋爱节奏/, "导出的还是导入前的旧名称");
    assert.doesNotMatch(manifest, /推进靠距离变化。/, "导出的还是导入前的旧规则");

    // 本项目不解读的东西照旧带走：附件、认不出的 frontmatter 字段。
    // 认不出不等于可以丢——Phase 3 世界书那次的教训。
    assert.ok(files.some((file) => file.path === "references/背景.md"), "附件不能丢");
    assert.match(manifest, /future_field/, "认不出的字段不能丢");
  } finally {
    prisma.styleProfile.findUnique = original;
  }
});
