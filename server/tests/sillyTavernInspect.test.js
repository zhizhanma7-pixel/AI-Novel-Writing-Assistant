const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SillyTavernInspectService,
} = require("../dist/services/sillytavern/SillyTavernInspectService.js");
const {
  SillyTavernParseError,
} = require("../dist/services/sillytavern/sillyTavernCardParser.js");

const service = new SillyTavernInspectService();

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

function buildPng(keyword, payload) {
  const text = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("tEXt", Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a V2 card is recognised by its spec marker", () => {
  const result = service.inspectJson({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: "沈砚", description: "北境旧律" },
  });

  assert.equal(result.kind, "character_card");
  assert.ok(result.cardPlan);
  assert.ok(result.detectedBy.includes("chara_card_v2"), "识别依据要能让用户判断我们认对了没有");
  assert.equal(result.presetPreview, null);
  assert.equal(result.worldBookPreview, null);
});

test("a preset is recognised by its instruction fragments", () => {
  const result = service.inspectJson({
    name: "北境写作",
    prompts: [{ identifier: "main", content: "用冷硬的短句写。", enabled: true }],
  });

  assert.equal(result.kind, "preset");
  assert.ok(result.presetPreview);
  assert.equal(result.presetPreview.enabledCount, 1);
});

test("a text completion preset is recognised by its sampling parameters alone", () => {
  const result = service.inspectJson({ temp: 0.7, rep_pen: 1.1 });

  assert.equal(result.kind, "preset");
  assert.ok(result.detectedBy.includes("采样参数"));
});

test("a standalone world book is recognised by its top-level entries", () => {
  const result = service.inspectJson({
    name: "北境设定",
    entries: { "0": { keys: ["影卫"], content: "影卫直属城主。", enabled: true } },
  });

  assert.equal(result.kind, "world_book");
  assert.equal(result.worldBookPreview.includedCount, 1);
});

test("a card carrying an embedded book is still a card, not a world book", () => {
  // 内嵌世界书在 data.character_book 里，不是顶层 entries——不能误判。
  const result = service.inspectJson({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "沈砚",
      description: "描述",
      character_book: { entries: [{ keys: ["影卫"], content: "内容", enabled: true }] },
    },
  });

  assert.equal(result.kind, "character_card");
  assert.equal(result.cardPlan.embeddedBook.includedCount, 1);
});

test("a legacy flat card is recognised by its field combination", () => {
  const result = service.inspectJson({ name: "旧卡", description: "扁平布局", personality: "直接" });

  assert.equal(result.kind, "character_card");
  assert.ok(result.detectedBy.includes("旧版"));
});

test("a PNG is read and reported as coming from the image", () => {
  const png = buildPng("chara", {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: "沈砚", description: "北境旧律" },
  });
  const result = service.inspectPng(png);

  assert.equal(result.kind, "character_card");
  assert.equal(result.extractedFrom, "chara");
  assert.ok(result.detectedBy.includes("图片"));
});

test("an unrelated JSON object is reported as unknown rather than mis-imported", () => {
  const result = service.inspectJson({ hello: "world", count: 3 });

  assert.equal(result.kind, "unknown");
  assert.equal(result.cardPlan, null);
  assert.equal(result.worldBookPreview, null);
  assert.equal(result.presetPreview, null);
});

test("a non-object payload is refused with a readable error", () => {
  assert.throws(
    () => service.inspectJson("just a string"),
    (error) => error instanceof SillyTavernParseError && error.code === "unrecognised_file",
  );
});
