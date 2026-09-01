import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  resolveSkillPackageRoot,
  toSkillPackageFiles,
} from "../src/pages/writingFormula/skillPackageFiles.ts";
import {
  buildSkillPackageDownload,
  buildSkillPackageZip,
  readSkillPackageZip,
} from "../src/pages/writingFormula/skillPackageZip.ts";

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

test("导出的是 ZIP，解开就是一个同构的写法包目录", async () => {
  // 计划要的是可携带的目录形态：解开能直接交给按目录消费 Skill 的工具。
  const files = [
    { path: "SKILL.md", content: "# 正文" },
    { path: "examples/1.md", content: "例子" },
  ];
  const download = buildSkillPackageDownload(files, "慢热恋爱");

  assert.equal(download.fileName, "慢热恋爱.zip");
  assert.equal(download.mimeType, "application/zip");

  const restored = await readSkillPackageZip(download.bytes);
  assert.deepEqual(restored.map((file) => file.path), [
    "慢热恋爱/SKILL.md",
    "慢热恋爱/examples/1.md",
  ]);
  // 剥掉包根后就是原样，来回一趟不丢东西。
  assert.deepEqual(toSkillPackageFiles(restored), files);
});

test("只有一个文件时也导出 ZIP，不会都叫 SKILL.md", async () => {
  // 早先按「只有 SKILL.md 就直接导出 SKILL.md」处理，结果每条写法下载下来
  // 都是同一个文件名，在下载文件夹里互相覆盖。
  const a = buildSkillPackageDownload([{ path: "SKILL.md", content: "甲" }], "写法甲");
  const b = buildSkillPackageDownload([{ path: "SKILL.md", content: "乙" }], "写法乙");
  assert.notEqual(a.fileName, b.fileName);
  assert.match(a.fileName, /\.zip$/);
});

test("导出的字节是合法 ZIP：签名、CRC、中央目录都对得上", async () => {
  // 自己拼的 ZIP，别人的解压工具认不认全看这几处。用手算的 CRC 对照，
  // 而不是拿自己的读取函数自证。
  const bytes = buildSkillPackageZip([{ path: "SKILL.md", content: "abc" }], "pkg");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  assert.equal(view.getUint32(0, true), 0x04034b50, "本地文件头签名");
  // "abc" 的 CRC32 是 0x352441c2（标准值）。
  assert.equal(view.getUint32(14, true), 0x352441c2, "CRC32 算错了别人就解不开");
  // 末 22 字节是 EOCD，条目数应为 1。
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50, "EOCD 签名");
  assert.equal(view.getUint16(bytes.length - 22 + 10, true), 1, "条目数");
  // 中文路径要置 UTF-8 标志位，否则解压出来是乱码。
  assert.equal(view.getUint16(6, true) & 0x0800, 0x0800, "UTF-8 标志位");
});

test("不是 ZIP 的内容返回 null，交给目录路径处理", async () => {
  assert.equal(await readSkillPackageZip(new TextEncoder().encode("不是 zip")), null);
  assert.equal(await readSkillPackageZip(new Uint8Array(4)), null);
});

test("导出文件名里的路径分隔符被换掉", () => {
  const download = buildSkillPackageDownload([{ path: "SKILL.md", content: "a" }], "都市/异能");
  assert.ok(!download.fileName.includes("/"), download.fileName);
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
  assert.match(pageSource, /download\.bytes/, "导出走的是字节流，不是自有的文本格式");
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
