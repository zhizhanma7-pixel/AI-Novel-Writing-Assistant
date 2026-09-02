const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseSillyTavernPreset,
} = require("../dist/services/sillytavern/sillyTavernPresetParser.js");
const {
  SillyTavernParseError,
} = require("../dist/services/sillytavern/sillyTavernCardParser.js");

function chatPreset(overrides = {}) {
  return {
    name: "北境写作",
    temperature: 0.92,
    frequency_penalty: 0.7,
    presence_penalty: 0.4,
    top_p: 1,
    prompts: [
      { identifier: "main", name: "主指令", content: "用冷硬的短句写，不要抒情。", enabled: true },
      { identifier: "style", name: "文风", content: "多用动作推进，少解释。", enabled: true },
      { identifier: "legacy", name: "旧指令", content: "这条已经不用了。", enabled: false },
    ],
    ...overrides,
  };
}

test("a chat completion preset is recognised and its fragments read in file order", () => {
  const parsed = parseSillyTavernPreset(chatPreset());

  assert.equal(parsed.kind, "chat_completion");
  assert.equal(parsed.name, "北境写作");
  assert.deepEqual(parsed.instructions.map((item) => item.identifier), ["main", "style", "legacy"]);
  assert.equal(parsed.instructions[2].enabled, false);
});

test("prompt_order decides both order and whether a fragment is on", () => {
  const parsed = parseSillyTavernPreset(chatPreset({
    prompt_order: [{
      character_id: 100001,
      order: [
        { identifier: "style", enabled: true },
        { identifier: "main", enabled: false },
      ],
    }],
  }));

  // 顺序是作者调出来的，合并时必须保持。
  assert.deepEqual(parsed.instructions.slice(0, 2).map((item) => item.identifier), ["style", "main"]);
  assert.equal(parsed.instructions[1].enabled, false, "prompt_order 里的开关要覆盖片段自身");
});

test("a fragment missing from prompt_order is kept, not dropped", () => {
  const parsed = parseSillyTavernPreset(chatPreset({
    prompt_order: [{ character_id: 1, order: [{ identifier: "main", enabled: true }] }],
  }));

  const identifiers = parsed.instructions.map((item) => item.identifier);
  assert.equal(identifiers[0], "main");
  assert.ok(identifiers.includes("style"), "没被排序提到的片段不能因此消失");
  assert.ok(identifiers.includes("legacy"));
});

test("a fragment disabled in the file stays disabled even if the order enables it", () => {
  const parsed = parseSillyTavernPreset(chatPreset({
    prompt_order: [{ character_id: 1, order: [{ identifier: "legacy", enabled: true }] }],
  }));

  const legacy = parsed.instructions.find((item) => item.identifier === "legacy");
  assert.equal(legacy.enabled, false);
});

test("sampling parameters are collected under both naming families", () => {
  const chat = parseSillyTavernPreset(chatPreset());
  assert.equal(chat.generationParameters.temperature, 0.92);
  assert.equal(chat.generationParameters.frequency_penalty, 0.7);

  const text = parseSillyTavernPreset({ temp: 0.7, rep_pen: 1.1, top_k: 40 });
  assert.equal(text.kind, "text_completion");
  assert.equal(text.generationParameters.temp, 0.7);
  assert.equal(text.generationParameters.rep_pen, 1.1);
});

test("an unrecognised preset degrades with a warning instead of throwing", () => {
  const parsed = parseSillyTavernPreset({ some_future_field: true });

  assert.equal(parsed.kind, "unknown");
  assert.ok(parsed.warnings.some((item) => item.code === "unknown_spec_version"));
});

test("fields the parser does not consume are preserved", () => {
  const parsed = parseSillyTavernPreset(chatPreset({
    chat_completion_source: "openai",
    assistant_prefill: "好的，",
  }));

  assert.equal(parsed.rawImportedMetadata.chat_completion_source, "openai");
  assert.equal(parsed.rawImportedMetadata.assistant_prefill, "好的，");
});

test("a malformed fragment drops itself without taking the preset down", () => {
  const parsed = parseSillyTavernPreset(chatPreset({
    prompts: [{ identifier: "main", content: "有效" }, "这不是一个片段对象"],
  }));

  assert.equal(parsed.instructions.length, 1);
  assert.ok(parsed.warnings.some((item) => item.code === "dropped_unparsable_entry"));
});

test("a preset with no usable instructions says so", () => {
  const parsed = parseSillyTavernPreset({ prompts: [{ identifier: "main", content: "   " }] });

  assert.ok(parsed.warnings.some((item) => item.code === "empty_content"));
});

test("a non-object payload is refused with a readable error", () => {
  assert.throws(
    () => parseSillyTavernPreset([1, 2, 3]),
    (error) => error instanceof SillyTavernParseError && error.code === "invalid_preset",
  );
});
