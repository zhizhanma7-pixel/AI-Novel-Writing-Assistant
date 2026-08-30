const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SillyTavernWorldBookImportService,
} = require("../dist/services/sillytavern/SillyTavernWorldBookImportService.js");
const service = new SillyTavernWorldBookImportService();

function book(entries, extra = {}) {
  return { name: "北境设定", entries, ...extra };
}

test("entries become sections and their keywords go into the text", () => {
  const preview = service.preview(book([
    {
      keys: ["影卫", "影卫营"],
      secondary_keys: ["夜巡"],
      content: "影卫直属城主，不受旧律约束。",
      enabled: true,
      insertion_order: 0,
      name: "影卫",
    },
  ]));

  assert.equal(preview.bookName, "北境设定");
  assert.equal(preview.includedCount, 1);
  assert.ok(preview.content.includes("## 影卫"));
  // 关键词进正文，交给既有语义检索命中，而不是另建一套关键词注入。
  assert.ok(preview.content.includes("关键词：影卫、影卫营、夜巡"));
  assert.ok(preview.content.includes("影卫直属城主"));
});

test("a disabled entry stays out of the indexed text but is still counted", () => {
  const preview = service.preview(book([
    { keys: ["影卫"], content: "会被检索到的内容。", enabled: true, insertion_order: 0 },
    { keys: ["废弃"], content: "作者已经关掉这条。", enabled: false, insertion_order: 1 },
  ]));

  assert.equal(preview.includedCount, 1);
  assert.equal(preview.excludedCount, 1);
  assert.equal(
    preview.content.includes("作者已经关掉这条"),
    false,
    "原文件里关掉的条目不能进入检索正文",
  );
  // 但数量要报出来，否则用户不知道有内容被排除了。
  assert.equal(preview.entryCount, 2);
});

test("entries keep the order the author arranged in the original tool", () => {
  const preview = service.preview(book([
    { keys: ["c"], content: "第三", enabled: true, insertion_order: 30 },
    { keys: ["a"], content: "第一", enabled: true, insertion_order: 10 },
    { keys: ["b"], content: "第二", enabled: true, insertion_order: 20 },
  ]));

  const positions = ["第一", "第二", "第三"].map((text) => preview.content.indexOf(text));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});

test("a constant entry is marked so the reader knows it was always-on", () => {
  const preview = service.preview(book([
    { keys: ["宵禁"], content: "宵禁自戌时起。", enabled: true, insertion_order: 0, constant: true },
  ]));

  assert.equal(preview.constantCount, 1);
  assert.ok(preview.content.includes("常驻条目"));
});

test("an entry with no name falls back to its first keyword, then to its position", () => {
  const preview = service.preview(book([
    { keys: ["渡口"], content: "内容一", enabled: true, insertion_order: 0 },
    { keys: [], content: "内容二", enabled: true, insertion_order: 1 },
  ]));

  assert.ok(preview.content.includes("## 渡口"));
  assert.ok(preview.content.includes("## 条目 2"));
});

test("the book description is carried into the document", () => {
  const preview = service.preview(book(
    [{ keys: ["影卫"], content: "内容", enabled: true, insertion_order: 0 }],
    { description: "这本设定描述北境的秩序。" },
  ));

  assert.ok(preview.content.includes("这本设定描述北境的秩序。"));
});

test("an embedded book from a character card renders the same way", () => {
  const preview = service.previewFromCardBook({
    name: "卡片自带设定",
    description: null,
    entries: [{
      keys: ["影卫"],
      secondary_keys: [],
      content: "角色卡里夹带的世界观。",
      enabled: true,
      insertion_order: 0,
      constant: false,
      selective: false,
      name: null,
      comment: null,
      priority: null,
    }],
  });

  assert.equal(preview.includedCount, 1);
  assert.ok(preview.content.includes("角色卡里夹带的世界观。"));
});

test("a card without an embedded book yields nothing rather than an empty document", () => {
  assert.equal(service.previewFromCardBook(null), null);
});

test("a native world info export renders with its keywords and honours disable", () => {
  // 端到端的真实后果：原生字段没被认出时，被关掉的条目会进入检索正文。
  const preview = service.preview({
    name: "北境设定",
    entries: {
      "0": {
        uid: 0,
        key: ["影卫", "影卫营"],
        keysecondary: ["夜巡"],
        comment: "北境影卫",
        content: "影卫直属城主，不受旧律约束。",
        order: 100,
        disable: false,
      },
      "1": {
        uid: 1,
        key: ["废弃设定"],
        content: "作者已经关掉这条。",
        order: 200,
        disable: true,
      },
    },
  });

  assert.equal(preview.includedCount, 1);
  assert.equal(preview.excludedCount, 1);
  assert.ok(preview.content.includes("## 北境影卫"), "条目名取自 comment");
  assert.ok(preview.content.includes("关键词：影卫、影卫营、夜巡"));
  assert.equal(
    preview.content.includes("作者已经关掉这条"),
    false,
    "disable: true 的条目不能进入检索正文",
  );
});

test("native entries are ordered by their order field", () => {
  const preview = service.preview({
    entries: {
      "0": { key: ["c"], content: "第三", order: 300 },
      "1": { key: ["a"], content: "第一", order: 100 },
      "2": { key: ["b"], content: "第二", order: 200 },
    },
  });

  const positions = ["第一", "第二", "第三"].map((text) => preview.content.indexOf(text));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});

test("unknown top-level fields in a world book reach the preview", () => {
  const preview = service.preview({
    name: "北境设定",
    entries: { "0": { key: ["影卫"], content: "影卫直属城主。" } },
    future_book_field: "世界书层面的未来字段",
    another_unknown: 42,
  });

  assert.deepEqual(
    [...preview.unknownFields].sort(),
    ["another_unknown", "future_book_field"],
  );
});

test("a plain world book reports no unknown fields", () => {
  const preview = service.preview(book([
    { keys: ["影卫"], content: "内容", enabled: true, insertion_order: 0 },
  ]));

  assert.deepEqual(preview.unknownFields, []);
});

test("unknown fields inside entries are collected too, not just top-level ones", () => {
  // 真实世界书条目常带 uid / probability / depth 之类。只收集顶层未知字段
  // 会漏掉它们，用户以为全都导进来了。
  const preview = service.preview({
    entries: {
      "0": { key: ["影卫"], content: "内容", uid: 42, probability: 100 },
      "1": { key: ["宵禁"], content: "内容二", depth: 4 },
    },
  });

  assert.deepEqual([...preview.unknownFields].sort(), ["depth", "probability", "uid"]);
});

test("unrecognised content is kept in the document instead of vanishing", () => {
  const preview = service.preview({
    name: "北境设定",
    entries: { "0": { key: ["影卫"], content: "影卫直属城主。", uid: 42, probability: 100 } },
  });

  // 知识文档没有存放原始文件的位置，但让这些内容彻底消失更糟：
  // 附在末尾并明确标注，至少还能回溯。
  assert.ok(preview.content.includes("原始文件中未被识别的内容"));
  assert.ok(preview.content.includes("42"));
  assert.ok(preview.content.includes("100"));
});

test("a book with nothing unrecognised gets no extra section", () => {
  const preview = service.preview(book([
    { keys: ["影卫"], content: "内容", enabled: true, insertion_order: 0 },
  ]));

  // 绝大多数文件不该因此多出一段内容去污染检索。
  assert.equal(preview.content.includes("原始文件中未被识别的内容"), false);
  assert.deepEqual(preview.unknownFields, []);
});
