const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pnpmInvocation, sqliteDatabaseUrl } = require("./helpers/processInvocation.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

function setupTempSqliteDatabase(tempDir) {
  const databasePath = path.join(tempDir, "chapter-divergence-review-guards.db");
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
  const scriptPath = path.join(tempDir, "run-chapter-divergence-review-guards.cjs");
  const script = `
const path = require("node:path");

async function expectRejection(run) {
  try {
    await run();
    return { rejected: false, code: null, message: null };
  } catch (error) {
    return {
      rejected: true,
      code: error && error.code ? error.code : null,
      message: error && error.message ? error.message : null,
    };
  }
}

async function main() {
  const repoRoot = process.cwd();
  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const {
    chapterDivergenceProposalService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "chapterExecution", "application", "ChapterDivergenceProposalService.js"));
  const {
    ChapterDivergenceCorrectionService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "chapterExecution", "application", "ChapterDivergenceCorrectionService.js"));
  const {
    changeProposalReviewService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "application", "ChangeProposalReviewService.js"));
  const {
    NovelVolumeService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "volume", "NovelVolumeService.js"));

  try {
    const novel = await prisma.novel.create({ data: { title: "偏离审阅护栏" } });
    // 第 5 章真实存在但已经在偏离章之前——用来把「不在下游」和「章节不存在」
    // 两种拒绝理由区分开。
    await prisma.chapter.create({
      data: { novelId: novel.id, order: 5, title: "旧事", content: "已经写完的一章。", expectation: "旧事交代" },
    });
    const chapter9 = await prisma.chapter.create({
      data: {
        novelId: novel.id,
        order: 9,
        title: "城内",
        content: "主角连夜带队离城，并当众承认了自己的身份。",
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
          { chapterOrder: 5, title: "旧事", summary: "旧事交代" },
          { chapterOrder: 9, title: "城内", summary: "主角留城等待接头", endingState: "主角仍在城内" },
          { chapterOrder: 10, title: "接头", summary: "城内接头", purpose: "完成城内接头" },
          { chapterOrder: 11, title: "追兵", summary: "甩开追兵", purpose: "摆脱追击" },
        ],
      }],
    }, { emitEvent: false, syncPayoffLedger: false });

    // 刻意不传 chapterContentHash：修正会改正文，带 hash 的提案会先被 stale
    // 检查挡住，那是另一层保护。这里要单独验证审批层自己的护栏。
    const produced = await chapterDivergenceProposalService.createForChapter({
      novelId: novel.id,
      chapterId: chapter9.id,
      chapterOrder: 9,
      taskId: null,
      chapterContentHash: null,
      obligationContract: {
        mustHitNow: [],
        mustPreserve: ["春桃仍不知道主角的真实身份"],
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
        protectedReveals: ["春桃仍不知道主角的真实身份"],
      },
      divergences: [
        {
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
        },
        {
          kind: "protected_reveal_touched",
          summary: "正文提前揭示了应当保留的身份。",
          expected: "春桃仍不知道主角的真实身份",
          actual: "主角当众承认了自己的身份。",
          evidence: "正文写出主角公开身份。",
          references: {
            affectedCharacterContractEntries: [],
            affectedPayoffContractEntries: [],
            touchedProtectedReveals: ["春桃仍不知道主角的真实身份"],
            contractQuotes: ["春桃仍不知道主角的真实身份"],
          },
        },
      ],
    });

    const proposal = produced.proposal;
    const producedCount = proposal.changes.length;
    const corrected = proposal.changes[0];
    const kept = proposal.changes[1];

    // --- 编辑期边界校验，全部针对第二条（第一条随后要走修正）。
    const basePayload = kept ? kept.payload : {};
    const editWith = (patches) => changeProposalReviewService.editProposedChange(
      novel.id,
      proposal.id,
      kept.id,
      { payload: Object.assign({}, basePayload, { downstreamPlanPatches: patches }) },
    );

    const currentChapter = await expectRejection(() => editWith([{ chapterOrder: 9, purpose: "回头改本章" }]));
    const historicalChapter = await expectRejection(() => editWith([{ chapterOrder: 5, purpose: "改已经写完的章" }]));
    const unknownChapter = await expectRejection(() => editWith([{ chapterOrder: 44, purpose: "编出来的章" }]));
    const duplicateChapter = await expectRejection(() => editWith([
      { chapterOrder: 10, purpose: "第一条" },
      { chapterOrder: 10, purpose: "第二条" },
    ]));

    const storedAfterRejections = await prisma.stateChangeProposal.findUnique({
      where: { id: kept.id },
      select: { userEditedPayloadJson: true },
    });

    // 合法的一条仍然要放行。
    await editWith([{ chapterOrder: 10, purpose: "改到城外接应" }]);

    // --- 「按计划修正」走真实链路，注入一个会成功的修复端口。
    const correctionService = new ChapterDivergenceCorrectionService({
      repairPort: {
        async repairChapter() {
          return { content: "主角留在城内，按原计划等待接头。" };
        },
      },
    });
    const correctionResult = await correctionService.correct({
      novelId: novel.id,
      proposalId: proposal.id,
      changeId: corrected.id,
    });
    const afterCorrection = await prisma.stateChangeProposal.findUnique({
      where: { id: corrected.id },
      select: { reviewDecision: true, status: true },
    });

    // --- 先试显式把已修正的一条批准掉：必须被拒绝，而且提案要保持待审，
    // 否则后面那次「全部批准」就无从验证了。
    const explicitApprove = await expectRejection(() => changeProposalReviewService.approveProposal(
      novel.id,
      proposal.id,
      { itemDecisions: [{ id: corrected.id, decision: "accepted" }], unlistedDecision: "accepted" },
    ));
    const envelopeAfterRefusal = await prisma.changeProposal.findUnique({
      where: { id: proposal.id },
      select: { status: true },
    });

    // --- 再执行「全部批准」。
    const approveError = await expectRejection(() => changeProposalReviewService.approveProposal(
      novel.id,
      proposal.id,
      {},
    ));
    const afterApprove = await prisma.stateChangeProposal.findMany({
      where: { changeProposalId: proposal.id },
      select: { id: true, reviewDecision: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    const envelopeAfterApprove = await prisma.changeProposal.findUnique({
      where: { id: proposal.id },
      select: { status: true },
    });

    const chapterAfter = await prisma.chapter.findUnique({
      where: { id: chapter9.id },
      select: { content: true, riskFlags: true },
    });

    console.log(JSON.stringify({
      producedCount,
      correctedId: corrected.id,
      keptId: kept ? kept.id : null,
      currentChapter,
      historicalChapter,
      unknownChapter,
      duplicateChapter,
      storedAfterRejections,
      correctionStatus: correctionResult.status,
      afterCorrection,
      approveError,
      afterApprove,
      envelopeStatusAfterApprove: envelopeAfterApprove.status,
      explicitApprove,
      envelopeStatusAfterRefusal: envelopeAfterRefusal.status,
      chapterContentAfter: chapterAfter.content,
      riskFlagsAfter: JSON.parse(chapterAfter.riskFlags || "{}"),
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
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "chapter-divergence-review-guards-"));
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

test("G1 — the downstream patch boundary is enforced when the value is saved", () => {
  const result = scenarioResult();

  assert.equal(result.producedCount, 2, "the scenario needs two items to approve independently");

  for (const [label, outcome] of [
    ["the diverging chapter", result.currentChapter],
    ["an earlier chapter", result.historicalChapter],
    ["a chapter that does not exist", result.unknownChapter],
    ["two patches on one chapter", result.duplicateChapter],
  ]) {
    assert.equal(outcome.rejected, true, `${label} must be refused at edit time`);
    assert.equal(outcome.code, "invalid_review", `${label} must be refused as an invalid review`);
  }

  assert.equal(
    result.storedAfterRejections.userEditedPayloadJson,
    null,
    "none of the refused edits may be persisted",
  );
});

test("G2 — approving after a correction keeps that item rejected", () => {
  const result = scenarioResult();

  assert.equal(result.correctionStatus, "corrected");
  assert.equal(result.afterCorrection.reviewDecision, "rejected");
  assert.equal(result.afterCorrection.status, "rejected");
  assert.equal(
    result.chapterContentAfter,
    "主角留在城内，按原计划等待接头。",
    "the correction must have really rewritten the prose",
  );

  // 这是复审的阻塞项：不挡住的话，正文已改回原计划，下游计划却按偏离更新。
  assert.equal(result.approveError.rejected, false, "the rest of the proposal must still be approvable");
  const correctedItem = result.afterApprove.find((item) => item.id === result.correctedId);
  assert.equal(correctedItem.reviewDecision, "rejected", "a corrected item must not flip to accepted");
  assert.equal(correctedItem.status, "rejected");

  const keptItem = result.afterApprove.find((item) => item.id === result.keptId);
  assert.notEqual(keptItem.reviewDecision, "rejected", "the untouched item must still be approved");

  assert.equal(
    result.envelopeStatusAfterApprove,
    "partially_approved",
    "one item stays rejected, so the envelope is partially approved",
  );
});

test("G3 — explicitly approving a corrected item is refused, not silently flipped", () => {
  const result = scenarioResult();

  assert.equal(result.explicitApprove.rejected, true);
  assert.equal(result.explicitApprove.code, "invalid_review");
  assert.equal(
    result.envelopeStatusAfterRefusal,
    "pending_review",
    "a refused review must leave the envelope reviewable",
  );
});
