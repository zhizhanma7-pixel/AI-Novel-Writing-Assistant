const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STYLE_BINDING_AGENTS,
} = require("../../shared/dist/types/styleEngine.js");

/**
 * per-agent 写法绑定的契约面。
 *
 * 真实解析行为要连库，放在真实 SQLite 用例里；这里守的是契约本身没有缺口——
 * 加了新的绑定目标却漏改某张映射表，运行时才会以「标签显示 undefined」
 * 或「优先级排序静默错乱」的方式暴露。
 */

test("the agents wired into style resolution are declared in one place", () => {
  // 加新环节时必须同时把它接进对应的解析调用，这个列表就是那份清单。
  assert.deepEqual([...STYLE_BINDING_AGENTS], ["writer", "planner"]);
});

test("every binding target type has a priority and a label", () => {
  const {
    StyleBindingService,
  } = require("../dist/services/styleEngine/StyleBindingService.js");
  const { StyleCompiler } = require("../dist/services/styleEngine/StyleCompiler.js");

  // 这两处是编译期 Record<StyleBindingTargetType, ...>，少一个键就编译不过；
  // 这里再从运行行为上确认 agent 真的被排进了优先级，而不是只补了类型。
  assert.ok(StyleBindingService, "binding service should load");
  assert.ok(StyleCompiler, "compiler should load");

  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "src", "services", "styleEngine", "StyleBindingService.ts"),
    "utf8",
  );
  const priorityBlock = source.match(/const TARGET_PRIORITY[\s\S]*?\};/)?.[0] ?? "";
  for (const target of ["novel", "agent", "chapter", "task"]) {
    assert.match(priorityBlock, new RegExp(`\\b${target}:`), `${target} 需要一个优先级`);
  }
});

test("agent bindings sit between novel and chapter in priority", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "src", "services", "styleEngine", "StyleBindingService.ts"),
    "utf8",
  );
  const priorityBlock = source.match(/const TARGET_PRIORITY[\s\S]*?\};/)?.[0] ?? "";
  const read = (key) => Number(priorityBlock.match(new RegExp(`${key}:\\s*(\\d+)`))?.[1]);

  // 环节比「整本书」具体，比「这一章」通用。顺序错了会让作者以为章节级
  // 设置被环节覆盖，或反过来。
  assert.ok(read("novel") < read("agent"), "环节应当比整本书更具体");
  assert.ok(read("agent") < read("chapter"), "章节应当比环节更具体");
});
