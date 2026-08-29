const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pnpmInvocation, sqliteDatabaseUrl } = require("./helpers/processInvocation.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

function setupTempSqliteDatabase(tempDir) {
  const databasePath = path.join(tempDir, "chapter-divergence-review-api.db");
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
  const scriptPath = path.join(tempDir, "run-chapter-divergence-review-api.cjs");
  const script = `
const path = require("node:path");
const http = require("node:http");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

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
    chapterDivergenceProposalService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "chapterExecution", "application", "ChapterDivergenceProposalService.js"));
  const {
    changeProposalReviewService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "application", "ChangeProposalReviewService.js"));
  const {
    NovelVolumeService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "volume", "NovelVolumeService.js"));
  const {
    stableDirectorContentHash,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "director", "runtime", "DirectorArtifactLedger.js"));
  const { createApp } = require(path.join(repoRoot, "server", "dist", "app.js"));

  try {
    const novel = await prisma.novel.create({ data: { title: "偏离审阅接口" } });
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
      data: {
        novelId: novel.id,
        order: 10,
        title: "接头",
        content: "",
        expectation: "主角仍在城内，与接头人会合",
      },
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
            summary: "主角仍在城内，与接头人会合",
            purpose: "完成城内接头",
            nextChapterEntryState: "主角从城内获得下一条线索",
          },
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
    const basePayload = item.payload;

    // U2-a：schema 不收的字段。表单边界必须由后端强制，不能只靠前端不渲染。
    const unknownField = await expectRejection(() => changeProposalReviewService.editProposedChange(
      novel.id,
      proposal.id,
      item.id,
      { payload: Object.assign({}, basePayload, {
        downstreamPlanPatches: [{ chapterOrder: 10, summary: "试图改摘要" }],
      }) },
    ));

    // U2-b：只给 chapterOrder，没有任何要改的字段。
    const emptyPatch = await expectRejection(() => changeProposalReviewService.editProposedChange(
      novel.id,
      proposal.id,
      item.id,
      { payload: Object.assign({}, basePayload, {
        downstreamPlanPatches: [{ chapterOrder: 10 }],
      }) },
    ));

    const afterRejections = await prisma.stateChangeProposal.findUnique({
      where: { id: item.id },
      select: { userEditedPayloadJson: true, reviewDecision: true },
    });

    // 合法编辑仍然要放行。
    await changeProposalReviewService.editProposedChange(
      novel.id,
      proposal.id,
      item.id,
      { payload: Object.assign({}, basePayload, {
        downstreamPlanPatches: [{ chapterOrder: 10, purpose: "改到城外接应" }],
      }) },
    );
    const afterValidEdit = await prisma.stateChangeProposal.findUnique({
      where: { id: item.id },
      select: { userEditedPayloadJson: true },
    });

    // U1：修正端点。临时库里没有可用 LLM 设置，修复必然拿不到新正文，
    // 因此这里稳定走 repair_failed —— 正是要锁的口径：它不是 5xx。
    const app = createApp();
    const server = http.createServer(app);
    const port = await listen(server);
    let correctStatus = 0;
    let correctBody = null;
    try {
      const response = await fetch(
        "http://127.0.0.1:" + port + "/api/novels/" + novel.id
          + "/change-proposals/" + proposal.id + "/items/" + item.id + "/correct",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      correctStatus = response.status;
      correctBody = await response.json();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const afterCorrect = await prisma.stateChangeProposal.findUnique({
      where: { id: item.id },
      select: { reviewDecision: true, status: true },
    });
    const chapterAfterCorrect = await prisma.chapter.findUnique({
      where: { id: chapter9.id },
      select: { content: true, riskFlags: true },
    });

    console.log(JSON.stringify({
      unknownField,
      emptyPatch,
      storedAfterRejections: afterRejections,
      storedAfterValidEdit: JSON.parse(afterValidEdit.userEditedPayloadJson),
      correctStatus,
      correctBody,
      itemAfterCorrect: afterCorrect,
      chapterContentAfterCorrect: chapterAfterCorrect.content,
      riskFlagsAfterCorrect: JSON.parse(chapterAfterCorrect.riskFlags || "{}"),
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
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "chapter-divergence-review-api-"));
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

// 两个断言组共用一次场景：建库 + prisma push 很贵，跑两遍没有额外信息。
let cachedResult = null;

function scenarioResult() {
  cachedResult ??= runScenario();
  return cachedResult;
}

test("U2 — the downstream patch shape is enforced when the value is edited, not at apply time", () => {
  const result = scenarioResult();

  assert.equal(result.unknownField.rejected, true, "a field outside the patch schema must be refused");
  assert.equal(result.unknownField.code, "invalid_review");
  assert.equal(result.emptyPatch.rejected, true, "a patch that changes nothing must be refused");
  assert.equal(result.emptyPatch.code, "invalid_review");

  assert.equal(
    result.storedAfterRejections.userEditedPayloadJson,
    null,
    "a refused edit must not be persisted",
  );
  assert.equal(result.storedAfterRejections.reviewDecision, null);

  assert.deepEqual(
    result.storedAfterValidEdit.downstreamPlanPatches,
    [{ chapterOrder: 10, purpose: "改到城外接应" }],
    "a valid patch must still go through",
  );
});

test("U1 — a failed correction is reported as a reviewable outcome, not a server error", () => {
  const result = scenarioResult();

  assert.equal(result.correctStatus, 200, "repair failure is a business outcome, not a 5xx");
  assert.equal(result.correctBody.success, true);
  assert.equal(result.correctBody.data.status, "repair_failed");

  assert.equal(
    result.itemAfterCorrect.reviewDecision,
    null,
    "a failed correction must leave the item reviewable",
  );
  assert.equal(result.itemAfterCorrect.status, "pending_review");
  assert.equal(
    result.chapterContentAfterCorrect,
    "主角连夜带队离城。",
    "a failed correction must not touch the prose",
  );
  assert.ok(
    JSON.stringify(result.riskFlagsAfterCorrect).includes("divergence"),
    "a failed correction must leave an explicit quality debt",
  );
});
