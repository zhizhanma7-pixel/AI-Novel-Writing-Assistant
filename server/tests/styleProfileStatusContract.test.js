const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const routeSource = fs.readFileSync(
  path.join(__dirname, "../src/routes/styleEngine.ts"),
  "utf8",
);
const validateSource = fs.readFileSync(
  path.join(__dirname, "../src/middleware/validate.ts"),
  "utf8",
);

function readManualProfileSchema() {
  const start = routeSource.indexOf("const manualProfileSchema = z.object({");
  assert.notEqual(start, -1, "找不到 manualProfileSchema");
  const end = routeSource.indexOf("\n});", start);
  return routeSource.slice(start, end);
}

test("更新写法资产的 body schema 收 status", () => {
  // validate 走的是 zod 默认行为（strip），schema 里没有的键会被静默剥掉。
  // 少了这一行，界面上的「停用自动命中」会返回 200 却什么都没改。
  assert.match(validateSource, /schema\.body\.parse\(req\.body\)/);
  assert.match(readManualProfileSchema(), /status: z\.enum\(\["active", "archived"\]\)/);
});

test("sourceType 枚举认得导入进来的写法", () => {
  // 导入的写法 sourceType 是 imported_skill；枚举里没有它，
  // 作者一编辑就会被 400 挡住，等于导入完就动不了。
  assert.match(readManualProfileSchema(), /"imported_skill"/);
});

test("status 只 gate 自动命中与推荐这两处", () => {
  // 「停用自动命中」的文案是按这个范围写的。哪天有第三处开始读 status，
  // 这条会红，提醒把界面说法一起改掉。
  const serviceDir = path.join(__dirname, "../src/services");
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        const source = fs.readFileSync(full, "utf8");
        // 只看针对 styleProfile 的查询条件，避免把 Promise.allSettled 的 status 算进来。
        if (/styleProfile\.findMany\(\{[^)]*status: "active"/s.test(source)) {
          hits.push(path.relative(serviceDir, full).replace(/\\/g, "/"));
        }
      }
    }
  };
  walk(serviceDir);
  assert.deepEqual(hits.sort(), [
    "skillPackage/SkillMatcherService.ts",
    "styleEngine/StyleRecommendationService.ts",
  ]);
});
