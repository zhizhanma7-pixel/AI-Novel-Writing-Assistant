const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pnpmInvocation, sqliteDatabaseUrl } = require("./helpers/processInvocation.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

function setupTempSqliteDatabase(tempDir) {
  const databasePath = path.join(tempDir, "sillytavern-card-import.db");
  const databaseUrl = sqliteDatabaseUrl(serverRoot, databasePath);
  const invocation = pnpmInvocation(["--filter", "@ai-novel/server", "prisma:push"]);
  childProcess.execFileSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ...(process.platform === "win32" ? { RUST_LOG: "info" } : {}),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return databaseUrl;
}

function writeScenario(tempDir) {
  const scriptPath = path.join(tempDir, "run-sillytavern-card-import.cjs");
  const script = `
const path = require("node:path");

async function snapshotDatabase(prisma) {
  const tables = await prisma.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%' ORDER BY name"
  );
  const snapshot = {};
  for (const row of tables) {
    const rows = await prisma.$queryRawUnsafe('SELECT * FROM "' + row.name + '"');
    snapshot[row.name] = JSON.stringify(
      rows,
      (key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
  }
  return snapshot;
}

function diffSnapshots(before, after) {
  const changed = [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) {
    if (before[name] !== after[name]) {
      changed.push(name);
    }
  }
  return changed.sort();
}

const CARD = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "沈砚",
    description: "北境十三城的旧律仍由影卫执行。\\n\\n沈砚十七岁入影卫，左手有旧伤。",
    personality: "沉默，护短",
    scenario: "城内宵禁的第三夜。",
    system_prompt: "用冷硬的短句写，不要抒情。",
    first_mes: "「你不该来。」",
    character_book: {
      name: "北境设定",
      entries: [{ keys: ["影卫"], content: "影卫直属城主，不受旧律约束。", enabled: true, insertion_order: 0 }],
    },
  },
};

async function expectRejection(run) {
  try {
    await run();
    return { rejected: false, code: null };
  } catch (error) {
    return { rejected: true, code: error && error.code ? error.code : null };
  }
}

async function main() {
  const repoRoot = process.cwd();
  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const {
    SillyTavernCardImportService,
  } = require(path.join(repoRoot, "server", "dist", "services", "sillytavern", "SillyTavernCardImportService.js"));
  const {
    StyleProfileService,
  } = require(path.join(repoRoot, "server", "dist", "services", "styleEngine", "StyleProfileService.js"));

  try {
    const service = new SillyTavernCardImportService();
    const novel = await prisma.novel.create({ data: { title: "导入目标书" } });

    // 首次创建写法资产会补齐风格引擎的种子数据（模板与反 AI 规则）。
    // 先用一个无关的资产把它触发掉，后面的表差异才只反映导入本身。
    await new StyleProfileService().createManualProfile({ name: "预热种子" });

    // 规划必须是纯读。
    const beforePlan = await snapshotDatabase(prisma);
    const plan = service.plan(CARD);
    const afterPlan = await snapshotDatabase(prisma);

    // 需要判断的段落没表态 → 必须拒绝，不能按默认值悄悄落地。
    const undecided = await expectRejection(() => service.apply({
      rawJson: CARD,
      decisions: [],
      novelId: novel.id,
    }));

    // 不属于这张卡的段落 id → 拒绝。
    const unknownSegment = await expectRejection(() => service.apply({
      rawJson: CARD,
      decisions: [{ segmentId: "not-a-real-segment", destination: "world" }],
      novelId: novel.id,
    }));

    // 有内容要进角色，却没说进哪本书 → 拒绝。
    const missingNovel = await expectRejection(() => service.apply({
      rawJson: CARD,
      decisions: [
        { segmentId: "description:0", destination: "world" },
        { segmentId: "description:1", destination: "character" },
        { segmentId: "scenario:0", destination: "world" },
      ],
    }));

    const beforeApply = await snapshotDatabase(prisma);
    const applied = await service.apply({
      rawJson: CARD,
      decisions: [
        // 第一段是世界设定，第二段才是这个角色的事实——这正是分流要解决的情况。
        { segmentId: "description:0", destination: "world" },
        { segmentId: "description:1", destination: "character" },
        { segmentId: "scenario:0", destination: "skip" },
      ],
      novelId: novel.id,
    });
    const afterApply = await snapshotDatabase(prisma);

    const knowledge = applied.knowledgeDocumentId
      ? await prisma.knowledgeDocument.findUnique({
        where: { id: applied.knowledgeDocumentId },
        include: { activeVersion: true },
      })
      : null;
    const style = applied.styleProfileId
      ? await prisma.styleProfile.findUnique({ where: { id: applied.styleProfileId } })
      : null;
    const character = applied.characterId
      ? await prisma.character.findUnique({ where: { id: applied.characterId } })
      : null;

    console.log(JSON.stringify({
      planChangedTables: diffSnapshots(beforePlan, afterPlan),
      planSegmentIds: plan.segments.map((item) => item.id),
      planNeedsReview: plan.needsReviewCount,
      undecided,
      unknownSegment,
      missingNovel,
      applyChangedTables: diffSnapshots(beforeApply, afterApply),
      applied,
      knowledgeContent: knowledge ? knowledge.activeVersion.content : null,
      styleSummary: style ? JSON.parse(style.narrativeRulesJson || "{}").summary : null,
      styleSourceType: style ? style.sourceType : null,
      characterName: character ? character.name : null,
      characterPersonality: character ? character.personality : null,
      characterBackground: character ? character.background : null,
      characterNovelId: character ? character.novelId : null,
      novelId: novel.id,
    }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

function runScenario() {
  const tempRoot = path.resolve(serverRoot, ".tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "sillytavern-card-import-"));
  const resolvedTempDir = path.resolve(tempDir);
  if (!resolvedTempDir.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`Unsafe temp directory: ${resolvedTempDir}`);
  }
  try {
    const databaseUrl = setupTempSqliteDatabase(resolvedTempDir);
    const scriptPath = writeScenario(resolvedTempDir);
    const stdout = childProcess.execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const resultLine = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse()
      .find((line) => line.startsWith("{"));
    if (!resultLine) {
      throw new Error(`Scenario did not return JSON. stdout=${stdout}`);
    }
    return JSON.parse(resultLine);
  } finally {
    fs.rmSync(resolvedTempDir, { recursive: true, force: true });
  }
}

let cachedResult = null;

function scenarioResult() {
  cachedResult ??= runScenario();
  return cachedResult;
}

test("P8 — planning a card writes nothing to the database", () => {
  const result = scenarioResult();

  // 规划一旦开始写库，用户就在还没确认去向时被替他决定了。
  assert.deepEqual(result.planChangedTables, [], "规划阶段必须是纯读");
  assert.equal(result.planNeedsReview, 3, "description 两段与 scenario 都要人判断");
});

test("a card is refused until every ambiguous segment has been decided", () => {
  const result = scenarioResult();

  assert.equal(result.undecided.rejected, true);
  assert.equal(result.undecided.code, "decision_required");
});

test("a segment id that is not part of this card is refused", () => {
  const result = scenarioResult();

  assert.equal(result.unknownSegment.rejected, true);
  assert.equal(result.unknownSegment.code, "unknown_segment");
});

test("content bound for a character requires knowing which book it belongs to", () => {
  const result = scenarioResult();

  // 角色必须归属一本书；世界设定与文风则是全局可复用的。
  assert.equal(result.missingNovel.rejected, true);
  assert.equal(result.missingNovel.code, "novel_required");
});

test("one card splits three ways according to the decisions", () => {
  const result = scenarioResult();

  assert.deepEqual(result.applied.appliedCounts, {
    world: 1,
    style: 2,
    character: 2,
    skipped: 1,
  });

  // 世界设定：第一段描述 + 卡片内嵌的世界书。
  assert.ok(result.knowledgeContent.includes("北境十三城的旧律"));
  assert.ok(result.knowledgeContent.includes("影卫直属城主"));
  assert.equal(
    result.knowledgeContent.includes("左手有旧伤"),
    false,
    "被判为角色事实的段落不该进世界设定",
  );

  // 文风：写作指令与开场白。
  assert.equal(result.styleSourceType, "from_sillytavern_preset");
  assert.ok(result.styleSummary.includes("用冷硬的短句写"));
  assert.ok(result.styleSummary.includes("你不该来"));

  // 角色：性格与被判为角色事实的那一段。
  assert.equal(result.characterName, "沈砚");
  assert.equal(result.characterPersonality, "沉默，护短");
  assert.ok(result.characterBackground.includes("左手有旧伤"));
  assert.equal(result.characterNovelId, result.novelId);
});

test("a skipped segment reaches none of the three destinations", () => {
  const result = scenarioResult();

  const everything = [
    result.knowledgeContent ?? "",
    result.styleSummary ?? "",
    result.characterBackground ?? "",
    result.characterPersonality ?? "",
  ].join("\n");
  assert.equal(
    everything.includes("城内宵禁的第三夜"),
    false,
    "选择不导入的段落不能出现在任何一个去处",
  );
});

test("applying touches only the three destination tables", () => {
  const result = scenarioResult();

  // 一次导入不该顺手碰到别的子系统。
  const unexpected = result.applyChangedTables.filter((table) => ![
    "KnowledgeDocument",
    "KnowledgeDocumentVersion",
    "StyleProfile",
    "Character",
    // 知识与角色都会排队重建 RAG 索引，走的是既有队列。
    "RagIndexJob",
  ].includes(table));
  assert.deepEqual(unexpected, [], `意外写入的表：${unexpected.join(", ")}`);
  assert.ok(result.applyChangedTables.includes("KnowledgeDocument"));
  assert.ok(result.applyChangedTables.includes("StyleProfile"));
  assert.ok(result.applyChangedTables.includes("Character"));
});
