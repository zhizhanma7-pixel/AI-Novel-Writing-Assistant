const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SillyTavernCardImportService,
} = require("../dist/services/sillytavern/SillyTavernCardImportService.js");

const service = new SillyTavernCardImportService();

function card(data) {
  return { spec: "chara_card_v2", spec_version: "2.0", data: { name: "沈砚", ...data } };
}

function segmentsByField(plan, field) {
  return plan.segments.filter((segment) => segment.sourceField === field);
}

test("writing instructions go to style without asking the user", () => {
  const plan = service.plan(card({
    system_prompt: "用冷硬的短句写，不要抒情。",
    post_history_instructions: "保持第三人称。",
  }));

  for (const field of ["system_prompt", "post_history_instructions"]) {
    const [segment] = segmentsByField(plan, field);
    assert.equal(segment.suggestedDestination, "style");
    assert.equal(segment.origin, "deterministic", `${field} 的归属没有歧义`);
  }
});

test("greeting and dialogue samples are treated as tone references", () => {
  const plan = service.plan(card({
    first_mes: "「你不该来。」",
    mes_example: "<START>\\n{{char}}: 不重要。",
  }));

  for (const field of ["first_mes", "mes_example"]) {
    const [segment] = segmentsByField(plan, field);
    assert.equal(segment.suggestedDestination, "style");
    assert.equal(segment.origin, "deterministic");
  }
});

test("personality is a fact about this character", () => {
  const plan = service.plan(card({ personality: "沉默，护短" }));

  const [segment] = segmentsByField(plan, "personality");
  assert.equal(segment.suggestedDestination, "character");
  assert.equal(segment.origin, "deterministic");
});

test("description and scenario are flagged for review instead of being guessed", () => {
  // 这两个字段是作者最常塞世界观的地方，也是导错代价最大的地方：
  // 世界设定进了角色，世界观就只在这个角色身上生效。
  const plan = service.plan(card({
    description: "北境十三城的旧律仍由影卫执行。",
    scenario: "城内宵禁的第三夜。",
  }));

  for (const field of ["description", "scenario"]) {
    const [segment] = segmentsByField(plan, field);
    assert.equal(segment.origin, "needs_review", `${field} 必须交给用户判断`);
    assert.ok(segment.reason.length > 0);
  }
  assert.equal(plan.needsReviewCount, 2);
});

test("a long description is split by paragraph so each part can go its own way", () => {
  const plan = service.plan(card({
    description: "北境十三城的旧律仍由影卫执行。\n\n沈砚十七岁入影卫，左手有旧伤。",
  }));

  const segments = segmentsByField(plan, "description");
  assert.equal(segments.length, 2, "整块二选一会逼用户把世界观和角色事实一起归到同一边");
  assert.deepEqual(segments.map((item) => item.id), ["description:0", "description:1"]);
  assert.ok(segments[0].sourceLabel.includes("第 1 段"));
});

test("an embedded character book is surfaced as world material", () => {
  const plan = service.plan(card({
    description: "描述",
    character_book: {
      name: "北境设定",
      entries: [{ keys: ["影卫"], content: "影卫直属城主。", enabled: true, insertion_order: 0 }],
    },
  }));

  // 内嵌世界书的归属是确定的，不参与分流，但要让用户看到卡片带了多少世界观。
  assert.equal(plan.embeddedBook.includedCount, 1);
  assert.ok(plan.embeddedBook.content.includes("影卫直属城主"));
});

test("a card without an embedded book reports none", () => {
  const plan = service.plan(card({ personality: "沉默" }));

  assert.equal(plan.embeddedBook, null);
});

test("empty fields produce no segments", () => {
  const plan = service.plan(card({ description: "   ", personality: "" }));

  assert.deepEqual(plan.segments, []);
  assert.equal(plan.needsReviewCount, 0);
});

test("parse warnings are carried into the plan", () => {
  const plan = service.plan({ spec: "chara_card_v9", spec_version: "9.0", data: { name: "未来卡" } });

  assert.ok(plan.warnings.some((item) => item.code === "unknown_spec_version"));
});
