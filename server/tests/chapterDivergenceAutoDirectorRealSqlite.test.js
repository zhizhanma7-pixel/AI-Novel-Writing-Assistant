const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pnpmInvocation, sqliteDatabaseUrl } = require("./helpers/processInvocation.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

function setupTempSqliteDatabase(tempDir) {
  const databasePath = path.join(tempDir, "chapter-divergence-auto-director.db");
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
  const scriptPath = path.join(tempDir, "run-chapter-divergence-auto-director.cjs");
  const script = `
const path = require("node:path");

const SCORE = {
  coherence: 86,
  pacing: 84,
  repetition: 88,
  engagement: 85,
  voice: 83,
  overall: 85,
};

const OBLIGATION_CONTRACT = {
  mustHitNow: [],
  mustPreserve: [],
  requiredPayoffTouches: [],
  requiredCharacterAppearances: [],
  requiredGoalChanges: [],
  canDefer: [],
  forbiddenCrossings: [],
};

const BOUNDARY_CONTRACT = {
  exclusiveEvent: "城内接头",
  entryState: "主角在城内待命",
  endingState: "主角仍在城内",
  nextChapterEntryState: "章末主角留在城内等待接头",
  doNotCross: [],
  protectedReveals: [],
};

function buildAcceptance(order) {
  const divergences = order === 1
    ? [{
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
      }]
    : [];
  return {
    score: SCORE,
    issues: [],
    auditReports: [],
    assessment: {
      status: "accepted",
      summary: "正文可保存并继续推进。",
      blockingIssues: [],
      repairDirectives: [],
      missingObligations: [],
      divergences,
      repairability: "none",
      decisionReason: "本章正文可用。",
      riskTags: [],
      continuePolicy: "continue",
      score: SCORE,
      assetSyncRecommendation: {
        priority: "normal",
        reason: "无额外同步风险。",
        requiresFullPayoffReconcile: false,
      },
    },
  };
}

async function main() {
  const repoRoot = process.cwd();
  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const {
    NovelDirectorAutoExecutionRuntime,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "director", "automation", "novelDirectorAutoExecutionRuntime.js"));
  const {
    ChapterContentFinalizationService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "runtime", "ChapterContentFinalizationService.js"));

  try {
    const novel = await prisma.novel.create({
      data: { title: "偏离不中断整书" },
    });
    const task = await prisma.novelWorkflowTask.create({
      data: {
        novelId: novel.id,
        lane: "auto_director",
        title: "偏离不中断整书",
        status: "running",
        currentStage: "chapter_execution",
        currentItemKey: "chapter_execution",
        currentItemLabel: "准备自动写作",
        progress: 0.9,
      },
    });

    const sceneCards = JSON.stringify({
      targetWordCount: 1200,
      lengthBudget: {
        targetWordCount: 1200,
        softMinWordCount: 900,
        softMaxWordCount: 1500,
        hardMaxWordCount: 1800,
      },
      scenes: [{
        key: "scene-1",
        title: "推进",
        purpose: "完成本章事件",
        mustAdvance: ["主线"],
        mustPreserve: ["人物动机"],
        entryState: "进入冲突",
        exitState: "形成新局面",
        forbiddenExpansion: [],
        targetWordCount: 1200,
      }],
    });
    await prisma.chapter.createMany({
      data: [1, 2].map((order) => ({
        novelId: novel.id,
        order,
        title: "第" + order + "章",
        content: "",
        expectation: order === 1
          ? "章末主角留在城内等待接头"
          : "主角处理离城后的追兵",
        chapterStatus: "pending_generation",
        generationState: "planned",
        conflictLevel: 5,
        revealLevel: 2,
        targetWordCount: 1200,
        mustAvoid: "不要跳过本章事件",
        taskSheet: JSON.stringify({ objective: "推进本章" }),
        sceneCards,
      })),
    });

    const finalizationService = new ChapterContentFinalizationService({
      qualityGateService: {
        runAcceptanceGate: async (input) => buildAcceptance(input.contextPackage.chapter.order),
      },
      artifactSyncService: { syncChapterArtifacts: async () => ({}) },
      plannerService: { shouldTriggerReplanFromAudit: () => false },
      agentRuntime: { finishChapterGenRun: async () => {} },
      timelineFinalizer: {
        finalizeCurrentContent: async () => ({ checkpointWritten: true }),
      },
      lifecycleService: {
        markChapterStatus: async (chapterId, chapterStatus) => {
          await prisma.chapter.update({
            where: { id: chapterId },
            data: { chapterStatus },
          });
        },
      },
    });

    const transitions = [];
    const taskStatesAfterChapter = [];
    const workflowService = {
      async bootstrapTask(input) {
        await prisma.novelWorkflowTask.update({
          where: { id: input.workflowTaskId },
          data: {
            status: "running",
            seedPayloadJson: JSON.stringify(input.seedPayload || {}),
          },
        });
        transitions.push("bootstrap");
      },
      async getTaskById(taskId) {
        return prisma.novelWorkflowTask.findUnique({
          where: { id: taskId },
          select: { status: true },
        });
      },
      async markTaskRunning(taskId, input) {
        await prisma.novelWorkflowTask.update({
          where: { id: taskId },
          data: {
            status: "running",
            currentStage: input.stage,
            currentItemKey: input.itemKey || null,
            currentItemLabel: input.itemLabel,
            progress: input.progress,
            ...(input.clearCheckpoint
              ? { checkpointType: null, checkpointSummary: null }
              : {}),
          },
        });
        transitions.push("running");
      },
      async recordCheckpoint(taskId, input) {
        await prisma.novelWorkflowTask.update({
          where: { id: taskId },
          data: {
            status: input.checkpointType === "workflow_completed" ? "succeeded" : "waiting_approval",
            currentStage: input.stage,
            currentItemLabel: input.itemLabel,
            progress: input.progress,
            checkpointType: input.checkpointType,
            checkpointSummary: input.checkpointSummary,
            seedPayloadJson: JSON.stringify(input.seedPayload || {}),
          },
        });
        transitions.push("checkpoint:" + input.checkpointType);
      },
      async markTaskFailed(taskId, message) {
        await prisma.novelWorkflowTask.update({
          where: { id: taskId },
          data: { status: "failed", lastError: message },
        });
        transitions.push("failed");
      },
      async requeueTaskForRecovery(taskId) {
        await prisma.novelWorkflowTask.update({
          where: { id: taskId },
          data: { status: "queued", pendingManualRecovery: true },
        });
        transitions.push("requeued");
      },
    };

    const jobs = new Map();
    const startedOrders = [];
    let jobSequence = 0;
    const listChapters = async () => prisma.chapter.findMany({
      where: { novelId: novel.id },
      orderBy: { order: "asc" },
      select: {
        id: true,
        order: true,
        content: true,
        generationState: true,
        chapterStatus: true,
        conflictLevel: true,
        revealLevel: true,
        targetWordCount: true,
        mustAvoid: true,
        taskSheet: true,
        sceneCards: true,
        expectation: true,
      },
    });

    const novelService = {
      async findActivePipelineJobForRange() {
        return null;
      },
      async startPipelineJob(_novelId, options) {
        const order = options.startOrder;
        startedOrders.push(order);
        const chapter = await prisma.chapter.findFirstOrThrow({
          where: { novelId: novel.id, order },
        });
        const content = order === 1
          ? "主角没有等待接头，反而连夜带队离城。"
          : "追兵从山道逼近，主角在城外完成第二章的应对。";
        // 真实章节流水线会先保存可用正文，再进入接收/定稿。
        await prisma.chapter.update({
          where: { id: chapter.id },
          data: { content, generationState: "reviewed", chapterStatus: "generating" },
        });
        const chapterBoundary = order === 1 ? BOUNDARY_CONTRACT : {
          ...BOUNDARY_CONTRACT,
          nextChapterEntryState: "第二章完成后继续推进",
        };
        const bookContract = {
          title: "偏离不中断整书",
          genre: "悬疑",
          targetAudience: "新手读者",
          sellingPoint: "连续追捕",
          first30ChapterPromise: "持续升级追捕压力",
          narrativePov: "limited-third-person",
          pacePreference: "fast",
          emotionIntensity: "high",
          toneGuardrails: [],
          hardConstraints: [],
        };
        const chapterMission = {
          chapterId: chapter.id,
          chapterOrder: order,
          title: chapter.title,
          objective: chapter.expectation,
          expectation: chapter.expectation,
          taskSheet: chapter.taskSheet,
          targetWordCount: chapter.targetWordCount,
          planRole: "progress",
          hookTarget: "留下下一章追捕压力",
          mustAdvance: [chapter.expectation],
          mustPreserve: ["主角行动连续性"],
          riskNotes: [],
        };
        const chapterWriteContext = {
          bookContract,
          productionFoundationPrompt: "",
          macroConstraints: null,
          volumeWindow: null,
          narrativeProgressHint: null,
          chapterMission,
          nextAction: "write_chapter",
          chapterStateGoal: null,
          protectedSecrets: [],
          payoffDirectives: [],
          obligationContract: OBLIGATION_CONTRACT,
          chapterBoundary,
          lengthBudget: null,
          scenePlan: null,
          participants: [],
          characterHardFacts: [],
          characterBehaviorGuides: [],
          activeRelationStages: [],
          pendingCandidateGuards: [],
          localStateSummary: "主角正在推进追捕主线。",
          openConflictSummaries: [],
          ledgerPendingItems: [],
          ledgerUrgentItems: [],
          ledgerOverdueItems: [],
          ledgerSummary: null,
          timelineContext: null,
          characterResourceContext: null,
          recentChapterSummaries: [],
          previousChapterTail: null,
          openingAntiRepeatHint: "避免重复开场。",
          styleContract: null,
          styleConstraints: [],
          continuationConstraints: [],
          ragFacts: [],
          completedMilestones: [],
          recentScenePatterns: [],
        };
        await finalizationService.finalizeChapterContent({
          novelId: novel.id,
          chapterId: chapter.id,
          request: {
            workflowTaskId: task.id,
            provider: "deepseek",
            model: "deepseek-chat",
            temperature: 0.7,
          },
          contextPackage: {
            chapter: {
              id: chapter.id,
              order,
              title: chapter.title,
              content,
              expectation: chapter.expectation,
              targetWordCount: chapter.targetWordCount,
              conflictLevel: chapter.conflictLevel,
              revealLevel: chapter.revealLevel,
              mustAvoid: chapter.mustAvoid,
              taskSheet: chapter.taskSheet,
              sceneCards: chapter.sceneCards,
              supportingContextText: "",
            },
            plan: null,
            canonicalState: null,
            nextAction: "write_chapter",
            chapterStateGoal: null,
            protectedSecrets: [],
            stateSnapshot: null,
            openConflicts: [],
            storyWorldSlice: null,
            characterRoster: [],
            characterHardFacts: [],
            creativeDecisions: [],
            previousChaptersSummary: [],
            previousChapterTail: null,
            openingHint: "避免重复开场。",
            continuation: {
              enabled: false,
              sourceType: null,
              sourceId: null,
              sourceTitle: "",
              systemRule: "",
              humanBlock: "",
              antiCopyCorpus: [],
            },
            styleContext: null,
            characterDynamics: null,
            characterMindStates: [],
            bookContract,
            macroConstraints: null,
            volumeWindow: null,
            narrativeProgressHint: null,
            ledgerPendingItems: [],
            ledgerUrgentItems: [],
            ledgerOverdueItems: [],
            ledgerSummary: null,
            timelineContext: null,
            characterResourceContext: null,
            ragContext: "",
            chapterMission,
            chapterWriteContext,
            chapterReviewContext: null,
            chapterRepairContext: null,
            openAuditIssues: [],
            pendingReviewProposalCount: 0,
            contextGatingDecisions: [],
            promptBudgetProfiles: [],
          },
          content,
          runId: null,
          startMs: null,
          deferArtifactBackgroundSync: false,
        });
        const taskAfterChapter = await prisma.novelWorkflowTask.findUnique({
          where: { id: task.id },
          select: { status: true, checkpointType: true },
        });
        taskStatesAfterChapter.push(taskAfterChapter);
        const id = "pipeline-job-" + (++jobSequence);
        jobs.set(id, {
          id,
          status: "succeeded",
          progress: 1,
          startOrder: order,
          endOrder: order,
          pendingManualRecovery: false,
          noticeCode: null,
          noticeSummary: null,
          payload: JSON.stringify({ startOrder: order, endOrder: order }),
          error: null,
        });
        return { id, status: "succeeded" };
      },
      async getPipelineJobById(jobId) {
        return jobs.get(jobId) || null;
      },
      async resumePipelineJob() {},
      async cancelPipelineJob() {},
    };

    const runtime = new NovelDirectorAutoExecutionRuntime({
      novelContextService: { listChapters },
      novelService,
      workflowService,
      buildDirectorSeedPayload: (_request, _novelId, extra) => extra || {},
      automationLedgerEventService: {
        recordEvent: async () => {},
        recordRepairTicketCreated: async () => {},
        recordCircuitBreakerOpened: async () => {},
      },
    });

    await runtime.runFromReady({
      taskId: task.id,
      novelId: novel.id,
      request: {
        idea: "主角从城内任务走向更大的追捕",
        candidate: {
          id: "candidate-1",
          workingTitle: "偏离不中断整书",
          logline: "一次偏离改变路线，但写作仍继续。",
          positioning: "悬疑成长",
          sellingPoint: "连续推进",
          coreConflict: "主角必须摆脱追捕",
          protagonistPath: "从被动到主动",
          endingDirection: "完成阶段突破",
          hookStrategy: "每章留下推进",
          progressionLoop: "行动、代价、升级",
          whyItFits: "适合全书自动执行",
          toneKeywords: ["悬疑"],
          targetChapterCount: 2,
        },
        runMode: "full_book_autopilot",
        autoExecutionPlan: {
          mode: "book",
          autoReview: true,
          autoRepair: true,
          artifactSyncMode: "adaptive",
        },
        provider: "deepseek",
        model: "deepseek-chat",
        temperature: 0.7,
      },
      approveAutoExecutionScope: true,
    });

    const finalTask = await prisma.novelWorkflowTask.findUnique({ where: { id: task.id } });
    const finalChapters = await listChapters();
    const proposals = await prisma.changeProposal.findMany({
      where: { novelId: novel.id },
      include: { changes: true },
    });
    const deferredEventCount = await prisma.directorEvent.count({
      where: { novelId: novel.id, type: "proposal_review_deferred" },
    });

    console.log(JSON.stringify({
      startedOrders,
      chapterStatuses: finalChapters.map((chapter) => ({
        order: chapter.order,
        hasContent: Boolean(chapter.content && chapter.content.trim()),
        chapterStatus: chapter.chapterStatus,
      })),
      proposalCount: proposals.length,
      proposalStatuses: proposals.map((proposal) => proposal.status),
      proposalTaskIds: proposals.map((proposal) => proposal.taskId),
      deferredEventCount,
      taskStatesAfterChapter,
      finalTaskStatus: finalTask?.status ?? null,
      finalCheckpointType: finalTask?.checkpointType ?? null,
      transitions,
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
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "chapter-divergence-auto-director-"));
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

test("T1 — a full-book auto-director run finishes after creating a non-blocking divergence proposal", () => {
  const result = runScenario();

  assert.deepEqual(result.startedOrders, [1, 2], "the proposal must not stop the next chapter");
  assert.deepEqual(
    result.chapterStatuses.map((chapter) => [chapter.order, chapter.hasContent]),
    [[1, true], [2, true]],
  );
  assert.equal(result.proposalCount, 1);
  assert.deepEqual(result.proposalStatuses, ["pending_review"]);
  assert.equal(result.deferredEventCount, 1);
  assert.ok(
    result.taskStatesAfterChapter.every((task) => task.status === "running"),
    `chapter-local proposal changed global task state: ${JSON.stringify(result.taskStatesAfterChapter)}`,
  );
  assert.ok(
    result.taskStatesAfterChapter.every((task) => task.checkpointType == null),
    "chapter-local proposal must not install an approval checkpoint",
  );
  assert.equal(result.finalTaskStatus, "succeeded");
  assert.equal(result.finalCheckpointType, "workflow_completed");
  assert.ok(!result.transitions.includes("failed"));
  assert.ok(!result.transitions.includes("requeued"));
});
