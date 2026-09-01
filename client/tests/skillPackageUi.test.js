import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildSkillPackageDownload,
  parseSkillPackageBundle,
  resolveSkillPackageRoot,
  toSkillPackageFiles,
} from "../src/pages/writingFormula/skillPackageFiles.ts";

const landingSource = fs.readFileSync(
  new URL("../src/pages/writingFormula/components/WritingFormulaLanding.tsx", import.meta.url),
  "utf8",
);
const pageSource = fs.readFileSync(
  new URL("../src/pages/writingFormula/WritingFormulaPage.tsx", import.meta.url),
  "utf8",
);
const dialogSource = fs.readFileSync(
  new URL("../src/pages/writingFormula/components/SkillPackageImportDialog.tsx", import.meta.url),
  "utf8",
);
const profileActionsSource = fs.readFileSync(
  new URL("../src/pages/writingFormula/components/SkillPackageProfileActions.tsx", import.meta.url),
  "utf8",
);
const sharedSource = fs.readFileSync(
  new URL("../src/pages/writingFormula/writingFormulaV2.shared.ts", import.meta.url),
  "utf8",
);

test("包根按最浅的 SKILL.md 定位，而不是直接砍掉第一段路径", () => {
  // 作者可能选中包本身，也可能选中包的父目录，两种都要认出来。
  assert.equal(resolveSkillPackageRoot(["慢热恋爱/SKILL.md"]), "慢热恋爱");
  assert.equal(
    resolveSkillPackageRoot(["下载/慢热恋爱/SKILL.md", "下载/慢热恋爱/references/a.md"]),
    "下载/慢热恋爱",
  );
  assert.equal(resolveSkillPackageRoot(["SKILL.md"]), "");
  assert.equal(resolveSkillPackageRoot(["notes.md"]), null);
});

test("包根之外的文件不会被一起塞进去", () => {
  // 选错父目录时，隔壁目录的东西不该混进这个写法包。
  const files = toSkillPackageFiles([
    { path: "下载/慢热恋爱/SKILL.md", content: "# 正文" },
    { path: "下载/慢热恋爱/references/a.md", content: "参考" },
    { path: "下载/另一个包/SKILL.md", content: "不相干" },
  ]);
  assert.deepEqual(files.map((file) => file.path), ["SKILL.md", "references/a.md"]);
});

test("脚本照样上报路径，但内容不读", () => {
  // 服务端要据此如实告知「已忽略、不会执行」；内容读进来只会把二进制塞进请求体。
  const files = toSkillPackageFiles([
    { path: "pkg/SKILL.md", content: "# 正文" },
    { path: "pkg/install.sh", content: "rm -rf /" },
  ]);
  const script = files.find((file) => file.path === "install.sh");
  assert.ok(script, "路径要留下，不能静默丢掉");
  assert.equal(script.content, "");
});

test("只有 SKILL.md 时导出的就是 SKILL.md 本身", () => {
  const download = buildSkillPackageDownload(
    [{ path: "SKILL.md", content: "# 慢热恋爱" }],
    "慢热恋爱",
  );
  assert.equal(download.fileName, "SKILL.md");
  assert.equal(download.content, "# 慢热恋爱");
});

test("带附件时打成 JSON 包，且导入侧认得回来", () => {
  // 没有引 zip 依赖，来回一趟不能丢文件。
  const files = [
    { path: "SKILL.md", content: "# 正文" },
    { path: "examples/1.md", content: "例子" },
  ];
  const download = buildSkillPackageDownload(files, "慢热恋爱");
  assert.match(download.fileName, /\.skill\.json$/);
  assert.deepEqual(parseSkillPackageBundle(download.content), files);
});

test("导出文件名里的路径分隔符被换掉", () => {
  const download = buildSkillPackageDownload(
    [{ path: "SKILL.md", content: "a" }, { path: "examples/1.md", content: "b" }],
    "都市/异能",
  );
  assert.ok(!download.fileName.includes("/"), download.fileName);
});

test("普通 JSON 不会被当成写法包", () => {
  assert.equal(parseSkillPackageBundle("{\"foo\":1}"), null);
  assert.equal(parseSkillPackageBundle("不是 json"), null);
});

test("导入是先预览再确认，不是选完就落库", () => {
  // 包里可能带认不出的字段或被忽略的脚本，这些要先摆到作者面前。
  assert.match(dialogSource, /previewSkillPackage/);
  assert.match(dialogSource, /importSkillPackage/);
  assert.match(dialogSource, /disabled=\{!preview/, "没预览过不能直接导入");
});

test("预览里逐项展示认不出的字段与告警", () => {
  assert.match(dialogSource, /unknownFields/);
  assert.match(dialogSource, /preview\.warnings\.map/);
  assert.match(dialogSource, /不会执行/, "包里带脚本要明说不执行");
});

test("写法列表上有导入入口和逐条导出", () => {
  assert.match(landingSource, /onOpenSkillPackageImport/);
  assert.match(landingSource, /导入写法包/);
  assert.match(landingSource, /onExportProfile/);
  assert.match(profileActionsSource, /导出写法包/);
});

test("页面把导入导出接到了真接口上", () => {
  assert.match(pageSource, /exportSkillPackage/);
  assert.match(pageSource, /SkillPackageImportDialog/);
  assert.match(pageSource, /refreshStyleData\(\)/);
});

test("导入进来的写法在列表里能认出来源", () => {
  // 作者得分得清哪条是别人给的、哪条是自己炼的。
  assert.match(sharedSource, /imported_skill/);
  assert.match(sharedSource, /写法包导入/);
});

test("停用自动命中用取值域内的状态，且文案说清影响范围", () => {
  // status 只 gate 自动命中与推荐；说成"禁用这套写法"会让作者以为手动绑定也没了。
  assert.match(pageSource, /status: input\.enabled \? "active" : "archived"/);
  assert.match(pageSource, /手动绑定不受影响/);
  assert.match(profileActionsSource, /停用自动命中/);
});

test("没声明环节的写法不给自动命中开关", () => {
  // 它本来就不会被自动带进来，给个开关只会让人以为关掉了什么。
  assert.match(profileActionsSource, /applicableTasks\.length > 0 \?/);
});
