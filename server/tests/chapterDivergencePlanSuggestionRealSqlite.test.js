const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pnpmInvocation, sqliteDatabaseUrl } = require("./helpers/processInvocation.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

function setupTempSqliteDatabase(tempDir) {
  const databasePath = path.join(tempDir, "chapter-divergence-plan-suggestion.db");
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
  const scriptPath = path.join(tempDir, "run-chapter-divergence-plan-suggestion.cjs");
  const script = `
const path = require("node:path");

// 全表快照：不只比行数，也比内容，这样 UPDATE 同样会被抓到
// （比如 hydrate 自愈把工作区写回去，行数不变但 updatedAt 会变）。
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

async function main() {
  const repoRoot = process.cwd();
  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const {
    chapterDivergenceProposalService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "chapterExecution", "application", "ChapterDivergenceProposalService.js"));
  const {
    ChapterDivergencePlanSuggestionService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "chapterExecution", "application", "ChapterDivergencePlanSuggestionService.js"));
  const {
    NovelVolumeService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "volume", "NovelVolumeService.js"));
  const {
    stableDirectorContentHash,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "director", "runtime", "DirectorArtifactLedger.js"));

  try {
    const novel = await prisma.novel.create({ data: { title: "下游建议只读" } });
    const chapter9 = await prisma.chapter.create({
      data: {
        novelId: novel.id,
        order: 9,
        title: "城内",
        content: "主角连夜带队离城。",
        expectation: "主角留城等待接头",
      },
    });
    await prisma.chapter.create({
      data: { novelId: novel.id, order: 10, title: "接头", content: "", expectation: "城内接头" },
    });
    await prisma.chapter.create({
      data: { novelId: novel.id, order: 11, title: "追兵", content: "", expectation: "甩开追兵" },
    });

    const volumeService = new NovelVolumeService();
    await volumeService.updateVolumesWithOptions(novel.id, {
      volumes: [{
        sortOrder: 1,
        title: "第一卷",
        chapters: [
          { chapterOrder: 9, title: "城内", summary: "主角留城等待接头", endingState: "主角仍在城内" },
          {
            chapterOrder: 10,
            title: "接头",
            summary: "城内接头",
            purpose: "完成城内接头",
            nextChapterEntryState: "主角从城内获得下一条线索",
          },
          { chapterOrder: 11, title: "追兵", summary: "甩开追兵", purpose: "摆脱追击" },
        ],
      }],
    }, { emitEvent: false, syncPayoffLedger: false });

    const produced = await chapterDivergenceProposalService.createForChapter({
      novelId: novel.id,
      chapterId: chapter9.id,
      chapterOrder: 9,
      taskId: null,
      chapterContentHash: stableDirectorContentHash(chapter9.content),
      obligationContract: {
        mustHitNow: [],
        mustPreserve: [],
        requiredPayoffTouches: [],
        requiredCharacterAppearances: [],
        requiredGoalChanges: [],
        canDefer: [],
        forbiddenCrossings: [],
      },
      boundaryContract: {
        exclusiveEvent: "城内接头",
        entryState: "主角在城内待命",
        endingState: "主角仍在城内",
        nextChapterEntryState: "章末主角留在城内等待接头",
        doNotCross: [],
        protectedReveals: [],
      },
      divergences: [{
        kind: "next_entry_state_changed",
        summary: "计划要求章末留城，正文写成离城。",
        expected: "章末主角留在城内等待接头",
        actual: "主角连夜带队离城。",
        evidence: "正文明确写出主角离城。",
        references: {
          affectedCharacterContractEntries: [],
          affectedPayoffContractEntries: [],
          touchedProtectedReveals: [],
          contractQuotes: ["章末主角留在城内等待接头"],
        },
      }],
    });

    const proposal = produced.proposal;
    const item = proposal.changes[0];

    let promptInput = null;
    const service = new ChapterDivergencePlanSuggestionService({
      suggestionPort: {
        async suggest(input) {
          promptInput = input;
          return {
            suggestions: [
              { chapterOrder: 10, purpose: "改到城外接应", reason: "主角已离城。" },
              { chapterOrder: 9, purpose: "回头改本章", reason: "越界的建议，应被清掉。" },
              { chapterOrder: 44, purpose: "不存在的章", reason: "编造的章节，应被清掉。" },
            ],
          };
        },
      },
    });

    const before = await snapshotDatabase(prisma);
    const suggestion = await service.suggest({
      novelId: novel.id,
      proposalId: proposal.id,
      changeId: item.id,
    });
    const after = await snapshotDatabase(prisma);

    // 对照写入：证明这套快照真的看得见改动。少了这一步，「没有表变化」
    // 也可能只是因为快照本身什么都没抓到。
    await prisma.novel.update({ where: { id: novel.id }, data: { title: "对照写入" } });
    const control = await snapshotDatabase(prisma);

    console.log(JSON.stringify({
      snapshotTableCount: Object.keys(before).length,
      changedTables: diffSnapshots(before, after),
      controlChangedTables: diffSnapshots(after, control),
      suggestion,
      promptSawChapterOrders: promptInput ? promptInput.availableChapterOrdersJson : null,
      promptSawDownstreamPlans: promptInput ? promptInput.downstreamPlansJson : null,
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
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "chapter-divergence-plan-suggestion-"));
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

test("U5 — generating downstream suggestions writes nothing to the database", () => {
  const result = scenarioResult();

  assert.ok(
    result.snapshotTableCount > 10,
    `the snapshot must actually cover the schema, saw ${result.snapshotTableCount} tables`,
  );
  assert.deepEqual(
    result.controlChangedTables,
    ["Novel"],
    "the control write must show up, otherwise the snapshot proves nothing",
  );

  // 这是本阶段最关键的一条：建议一旦开始写库，它就变成了一条绕过审批的
  // AI 写状态路径，而整个 2C.7 的设计前提就是它不写。
  assert.deepEqual(
    result.changedTables,
    [],
    "suggestion generation must not touch any table",
  );
});

test("U5b — suggestions are sanitized and the model only sees downstream chapters", () => {
  const result = scenarioResult();

  assert.deepEqual(result.suggestion.suggestions, [{
    patch: { chapterOrder: 10, purpose: "改到城外接应" },
    reason: "主角已离城。",
    chapterTitle: "接头",
  }]);
  assert.deepEqual(
    result.suggestion.discarded.map((item) => item.chapterOrder),
    [9, 44],
    "the current chapter and an invented chapter must both be reported as discarded",
  );

  assert.deepEqual(
    JSON.parse(result.promptSawChapterOrders),
    [10, 11],
    "the model must only be offered chapters after the diverging one",
  );
  assert.equal(
    result.promptSawDownstreamPlans.includes("城内接头"),
    true,
    "the model needs the existing downstream plan to judge what to change",
  );
});
