const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pnpmInvocation, sqliteDatabaseUrl } = require("./helpers/processInvocation.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

// Phase 2C.4 / 口径 4：「接受偏离」只更新下游卷规划，
// 本章原始 Expected 必须逐字保留作审计证据，既有 riskFlags 不得被整段覆盖。

function setupTempSqliteDatabase(tempDir) {
  const databasePath = path.join(tempDir, "chapter-execution-plan.db");
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

function writeScript(tempDir) {
  const scriptPath = path.join(tempDir, "run-chapter-execution-plan.cjs");
  const script = `
const path = require("node:path");

async function main() {
  const repoRoot = process.cwd();
  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const {
    applyChapterExecutionPlanUpdate,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "chapterExecution", "application", "ChapterExecutionPlanApplier.js"));
  const {
    NovelVolumeService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "volume", "NovelVolumeService.js"));

  try {
    const novel = await prisma.novel.create({ data: { title: "Divergence apply" } });
    const chapter9 = await prisma.chapter.create({
      data: {
        novelId: novel.id, order: 9, title: "城内",
        content: "已有正文，必须原样保留。",
        expectation: "主角留城接头",
        riskFlags: JSON.stringify({ qualityLoop: { keep: "me" }, unknownTopLevel: 42 }),
      },
    });
    const chapter10 = await prisma.chapter.create({
      data: {
        novelId: novel.id, order: 10, title: "北上", content: "",
        expectation: "接头后按计划行动",
      },
    });

    const volumeService = new NovelVolumeService();
    await volumeService.updateVolumesWithOptions(novel.id, {
      volumes: [{
        sortOrder: 1,
        title: "第一卷",
        chapters: [
          { chapterOrder: 9, title: "城内", summary: "主角留城接头", endingState: "主角仍在城内" },
          { chapterOrder: 10, title: "北上", summary: "接头后按计划行动", endingState: "接头完成", nextChapterEntryState: "主角仍在城内等待消息" },
        ],
      }],
    }, { emitEvent: false, syncPayoffLedger: false });

    const beforeDoc = await volumeService.getVolumes(novel.id);
    const beforeCh10 = beforeDoc.volumes[0].chapters.find((c) => c.chapterOrder === 10);

    // 关键：payload 必须来自**真实生产者**，不能手写。
    // 复审 H1 正是因为此前手写了一份完整 payload，掩盖了生产者缺 chapterId。
    const {
      ChapterDivergenceProposalService,
    } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "chapterExecution", "application", "ChapterDivergenceProposalService.js"));
    const {
      chapterExecutionPlanUpdatePayloadSchema,
    } = require(path.join(repoRoot, "shared", "dist", "types", "chapterExecutionPlan.js"));

    const obligationContract = {
      mustHitNow: ["主角识破敌方试探"], mustPreserve: [], requiredPayoffTouches: [],
      requiredCharacterAppearances: [], requiredGoalChanges: [], canDefer: [], forbiddenCrossings: [],
    };
    const boundaryContract = {
      exclusiveEvent: "城内接头", entryState: "主角在城内待命", endingState: "主角仍在城内",
      nextChapterEntryState: "章末主角留在城内等待接头", doNotCross: [], protectedReveals: [],
    };

    let capturedChanges = null;
    const producer = new ChapterDivergenceProposalService({
      produce: async (_novelId, produceInput) => {
        capturedChanges = produceInput.changes;
        return { proposal: { id: "envelope-1" }, disposition: "pending_review" };
      },
    });
    await producer.createForChapter({
      novelId: novel.id,
      chapterId: chapter9.id,
      chapterOrder: 9,
      taskId: null,
      divergences: [{
        kind: "next_entry_state_changed",
        summary: "计划要求章末留城，正文写成离城。",
        expected: "章末主角留在城内等待接头",
        actual: "主角连夜带队离城。",
        evidence: null,
        references: {
          affectedCharacterContractEntries: [],
          affectedPayoffContractEntries: [],
          touchedProtectedReveals: [],
          contractQuotes: ["章末主角留在城内等待接头"],
        },
      }],
      obligationContract,
      boundaryContract,
    });

    // 生产者产出的 payload 必须直接通过 applier 的 schema。
    const producedPayload = capturedChanges[0].payload;
    const schemaCheck = chapterExecutionPlanUpdatePayloadSchema.safeParse(producedPayload);

    const proposal = {
      id: "state-proposal-1",
      novelId: novel.id,
      chapterId: chapter9.id,
      sourceType: "chapter_execution",
      sourceStage: "chapter_execution",
      proposalType: "chapter_execution_plan_update",
      riskLevel: "high",
      status: "committed",
      summary: "接受章末离城的偏离。",
      // 用户在审阅时补充下游计划变换；其余字段原样取自生产者输出。
      payload: {
        ...producedPayload,
        downstreamPlanPatches: [{
          chapterOrder: 10,
          purpose: "在城外接应，按新的行进路线推进。",
          nextChapterEntryState: "主角已在城外，与接应者会合",
        }],
      },
      evidence: [],
      validationNotes: [],
    };

    await prisma.$transaction(async (tx) => {
      await applyChapterExecutionPlanUpdate(tx, proposal);
    });

    const afterDoc = await volumeService.getVolumes(novel.id);
    const afterCh9 = afterDoc.volumes[0].chapters.find((c) => c.chapterOrder === 9);
    const afterCh10 = afterDoc.volumes[0].chapters.find((c) => c.chapterOrder === 10);
    const ch9Row = await prisma.chapter.findUnique({ where: { id: chapter9.id } });
    const ch10Row = await prisma.chapter.findUnique({ where: { id: chapter10.id } });

    // --- M2 冷启动：从未 bootstrap / 未 hydrate 的小说开始，
    // 事务内读取必须能自行完成 legacy 兜底与 hydrate，且不在信封事务外持久化。
    const cold = await prisma.novel.create({ data: { title: "Cold start" } });
    const coldCh = await prisma.chapter.create({
      data: {
        novelId: cold.id, order: 1, title: "冷启动章",
        content: "", expectation: "冷启动预期",
      },
    });
    const coldVersionsBefore = await prisma.volumePlanVersion.count({ where: { novelId: cold.id } });
    let coldDocVolumes = null;
    await prisma.$transaction(async (tx) => {
      const doc = await volumeService.readWorkspaceWithinTransaction(tx, cold.id);
      coldDocVolumes = doc.volumes.length;
    });
    const coldVersionsAfter = await prisma.volumePlanVersion.count({ where: { novelId: cold.id } });

    console.log(JSON.stringify({
      coldReadVolumes: coldDocVolumes,
      coldPersistedDuringRead: coldVersionsAfter !== coldVersionsBefore,
      coldChapterId: coldCh.id,
      producedPayloadValid: schemaCheck.success,
      producedPayloadErrors: schemaCheck.success
        ? null
        : schemaCheck.error.issues.map((issue) => issue.path.join(".")),
      producedDivergenceId: producedPayload.divergenceId,
      downstreamPurpose: afterCh10.purpose,
      downstreamEntryState: afterCh10.nextChapterEntryState,
      downstreamPurposeChanged: (beforeCh10.purpose ?? null) !== (afterCh10.purpose ?? null),
      // Chapter 列权威字段必须原样：卷文档只是它的投影
      downstreamSummary: afterCh10.summary,
      currentChapterPlanSummary: afterCh9.summary,
      currentChapterPlanEndingState: afterCh9.endingState,
      chapter9Content: ch9Row.content,
      chapter10Content: ch10Row.content,
      riskFlags: JSON.parse(ch9Row.riskFlags || "{}"),
      activeVersionPresent: Boolean(afterDoc.activeVersionId),
    }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

function runScenario() {
  const tempRoot = path.resolve(serverRoot, ".tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "chapter-execution-plan-"));
  const resolvedTempDir = path.resolve(tempDir);
  if (!resolvedTempDir.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`Unsafe temp directory: ${resolvedTempDir}`);
  }
  try {
    const databaseUrl = setupTempSqliteDatabase(resolvedTempDir);
    const scriptPath = writeScript(resolvedTempDir);
    const stdout = childProcess.execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const jsonLine = stdout
      .split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse()
      .find((line) => line.startsWith("{"));
    if (!jsonLine) {
      throw new Error(`Scenario did not return JSON. tail=${stdout.slice(-2000)}`);
    }
    return JSON.parse(jsonLine);
  } finally {
    fs.rmSync(resolvedTempDir, { recursive: true, force: true });
  }
}

test("T10/T11 — accepting a divergence updates downstream plans and preserves the original Expected", () => {
  const result = runScenario();

  // M2 回归：冷启动（未 bootstrap / 未 hydrate）下事务内读取可用，
  // 且读取过程本身不在信封事务外持久化。
  assert.equal(typeof result.coldReadVolumes, "number");
  assert.equal(
    result.coldPersistedDuringRead,
    false,
    "事务内读取不得自行持久化工作区",
  );

  // H1 回归：真实生产者的 payload 必须直接满足 applier schema。
  assert.equal(
    result.producedPayloadValid,
    true,
    `producer payload rejected by applier schema: ${JSON.stringify(result.producedPayloadErrors)}`,
  );
  assert.match(result.producedDivergenceId, /^ch9:next_entry_state_changed:0$/);

  // T10 下游文档自有字段确实被改
  assert.equal(result.downstreamPurposeChanged, true);
  assert.equal(result.downstreamPurpose, "在城外接应，按新的行进路线推进。");
  assert.equal(result.downstreamEntryState, "主角已在城外，与接应者会合");
  assert.equal(result.activeVersionPresent, true, "must write through the versioned workspace");
  // Chapter 列权威的 summary 不受影响（它由 Chapter.expectation 投影而来）
  assert.equal(result.downstreamSummary, "接头后按计划行动");

  // T10 口径 4：本章原始 Expected 逐字未变
  assert.equal(result.currentChapterPlanSummary, "主角留城接头");
  assert.equal(result.currentChapterPlanEndingState, "主角仍在城内");

  // T11 已有正文不被删改
  assert.equal(result.chapter9Content, "已有正文，必须原样保留。");
  assert.equal(result.chapter10Content, "");

  // riskFlags 只 merge，不整段覆盖
  assert.deepEqual(result.riskFlags.qualityLoop, { keep: "me" });
  assert.equal(result.riskFlags.unknownTopLevel, 42);
  assert.equal(
    result.riskFlags.divergenceResolutions["ch9:next_entry_state_changed:0"].resolution,
    "accepted_divergence",
  );
  assert.equal(
    result.riskFlags.divergenceResolutions["ch9:next_entry_state_changed:0"].expected,
    "章末主角留在城内等待接头",
  );
});
