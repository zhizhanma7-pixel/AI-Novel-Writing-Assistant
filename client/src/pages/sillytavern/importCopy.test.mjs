import assert from "node:assert/strict";
import test from "node:test";
import { sillyTavernSegmentDestinationSchema } from "@ai-novel/shared/types/sillytavernCardSplit";
import {
  ASSET_KIND_COPY,
  DESTINATION_LABEL,
  DESTINATION_OPTIONS,
  isPngFileName,
  resolveImportError,
} from "./importCopy.ts";

function httpError(code) {
  return { details: { error: code } };
}

test("every destination in the contract is offered in the UI", () => {
  // 契约加了新去向而界面没跟上的话，用户就会有一段内容无处可去。
  const contractValues = [...sillyTavernSegmentDestinationSchema.options].sort();
  const offered = DESTINATION_OPTIONS.map((option) => option.value).sort();

  assert.deepEqual(offered, contractValues);
  for (const value of contractValues) {
    assert.ok(DESTINATION_LABEL[value], `${value} 需要一个标签`);
  }
});

test("destination hints explain the cost of getting it wrong", () => {
  // 作者要判断的是「放错了会怎样」，不是「世界设定的定义是什么」。
  const character = DESTINATION_OPTIONS.find((option) => option.value === "character");
  assert.ok(character.hint.includes("只在他身上生效"));
});

test("every asset kind has a label", () => {
  for (const kind of ["character_card", "world_book", "preset", "unknown"]) {
    assert.ok(ASSET_KIND_COPY[kind]);
  }
});

test("stable error codes become Chinese recovery guidance", () => {
  const cases = {
    no_card_metadata: "这张图片里没有角色卡",
    novel_required: "还没选这个角色属于哪本书",
    decision_required: "还有内容没决定去向",
    empty_world_book: "没有可导入的内容",
    not_png: "这不是一张 PNG",
  };

  for (const [code, title] of Object.entries(cases)) {
    assert.equal(resolveImportError(httpError(code)).title, title);
  }
});

test("an unknown code still yields something actionable", () => {
  const copy = resolveImportError(httpError("something_new_from_the_server"));

  assert.equal(copy.title, "导入没有完成");
  assert.ok(copy.description.length > 0);
});

test("a plain error falls back to its own message", () => {
  const copy = resolveImportError(new Error("这个文件不是有效的 JSON。"));

  assert.equal(copy.description, "这个文件不是有效的 JSON。");
});

test("png detection is by extension and tolerates case and spacing", () => {
  assert.equal(isPngFileName("card.png"), true);
  assert.equal(isPngFileName("CARD.PNG"), true);
  assert.equal(isPngFileName("  card.png  "), true);
  assert.equal(isPngFileName("card.json"), false);
  assert.equal(isPngFileName("png.json"), false);
});
