const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseSkillPackage,
  serializeSkillPackage,
  SkillPackageParseError,
} = require("../dist/services/skillPackage/skillPackageParser.js");

function manifest(body) {
  return { path: "SKILL.md", content: body };
}

const FULL_MANIFEST = `---
name: 慢热恋爱节奏
description: 距离变化、误读、停顿与递进的安排方式
category: 恋爱
tags: 慢热, 情绪递进
applicableGenres: 都市, 校园
applicableTasks: writer, repair
---

## 叙事规则

推进靠距离变化，不靠事件密度。

## 人物规则

误读要有依据，不能只是没说清楚。

## 语言规则

少解释，多留白。

## 节奏规则

章末停在动作未完成处。
`;

test("a full package maps onto the four style rule dimensions", () => {
  const skill = parseSkillPackage([manifest(FULL_MANIFEST)]);

  assert.equal(skill.frontmatter.name, "慢热恋爱节奏");
  assert.equal(skill.frontmatter.category, "恋爱");
  assert.deepEqual(skill.frontmatter.tags, ["慢热", "情绪递进"]);
  assert.deepEqual(skill.frontmatter.applicableGenres, ["都市", "校园"]);
  assert.deepEqual(skill.frontmatter.applicableTasks, ["writer", "repair"]);

  // 四维规则要落到写法资产同名的四个维度上，而不是糊成一段。
  assert.match(skill.rules.narrative, /距离变化/);
  assert.match(skill.rules.character, /误读要有依据/);
  assert.match(skill.rules.language, /少解释/);
  assert.match(skill.rules.rhythm, /动作未完成处/);
  // 这份样例声明了 repair——合法，但当前没有环节会因它自动命中，所以有且只有
  // 那一条告警。此前这里断言的是「无告警」，那是按静默失效的行为写的。
  assert.deepEqual(skill.warnings.map((warning) => warning.code), ["inert_task_type"]);
});

test("unknown frontmatter keys keep their values, not just their names", () => {
  // Phase 3 世界书那次的教训：只留字段名会让值不可逆地消失。
  const skill = parseSkillPackage([manifest(`---
name: 测试
future_field: 将来才有的东西
---

## 叙事规则
内容
`)]);

  assert.deepEqual(skill.unknownFrontmatter, { future_field: "将来才有的东西" });
  assert.equal(
    skill.warnings.filter((item) => item.code === "unknown_frontmatter_field").length,
    1,
  );
});

test("an unknown task type is reported instead of silently never matching", () => {
  // 静默忽略会让作者以为包装好了，却永远不命中。
  const skill = parseSkillPackage([manifest(`---
name: 测试
applicableTasks: writer, 写作
---

## 叙事规则
内容
`)]);

  assert.deepEqual(skill.frontmatter.applicableTasks, ["writer"]);
  const reported = skill.warnings.filter((item) => item.code === "unknown_task_type");
  assert.equal(reported.length, 1);
  assert.match(reported[0].message, /写作/);
  assert.equal(reported[0].field, "applicableTasks");
});

test("scripts in the package are ignored and said to be ignored", () => {
  // 第一版明确只读：不 eval、不执行。但必须说出来，否则用户以为它会跑。
  const skill = parseSkillPackage([
    manifest(`---
name: 测试
---

## 叙事规则
内容
`),
    { path: "references/背景.md", content: "参考资料" },
    { path: "install.sh", content: "rm -rf /" },
    { path: "tool.py", content: "print(1)" },
  ]);

  assert.deepEqual(skill.attachments.map((item) => item.path), ["references/背景.md"]);
  const ignored = skill.warnings.filter((item) => item.code === "ignored_executable");
  assert.equal(ignored.length, 1);
  assert.match(ignored[0].message, /install\.sh/);
  assert.match(ignored[0].message, /不会被执行/);
});

test("attachments are collected by kind and keep their paths", () => {
  const skill = parseSkillPackage([
    manifest(`---
name: 测试
---

## 叙事规则
内容
`),
    { path: "references/a.md", content: "r" },
    { path: "templates/b.md", content: "t" },
    { path: "examples/c.md", content: "e" },
    { path: "随便一个.md", content: "不在三个目录里" },
  ]);

  assert.deepEqual(
    skill.attachments.map((item) => [item.kind, item.path]),
    [["reference", "references/a.md"], ["template", "templates/b.md"], ["example", "examples/c.md"]],
  );
});

test("a package with only prose still keeps the prose as instructions", () => {
  const skill = parseSkillPackage([manifest(`---
name: 只有说明
---

这是一段自由说明，没有分小节。
`)]);

  assert.match(skill.instructions, /自由说明/);
  assert.equal(
    skill.warnings.filter((item) => item.code === "empty_rules").length,
    1,
    "没有可识别小节要如实告知，但不能因此读不进来",
  );
});

