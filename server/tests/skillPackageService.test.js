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
    { path: "references/背景.md", content: "参考资料：某本书里的沈砚。" },
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
