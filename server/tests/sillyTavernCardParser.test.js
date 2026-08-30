const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseSillyTavernCard,
  parseSillyTavernBook,
  SillyTavernParseError,
} = require("../dist/services/sillytavern/sillyTavernCardParser.js");
const {
  extractSillyTavernCardFromPng,
} = require("../dist/services/sillytavern/sillyTavernPngCard.js");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  // CRC 不参与解析，填零即可。
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

function textChunk(keyword, text) {
  return chunk("tEXt", Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.from([0]),
    Buffer.from(text, "latin1"),
  ]));
}

function buildPng(entries) {
  const parts = [PNG_SIGNATURE];
  for (const [keyword, payload] of entries) {
    parts.push(textChunk(keyword, Buffer.from(JSON.stringify(payload), "utf8").toString("base64")));
  }
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function v2Card(overrides = {}) {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "沈砚",
      description: "北境十三城的旧律法仍由影卫执行。",
      personality: "沉默，护短",
      scenario: "城内宵禁的第三夜",
      first_mes: "「你不该来。」",
      mes_example: "<START>\n{{user}}: 你是谁\n{{char}}: 不重要。",
      creator_notes: "来自某个论坛",
      tags: ["武侠", "悬疑"],
      creator: "someone",
      character_version: "1.2",
      ...overrides,
    },
  };
}

test("P1 — a V2 card is read field by field", () => {
  const parsed = parseSillyTavernCard(v2Card());

  assert.equal(parsed.spec, "v2");
  assert.equal(parsed.specVersion, "2.0");
  assert.equal(parsed.data.name, "沈砚");
  assert.equal(parsed.data.personality, "沉默，护短");
  assert.deepEqual(parsed.data.tags, ["武侠", "悬疑"]);
  assert.deepEqual(parsed.warnings, []);
});

test("P1 — a V3 card is recognised by its own spec string", () => {
  const parsed = parseSillyTavernCard({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: { name: "沈砚", description: "北境旧律" },
  });

  assert.equal(parsed.spec, "v3");
  assert.equal(parsed.specVersion, "3.0");
  assert.deepEqual(parsed.warnings, []);
});

test("P1 — fields the parser does not know are kept, not dropped", () => {
  const parsed = parseSillyTavernCard(v2Card({
    depth_prompt: { prompt: "保持冷淡", depth: 4 },
    extensions: { world: "北境" },
  }));

  // 外部格式会演进，丢字段是不可逆的数据损失。
  assert.deepEqual(parsed.rawImportedMetadata.depth_prompt, { prompt: "保持冷淡", depth: 4 });
  assert.deepEqual(parsed.rawImportedMetadata.extensions, { world: "北境" });
});

test("P1 — the wrapper around data is preserved too", () => {
  const card = v2Card();
  card.create_date = "2026-01-01";
  const parsed = parseSillyTavernCard(card);

  assert.equal(parsed.rawImportedMetadata["__root__.create_date"], "2026-01-01");
});

test("P1 — an embedded character book comes through with the card", () => {
  const parsed = parseSillyTavernCard(v2Card({
    character_book: {
      name: "北境设定",
      entries: [
        { keys: ["影卫"], content: "影卫直属城主，不受旧律约束。", enabled: true, insertion_order: 1 },
        { keys: ["宵禁"], content: "宵禁自戌时起。", constant: true },
      ],
    },
  }));

  // 角色卡携带世界观的主要形式就是这本内嵌世界书。
  assert.equal(parsed.data.character_book.entries.length, 2);
  assert.deepEqual(parsed.data.character_book.entries[0].keys, ["影卫"]);
  assert.equal(parsed.data.character_book.entries[1].constant, true);
});

test("P3 — an unknown spec version degrades and says so", () => {
  const parsed = parseSillyTavernCard({
    spec: "chara_card_v9",
    spec_version: "9.1",
    data: { name: "未来卡", description: "..." },
  });

  assert.equal(parsed.spec, "unknown");
  assert.equal(parsed.specVersion, "9.1");
  assert.equal(parsed.data.name, "未来卡", "已知字段仍应尽力读出");
  const codes = parsed.warnings.map((item) => item.code);
  assert.ok(codes.includes("unknown_spec_version"), "必须明确告知版本不认识");
});