test("a missing name is degraded with a warning rather than refused", () => {
  const skill = parseSkillPackage([manifest(`---
description: 没写名字
---

## 叙事规则
内容
`)]);

  assert.equal(skill.frontmatter.name, "");
  assert.equal(
    skill.warnings.filter((item) => item.code === "missing_required_field").length,
    1,
  );
});

test("a folder without SKILL.md is refused with a readable reason", () => {
  assert.throws(
    () => parseSkillPackage([{ path: "references/a.md", content: "r" }]),
    (error) => error instanceof SkillPackageParseError && error.code === "missing_manifest",
  );
});

test("export then import round-trips without losing or changing fields", () => {
  // 导出再导入是分享写法的完整闭环；这一步丢字段等于一次静默的数据裁剪。
  const original = parseSkillPackage([
    manifest(`---
name: 慢热恋爱节奏
description: 说明
category: 恋爱
tags: 慢热, 情绪递进
applicableGenres: 都市
applicableTasks: writer
future_field: 保留我
---

## 叙事规则

推进靠距离变化。

## 节奏规则

章末停在动作未完成处。
`),
    { path: "references/背景.md", content: "参考资料" },
  ]);

  const reparsed = parseSkillPackage(serializeSkillPackage(original));

  assert.deepEqual(reparsed.frontmatter, original.frontmatter);
  assert.deepEqual(reparsed.rules, original.rules);
  assert.deepEqual(reparsed.unknownFrontmatter, original.unknownFrontmatter);
  assert.deepEqual(reparsed.attachments, original.attachments);
});

test("free instructions and custom sections survive beside four-dimensional rules", () => {
  const original = parseSkillPackage([manifest(`---
name: 混合写法
---

所有场景都要先写动作，再写解释。

## 叙事规则

视角不跳出主角。

## 自定义补充

避免连续三个同长度段落。
`)]);
  const reparsed = parseSkillPackage(serializeSkillPackage(original));
  assert.match(reparsed.instructions, /所有场景都要先写动作/);
  assert.match(reparsed.instructions, /## 自定义补充/);
  assert.match(reparsed.instructions, /避免连续三个同长度段落/);
  assert.equal(reparsed.rules.narrative, "视角不跳出主角。");
});

test("unsafe and duplicate package paths are rejected at the server boundary", () => {
  assert.throws(
    () => parseSkillPackage([manifest(FULL_MANIFEST), { path: "../secret.md", content: "x" }]),
    (error) => error.code === "unsafe_path",
  );
  assert.throws(
    () => parseSkillPackage([manifest(FULL_MANIFEST), { path: "skill.md", content: "duplicate" }]),
    (error) => error.code === "duplicate_path",
  );
});

test("windows line endings and nested paths do not break parsing", () => {
  const skill = parseSkillPackage([
    { path: ".\\SKILL.md", content: "---\r\nname: 测试\r\n---\r\n\r\n## 叙事规则\r\n\r\n内容\r\n" },
    { path: "references\\sub\\a.md", content: "r" },
  ]);

  assert.equal(skill.frontmatter.name, "测试");
  assert.match(skill.rules.narrative, /内容/);
  assert.deepEqual(skill.attachments.map((item) => item.path), ["references/sub/a.md"]);
});

test("声明了合法但当前不会触发的任务类型时，预览要明说不会生效", () => {
  // repair / replan 是合法的 ModelRouteTaskType，包能正常导入、列表里照常显示，
  // 却永远不会自动命中——运行时只有 writer / planner / reviewer 三个环节会解析写法。
  // 不说出来，作者只会以为是自己没配对。
  const skill = parseSkillPackage([{
    path: "SKILL.md",
    content: "---\nname: 修补写法\napplicableTasks: writer, repair, replan\n---\n\n## 叙事规则\n内容\n",
  }]);

  // 值本身照收不误：认不出/用不上都不是丢弃的理由。
  assert.deepEqual(skill.frontmatter.applicableTasks, ["writer", "repair", "replan"]);

  const inert = skill.warnings.find((warning) => warning.code === "inert_task_type");
  assert.ok(inert, "合法但不生效的声明必须留下告警");
  assert.match(inert.message, /repair、replan/);
  assert.match(inert.message, /writer、planner、review/);
  assert.doesNotMatch(inert.message, /\bwriter、repair\b/, "生效的那个不该被算进不生效名单");
});

test("只声明了会生效的任务类型时不发这条告警", () => {
  const skill = parseSkillPackage([{
    path: "SKILL.md",
    content: "---\nname: 正文写法\napplicableTasks: writer, planner\n---\n\n## 叙事规则\n内容\n",
  }]);
  assert.equal(skill.warnings.find((warning) => warning.code === "inert_task_type"), undefined);
});
