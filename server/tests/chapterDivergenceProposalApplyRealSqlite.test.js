const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pnpmInvocation, sqliteDatabaseUrl } = require("./helpers/processInvocation.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

function setupTempSqliteDatabase(tempDir) {
  const databasePath = path.join(tempDir, "chapter-divergence-proposal-apply.db");
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
  const scriptPath = path.join(tempDir, "run-chapter-divergence-proposal-apply.cjs");
  const script = `
const path = require("node:path");

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
    changeProposalApplyService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "application", "ChangeProposalApplyService.js"));
  const {
    NovelVolumeService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "volume", "NovelVolumeService.js"));
  const {
    stableDirectorContentHash,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "director", "runtime", "DirectorArtifactLedger.js"));

  try {
    const novel = await prisma.novel.create({ data: { title: "真实偏离组合链" } });
    const chapter9 = await prisma.chapter.create({
      data: {
        novelId: novel.id,
        order: 9,
        title: "城内",
        content: "主角连夜带队离城。",
        expectation: "主角留城等待接头",
        riskFlags: JSON.stringify({ qualityLoop: { keep: "me" } }),
      },
    });
    const chapter10 = await prisma.chapter.create({
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
          {
            chapterOrder: 9,
            title: "城内",
            summary: "主角留城等待接头",
            endingState: "主角仍在城内",
          },
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

    // 真实生产：默认 L1 要求人工确认，non_blocking 只投账本、不改变任务状态。
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

    const pending = produced.proposal;
    const item = pending.changes[0];
    const editedPayload = {
      ...item.payload,
      downstreamPlanPatches: [{
        chapterOrder: 10,
        purpose: "在城外接应，按新的行进路线推进",
        nextChapterEntryState: "主角已在城外，与接应者会合",
      }],
    };

    // 真实审阅：用户选择接受偏离，并补充最终可执行的下游计划 patch。
    const approved = await changeProposalReviewService.approveProposal(novel.id, pending.id, {
      expectedVersion: pending.version,
      itemDecisions: [{
        id: item.id,
        decision: "modified",
        editedPayload,
      }],
    });

    // 真实 apply：经过 staleness、最终 payload 冲突校验、StateCommitService 与正式 applier。
    const executed = await changeProposalApplyService.executeProposal(novel.id, pending.id, {
      authority: "explicit_review",
    });

    const storedEnvelope = await prisma.changeProposal.findUnique({ where: { id: pending.id } });
    const storedItem = await prisma.stateChangeProposal.findUnique({ where: { id: item.id } });
    const refreshedChapter9 = await prisma.chapter.findUnique({ where: { id: chapter9.id } });
    const refreshedDocument = await volumeService.getVolumes(novel.id);
    const refreshedChapter10 = refreshedDocument.volumes[0].chapters.find(
      (chapter) => chapter.chapterOrder === 10,
    );

    console.log(JSON.stringify({
      producedStatus: pending.status,
      approvedStatus: approved.status,
      executedStatus: executed.status,
      storedEnvelopeStatus: storedEnvelope?.status ?? null,
      storedItemStatus: storedItem?.status ?? null,
      storedItemDecision: storedItem?.reviewDecision ?? null,
      storedPayload: storedItem?.userEditedPayloadJson
        ? JSON.parse(storedItem.userEditedPayloadJson)
        : null,
      sourceRefs: storedEnvelope?.sourceRefsJson
        ? JSON.parse(storedEnvelope.sourceRefsJson)
        : [],
      chapter9Content: refreshedChapter9?.content ?? null,
      riskFlags: JSON.parse(refreshedChapter9?.riskFlags || "{}"),
      downstreamPurpose: refreshedChapter10?.purpose ?? null,
      downstreamEntryState: refreshedChapter10?.nextChapterEntryState ?? null,
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
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "chapter-divergence-proposal-apply-"));
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

test("H1 — real divergence producer, review and apply services complete one SQLite envelope", () => {
  const result = runScenario();

  assert.equal(result.producedStatus, "pending_review");
  assert.equal(result.approvedStatus, "approved");
  assert.equal(result.executedStatus, "executed");
  assert.equal(result.storedEnvelopeStatus, "executed");
  assert.equal(result.storedItemStatus, "committed");
  assert.equal(result.storedItemDecision, "modified");
  assert.equal(result.storedPayload.downstreamPlanPatches.length, 1);
  assert.equal(result.sourceRefs.length, 1, "item source refs must be promoted to the envelope");
  assert.equal(result.sourceRefs[0].kind, "chapter");
  assert.equal(result.chapter9Content, "主角连夜带队离城。", "accepting divergence must not rewrite prose");
  assert.equal(result.downstreamPurpose, "在城外接应，按新的行进路线推进");
  assert.equal(result.downstreamEntryState, "主角已在城外，与接应者会合");
  assert.equal(
    Object.values(result.riskFlags.divergenceResolutions)[0].resolution,
    "accepted_divergence",
  );
});