test("P3 — a legacy flat V1 card is read from the top level", () => {
  const parsed = parseSillyTavernCard({
    name: "旧卡",
    description: "扁平布局",
    personality: "直接",
  });

  assert.equal(parsed.spec, "v1");
  assert.equal(parsed.data.description, "扁平布局");
  assert.ok(parsed.warnings.some((item) => item.code === "legacy_v1_layout"));
});

test("P3 — a card with no usable content warns instead of importing silently", () => {
  const parsed = parseSillyTavernCard({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "空卡" } });

  assert.ok(parsed.warnings.some((item) => item.code === "empty_content"));
});

test("P3 — a nameless card is flagged for the user to fill in", () => {
  const parsed = parseSillyTavernCard(v2Card({ name: "" }));

  assert.ok(parsed.warnings.some((item) => item.code === "missing_required_field"));
});

test("a non-object payload is refused with a readable error", () => {
  assert.throws(
    () => parseSillyTavernCard("just a string"),
    (error) => error instanceof SillyTavernParseError && error.code === "invalid_card",
  );
});

test("a standalone lorebook keyed by index is read in order", () => {
  // 独立导出的世界书里 entries 是对象 map，不是数组——最常见的一类文件。
  const parsed = parseSillyTavernBook({
    name: "北境设定",
    entries: {
      "1": { keys: ["宵禁"], content: "第二条" },
      "0": { keys: ["影卫"], content: "第一条" },
      "2": { keys: ["渡口"], content: "第三条" },
    },
  });

  assert.deepEqual(
    parsed.book.entries.map((entry) => entry.content),
    ["第一条", "第二条", "第三条"],
  );
});

test("a lorebook with array entries works the same way", () => {
  const parsed = parseSillyTavernBook({
    entries: [{ keys: ["影卫"], content: "数组形态" }],
  });

  assert.equal(parsed.book.entries[0].content, "数组形态");
});

test("one broken entry does not take the whole lorebook down", () => {
  const parsed = parseSillyTavernBook({
    entries: { "0": { keys: ["好的"], content: "有效" }, "1": "这不是一个条目对象" },
  });

  assert.equal(parsed.book.entries.length, 1);
  assert.ok(parsed.warnings.some((item) => item.code === "dropped_unparsable_entry"));
});

test("P2 — a V2 PNG card yields its embedded JSON", () => {
  const png = buildPng([["chara", v2Card()]]);
  const extracted = extractSillyTavernCardFromPng(png);

  assert.equal(extracted.keyword, "chara");
  assert.equal(parseSillyTavernCard(extracted.json).data.name, "沈砚");
});

test("P2 — when both keywords are present the V3 payload wins", () => {
  const png = buildPng([
    ["chara", v2Card({ name: "旧的" })],
    ["ccv3", { spec: "chara_card_v3", spec_version: "3.0", data: { name: "新的" } }],
  ]);
  const extracted = extractSillyTavernCardFromPng(png);

  assert.equal(extracted.keyword, "ccv3");
  assert.equal(parseSillyTavernCard(extracted.json).data.name, "新的");
});

test("P2 — a plain image says so instead of failing obscurely", () => {
  const png = Buffer.concat([PNG_SIGNATURE, chunk("IEND", Buffer.alloc(0))]);

  assert.throws(
    () => extractSillyTavernCardFromPng(png),
    (error) => error instanceof SillyTavernParseError && error.code === "no_card_metadata",
  );
});

test("P2 — a file that is not a PNG is rejected up front", () => {
  assert.throws(
    () => extractSillyTavernCardFromPng(Buffer.from("not a png at all")),
    (error) => error instanceof SillyTavernParseError && error.code === "not_png",
  );
});

test("P2 — a truncated PNG is reported as damaged, not parsed as far as it goes", () => {
  const png = buildPng([["chara", v2Card()]]);
  // 砍掉尾部，让某个 chunk 的长度字段指向缓冲区之外。
  const truncated = png.subarray(0, png.length - 20);

  assert.throws(
    () => extractSillyTavernCardFromPng(truncated),
    (error) => error instanceof SillyTavernParseError && error.code === "broken_png",
  );
});

test("P2 — a chunk that is not base64 JSON is reported as broken metadata", () => {
  const png = Buffer.concat([
    PNG_SIGNATURE,
    textChunk("chara", "这不是 base64"),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  assert.throws(
    () => extractSillyTavernCardFromPng(png),
    (error) => error instanceof SillyTavernParseError && error.code === "broken_png_metadata",
  );
});
