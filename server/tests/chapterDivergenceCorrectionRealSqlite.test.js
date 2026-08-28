const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pnpmInvocation, sqliteDatabaseUrl } = require("./helpers/processInvocation.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

// Phase 2C.5 / 复审 H2：「按计划修正」的 application command。
// 两条路径都要真跑：
//  - 成功：正文保存后才写 corrected_to_expected，逐项记为 rejected（不接受偏离进计划）
//  - 失败：逐项**保持可审阅**（reviewDecision 仍为 null），只落显式质量债

function setupTempSqliteDatabase(tempDir) {
  const databasePath = path.join(tempDir, "divergence-correction.db");
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
  const scriptPath = path.join(tempDir, "run-divergence-correction.cjs");
  const script = `
const path = require("node:path");

async function main() {
  const repoRoot = process.cwd();
  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const {
    ChapterDivergenceCorrectionService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "chapterExecution", "application", "ChapterDivergenceCorrectionService.js"));

  async function seed(label) {
    const novel = await prisma.novel.create({ data: { title: "Correction " + label } });
    const chapter = await prisma.chapter.create({
      data: {
        novelId: novel.id, order: 9, title: "城内",
        content: "主角连夜带队离城。",
        expectation: "主角留城接头",
        riskFlags: JSON.stringify({ qualityLoop: { keep: "me" } }),
      },
    });
    const envelope = await prisma.changeProposal.create({
      data: {
        novelId: novel.id,
        chapterId: chapter.id,
        proposalType: "chapter_execution",
        status: "pending_review",
        version: 1,
        summary: "章末状态与计划不一致。",
        reasoningSummary: "正文让主角离城，计划要求留城。",
        sourceRefsJson: JSON.stringify([]),
        warningsJson: JSON.stringify([]),
      },
    });
    const change = await prisma.stateChangeProposal.create({
      data: {
        novelId: novel.id,
        chapterId: chapter.id,
        changeProposalId: envelope.id,
        sourceType: "chapter_execution",
        proposalType: "chapter_execution_plan_update",
        riskLevel: "high",
        status: "pending_review",
        summary: "章末状态与计划不一致。",
        changePath: "Chapter.9.divergence.next_entry_state_changed.actual",
        operation: "replace",
        category: "plot",
        severity: "major",
        payloadJson: JSON.stringify({
          chapterId: chapter.id,
          chapterOrder: 9,
          divergenceId: "ch9:next_entry_state_changed:0",
          kind: "next_entry_state_changed",
          expected: "章末主角留在城内等待接头",
          actual: "主角连夜带队离城。",
          downstreamPlanPatches: [],
        }),
        evidenceJson: JSON.stringify([]),
        validationNotesJson: JSON.stringify([]),
      },
    });
    return { novel, chapter, envelope, change };
  }

  try {
    // --- 成功路径 ---
    const ok = await seed("ok");
    const okService = new ChapterDivergenceCorrectionService({
      repairPort: {
        repairChapter: async (input) => ({
          content: "主角留在城内，等待接头。（已按计划修正）",
          receivedObligations: input.obligations,
        }),
      },
      stalenessService: { inspect: async () => ({ isStale: false, reasons: [] }) },
    });
    let capturedObligations = null;
    const okServiceWithCapture = new ChapterDivergenceCorrectionService({
      repairPort: {
        repairChapter: async (input) => {
          capturedObligations = input.obligations;
          return { content: "主角留在城内，等待接头。（已按计划修正）" };
        },
      },
      stalenessService: { inspect: async () => ({ isStale: false, reasons: [] }) },
    });
    const okResult = await okServiceWithCapture.correct({
      novelId: ok.novel.id,
      proposalId: ok.envelope.id,
      changeId: ok.change.id,
    });
    const okChapter = await prisma.chapter.findUnique({ where: { id: ok.chapter.id } });
    const okChange = await prisma.stateChangeProposal.findUnique({ where: { id: ok.change.id } });

    // --- 失败路径 ---
    const bad = await seed("fail");
    const failService = new ChapterDivergenceCorrectionService({
      repairPort: {
        repairChapter: async () => { throw new Error("repair model unavailable"); },
      },
      stalenessService: { inspect: async () => ({ isStale: false, reasons: [] }) },
    });
    const failResult = await failService.correct({
      novelId: bad.novel.id,
      proposalId: bad.envelope.id,
      changeId: bad.change.id,
    });
    const failChapter = await prisma.chapter.findUnique({ where: { id: bad.chapter.id } });
    const failChange = await prisma.stateChangeProposal.findUnique({ where: { id: bad.change.id } });

    // --- TOCTOU：修复期间正文被并发改写，必须拒绝提交 ---
    const race = await seed("race");
    const raceService = new ChapterDivergenceCorrectionService({
      repairPort: {
        repairChapter: async () => {
          // 模拟 LLM 跑的这几分钟里，用户手动改了正文。
          await prisma.chapter.update({
            where: { id: race.chapter.id },
            data: { content: "用户在修复期间手动改写的新正文。" },
          });
          return { content: "修复器基于旧正文产出的结果。" };
        },
      },
      stalenessService: { inspect: async () => ({ isStale: false, reasons: [] }) },
    });
    const raceResult = await raceService.correct({
      novelId: race.novel.id,
      proposalId: race.envelope.id,
      changeId: race.change.id,
    });
    const raceChapter = await prisma.chapter.findUnique({ where: { id: race.chapter.id } });
    const raceChange = await prisma.stateChangeProposal.findUnique({ where: { id: race.change.id } });

    // --- TOCTOU：修复期间逐项已被决定 ---
    const decided = await seed("decided");
    const decidedService = new ChapterDivergenceCorrectionService({
      repairPort: {
        repairChapter: async () => {
          await prisma.stateChangeProposal.update({
            where: { id: decided.change.id },
            data: { reviewDecision: "accepted" },
          });
          return { content: "修复结果不应落库。" };
        },
      },
      stalenessService: { inspect: async () => ({ isStale: false, reasons: [] }) },
    });
    const decidedResult = await decidedService.correct({
      novelId: decided.novel.id,
      proposalId: decided.envelope.id,
      changeId: decided.change.id,
    });
    const decidedChapter = await prisma.chapter.findUnique({ where: { id: decided.chapter.id } });

    // --- stale 拒绝 ---
    const staleSeed = await seed("stale");
    const staleService = new ChapterDivergenceCorrectionService({
      repairPort: { repairChapter: async () => ({ content: "不该被调用" }) },
      stalenessService: { inspect: async () => ({ isStale: true, reasons: ["chapter changed"] }) },
    });
    let staleError = null;
    try {
      await staleService.correct({
        novelId: staleSeed.novel.id,
        proposalId: staleSeed.envelope.id,
        changeId: staleSeed.change.id,
      });
    } catch (error) {
      staleError = error.code || error.message;
    }

    console.log(JSON.stringify({
      okStatus: okResult.status,
      okContent: okChapter.content,
      okReviewDecision: okChange.reviewDecision,
      okRiskFlags: JSON.parse(okChapter.riskFlags || "{}"),
      okObligationKinds: (capturedObligations || []).map((o) => o.kind),
      failStatus: failResult.status,
      failContentUnchanged: failChapter.content === "主角连夜带队离城。",
      failReviewDecision: failChange.reviewDecision,
      failRiskFlags: JSON.parse(failChapter.riskFlags || "{}"),
      staleError,
      raceStatus: raceResult.status,
      raceReason: raceResult.reason,
      raceContent: raceChapter.content,
      raceReviewDecision: raceChange.reviewDecision,
      decidedStatus: decidedResult.status,
      decidedContent: decidedChapter.content,
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
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "divergence-correction-"));
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
      throw new Error(`Scenario did not return JSON. stdout=${stdout}`);
    }
    return JSON.parse(jsonLine);
  } finally {
    fs.rmSync(resolvedTempDir, { recursive: true, force: true });
  }
}

test("H2 — correcting a divergence repairs the chapter and only then records the resolution", () => {
  const result = runScenario();

  // 成功路径
  assert.equal(result.okStatus, "corrected");
  assert.equal(result.okContent, "主角留在城内，等待接头。（已按计划修正）");
  assert.equal(result.okReviewDecision, "rejected", "修正 = 不把偏离接受进计划");
  assert.equal(
    result.okRiskFlags.divergenceResolutions["ch9:next_entry_state_changed:0"].resolution,
    "corrected_to_expected",
  );
  assert.deepEqual(result.okRiskFlags.qualityLoop, { keep: "me" }, "既有质量债不得被覆盖");
  // 复用既有义务码，现有修复 Prompt 无需改动
  assert.deepEqual(result.okObligationKinds, ["must_preserve"]);

  // 失败路径：正文不变、逐项保持可审阅、只落质量债
  assert.equal(result.failStatus, "repair_failed");
  assert.equal(result.failContentUnchanged, true);
  assert.equal(result.failReviewDecision, null, "修复失败时逐项必须保持可审阅");
  assert.equal(result.failRiskFlags.divergenceDebt.length, 1);
  // 与「检测阶段核验不了」是两种状况，必须用不同的稳定码，否则驾驶舱和
  // 后续排查分不清（复审 M1 展开时发现并拆开）。
  assert.equal(
    result.failRiskFlags.divergenceDebt[0].code,
    "divergence_correction_failed",
  );
  assert.match(result.failRiskFlags.divergenceDebt[0].reason, /repair model unavailable/);
  assert.equal(
    result.failRiskFlags.divergenceResolutions,
    undefined,
    "失败不得写成已修正",
  );

  // stale 必须在动正文之前拒绝
  assert.equal(result.staleError, "stale_proposal");

  // TOCTOU：修复跑在事务外，落库前必须重新校验，旧结果不得覆盖新正文
  assert.equal(result.raceStatus, "conflict");
  assert.match(result.raceReason, /content changed/);
  assert.equal(
    result.raceContent,
    "用户在修复期间手动改写的新正文。",
    "并发写入的新正文不得被旧修复结果覆盖",
  );
  assert.equal(result.raceReviewDecision, null, "冲突时逐项必须保持可审阅");

  // 修复期间逐项已被决定，同样拒绝提交
  assert.equal(result.decidedStatus, "conflict");
  assert.equal(result.decidedContent, "主角连夜带队离城。", "正文不得被写入");
});
