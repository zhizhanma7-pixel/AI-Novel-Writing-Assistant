const test = require("node:test");
const assert = require("node:assert/strict");

const { runDirectorStructuredOutlinePhase } = require("../dist/services/novel/director/phases/novelDirectorPipelinePhases.js");
const {
  buildCharacterDynamicsRebuildRecoveryKey,
} = require("../dist/services/novel/director/phases/novelDirectorStructuredOutlinePhase.js");
const { prisma } = require("../dist/db/prisma.js");
const {
  novelSideEffectJobService,
} = require("../dist/events/sideEffects/index.js");

function createChapter(id, order, title) {
  return {
    id,
    chapterOrder: order,
    title,
    summary: `${title} summary`,
    purpose: null,
    exclusiveEvent: null,
    endingState: null,
    nextChapterEntryState: null,
    conflictLevel: null,
    revealLevel: null,
    targetWordCount: null,
    mustAvoid: null,
    taskSheet: null,
    sceneCards: null,
    payoffRefs: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createBeatSheet() {
  return {
    volumeId: "volume-1",
    volumeSortOrder: 1,
    status: "generated",
    beats: [
      {
        key: "opening",
        label: "Opening",
        summary: "Opening summary",
        chapterSpanHint: "1-2章",
        mustDeliver: ["Opening"],
      },
    ],
  };
}

function createSceneCards(chapter) {
  return JSON.stringify({
    targetWordCount: chapter.targetWordCount ?? 3000,
    lengthBudget: {
      targetWordCount: chapter.targetWordCount ?? 3000,
      softMinWordCount: 2500,
      softMaxWordCount: 3400,
      hardMaxWordCount: 3800,
    },
    scenes: [
      {
        key: `${chapter.id}-scene-1`,
        title: `${chapter.title} scene 1`,
        purpose: "推进本章目标",
        mustAdvance: ["主线"],
        mustPreserve: ["人物动机"],
        entryState: "进入冲突",
        exitState: "压力升级",
        forbiddenExpansion: [],
        targetWordCount: 1000,
      },
      {
        key: `${chapter.id}-scene-2`,
        title: `${chapter.title} scene 2`,
        purpose: "升级选择压力",
        mustAdvance: ["冲突"],
        mustPreserve: ["设定边界"],
        entryState: "压力升级",
        exitState: "代价显形",
        forbiddenExpansion: [],
        targetWordCount: 1000,
      },
      {
        key: `${chapter.id}-scene-3`,
        title: `${chapter.title} scene 3`,
        purpose: "形成章末钩子",
        mustAdvance: ["章末推进"],
        mustPreserve: ["后续入口"],
        entryState: "代价显形",
        exitState: "进入下一章",
        forbiddenExpansion: [],
        targetWordCount: 1000,
      },
    ],
  });
}

function applyCompleteChapterDetail(chapter) {
  chapter.purpose = `${chapter.title} purpose`;
  chapter.exclusiveEvent = `${chapter.title} exclusive event`;
  chapter.endingState = `${chapter.title} ending state`;
  chapter.nextChapterEntryState = `${chapter.title} next entry`;
  chapter.conflictLevel = 4;
  chapter.revealLevel = 3;
  chapter.targetWordCount = 3000;
  chapter.mustAvoid = `${chapter.title} avoid`;
  chapter.taskSheet = `${chapter.title} task sheet`;
  chapter.sceneCards = createSceneCards(chapter);
}

function mapWorkspaceChapterToExecution(chapter) {
  return {
    id: chapter.id,
    order: chapter.chapterOrder,
    content: "",
    generationState: "planned",
    chapterStatus: "unplanned",
    conflictLevel: chapter.conflictLevel,
    revealLevel: chapter.revealLevel,
    targetWordCount: chapter.targetWordCount,
    mustAvoid: chapter.mustAvoid,
    taskSheet: chapter.taskSheet,
    sceneCards: chapter.sceneCards,
  };
}

test("runDirectorStructuredOutlinePhase persists chapter detail after each completed chapter", async () => {
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    transaction: prisma.$transaction,
  };
  const baseWorkspace = {
    novelId: "novel-demo",
    workspaceVersion: "v2",
    source: "volume",
    activeVersionId: "version-1",
    derivedOutline: "",
    derivedStructuredOutline: "",
    readiness: {},
    strategyPlan: null,
    critiqueReport: null,
    beatSheets: [createBeatSheet()],
    rebalanceDecisions: [],
    volumes: [
      {
        id: "volume-1",
        sortOrder: 1,
        title: "Volume 1",
        summary: "",
        openingHook: "",
        mainPromise: "",
        primaryPressureSource: "",
        coreSellingPoint: "",
        escalationMode: "",
        protagonistChange: "",
        midVolumeRisk: "",
        climax: "",
        payoffType: "",
        nextVolumeHook: "",
        resetPoint: "",
        openPayoffs: [],
        status: "draft",
        chapters: [
          { ...createChapter("chapter-1", 1, "Chapter 1"), beatKey: "opening" },
          { ...createChapter("chapter-2", 2, "Chapter 2"), beatKey: "opening" },
        ],
      },
    ],
  };

  const syncedSnapshots = [];
  const syncCalls = [];
  const resetFindManyCalls = [];
  const resetDeletions = [];
  let lastSyncedWorkspace = clone(baseWorkspace);
  const rebuildCalls = [];
  prisma.chapter.findMany = async (input) => {
    resetFindManyCalls.push(input);
    return [
      { id: "chapter-1" },
      { id: "chapter-2" },
    ];
  };
  prisma.$transaction = async (callback) => callback({
    chapter: {
      updateMany: async (input) => {
        resetDeletions.push(["chapter", input]);
        return { count: input.where.id.in.length };
      },
    },
    chapterSummary: { deleteMany: async (input) => resetDeletions.push(["chapterSummary", input]) },
    consistencyFact: { deleteMany: async (input) => resetDeletions.push(["consistencyFact", input]) },
    characterTimeline: { deleteMany: async (input) => resetDeletions.push(["characterTimeline", input]) },
    characterCandidate: { deleteMany: async (input) => resetDeletions.push(["characterCandidate", input]) },
    characterFactionTrack: { deleteMany: async (input) => resetDeletions.push(["characterFactionTrack", input]) },
    characterRelationStage: { deleteMany: async (input) => resetDeletions.push(["characterRelationStage", input]) },
    qualityReport: { deleteMany: async (input) => resetDeletions.push(["qualityReport", input]) },
    auditReport: { deleteMany: async (input) => resetDeletions.push(["auditReport", input]) },
    stateChangeProposal: { deleteMany: async (input) => resetDeletions.push(["stateChangeProposal", input]) },
    openConflict: { deleteMany: async (input) => resetDeletions.push(["openConflict", input]) },
    storyStateSnapshot: { deleteMany: async (input) => resetDeletions.push(["storyStateSnapshot", input]) },
  });

  const volumeService = {
    generateVolumes: async (_novelId, options) => {
      if (options.scope !== "chapter_detail") {
        return clone(options.draftWorkspace);
      }
      const workspace = clone(options.draftWorkspace);
      const chapter = workspace.volumes[0].chapters.find((item) => item.id === options.targetChapterId);
      assert.ok(chapter, "target chapter should exist in draft workspace");

      applyCompleteChapterDetail(chapter);

      return workspace;
    },
    updateVolumes: async (_novelId, workspace) => clone(workspace),
    updateVolumesWithOptions: async (_novelId, workspace) => clone(workspace),
    syncVolumeChapters: async (_novelId, input) => {
      const snapshot = clone(input.volumes);
      syncedSnapshots.push(snapshot);
      lastSyncedWorkspace = {
        ...lastSyncedWorkspace,
        volumes: snapshot,
      };
      return { creates: [], updates: [], deletes: [] };
    },
    syncVolumeChaptersWithOptions: async (_novelId, input, options) => {
      syncCalls.push({ input, options });
      const snapshot = clone(input.volumes);
      syncedSnapshots.push(snapshot);
      lastSyncedWorkspace = {
        ...lastSyncedWorkspace,
        volumes: snapshot,
      };
      return { creates: [], updates: [], deletes: [] };
    },
  };

  const dependencies = {
    workflowService: {
      bootstrapTask: async () => undefined,
      markTaskRunning: async () => undefined,
      recordCheckpoint: async () => undefined,
    },
    novelContextService: {
      listChapters: async () => lastSyncedWorkspace.volumes[0].chapters.map(mapWorkspaceChapterToExecution),
      updateNovel: async () => undefined,
      // 收尾时会读作品的 creationExperience 决定要不要接着跑简版量产；
      // 这两条用例不走那条路，给 null 就是「没有 simple 标记」。
      getNovelById: async () => null,
    },
    characterDynamicsService: {
      rebuildDynamics: async (novelId, options) => {
        rebuildCalls.push({ novelId, options });
      },
    },
    characterPreparationService: {},
    volumeService,
  };

  const callbacks = {
    buildDirectorSeedPayload: (_request, novelId, extra) => ({
      novelId,
      ...extra,
    }),
    markDirectorTaskRunning: async () => undefined,
  };

  try {
    await runDirectorStructuredOutlinePhase({
      taskId: "task-1",
      novelId: "novel-demo",
      request: {
        runMode: "auto_to_execution",
        provider: "deepseek",
        model: "deepseek-chat",
        temperature: 0.7,
        autoExecutionPlan: {
          mode: "chapter_range",
          startOrder: 1,
          endOrder: 2,
        },
        candidate: {
          workingTitle: "Demo Novel",
        },
      },
      baseWorkspace,
      dependencies,
      callbacks,
    });
  } finally {
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.$transaction = originals.transaction;
  }

  assert.equal(syncedSnapshots.length, 3);
  assert.equal(syncCalls[0].input.applyDeletes, false);
  assert.equal(syncCalls[0].input.preserveContent, true);
  assert.deepEqual(syncCalls.map((call) => call.input.executionContractChapterRange), [
    {
      startOrder: 1,
      endOrder: 1,
    },
    {
      startOrder: 2,
      endOrder: 2,
    },
    {
      startOrder: 1,
      endOrder: 2,
    },
  ]);
  assert.deepEqual(rebuildCalls, [{
    novelId: "novel-demo",
    options: { sourceType: "rebuild_projection" },
  }]);
  assert.deepEqual(resetFindManyCalls[0].where.order, { gte: 1, lte: 2 });
  assert.ok(resetDeletions.some(([table]) => table === "stateChangeProposal"));
  assert.ok(resetDeletions.some(([table]) => table === "openConflict"));
  assert.ok(resetDeletions.some(([table]) => table === "storyStateSnapshot"));

  const firstIncrementalSync = syncedSnapshots[0][0].chapters;
  assert.equal(firstIncrementalSync[0].purpose, "Chapter 1 purpose");
  assert.equal(firstIncrementalSync[0].taskSheet, "Chapter 1 task sheet");
  assert.ok(firstIncrementalSync[0].sceneCards);
  assert.equal(firstIncrementalSync[1].taskSheet, null);

  const finalSync = syncedSnapshots[2][0].chapters;
  assert.equal(finalSync[0].purpose, "Chapter 1 purpose");
  assert.equal(finalSync[0].taskSheet, "Chapter 1 task sheet");
  assert.ok(finalSync[0].sceneCards);
  assert.equal(finalSync[1].purpose, "Chapter 2 purpose");
  assert.equal(finalSync[1].taskSheet, "Chapter 2 task sheet");
  assert.ok(finalSync[1].sceneCards);
});

test("runDirectorStructuredOutlinePhase resumes from the next incomplete chapter", async () => {
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    transaction: prisma.$transaction,
  };
  const preDetailedChapter = {
    ...createChapter("chapter-1", 1, "Chapter 1"),
    purpose: "Chapter 1 purpose",
    exclusiveEvent: "Chapter 1 exclusive event",
    endingState: "Chapter 1 ending state",
    nextChapterEntryState: "Chapter 1 next entry",
    conflictLevel: 3,
    revealLevel: 2,
    targetWordCount: 2800,
    mustAvoid: "Chapter 1 avoid",
    taskSheet: "Chapter 1 task sheet",
    sceneCards: createSceneCards({ id: "chapter-1", title: "Chapter 1", targetWordCount: 2800 }),
  };
  const baseWorkspace = {
    novelId: "novel-demo",
    workspaceVersion: "v2",
    source: "volume",
    activeVersionId: "version-1",
    derivedOutline: "",
    derivedStructuredOutline: "",
    readiness: {},
    strategyPlan: null,
    critiqueReport: null,
    beatSheets: [createBeatSheet()],
    rebalanceDecisions: [],
    volumes: [
      {
        id: "volume-1",
        sortOrder: 1,
        title: "Volume 1",
        summary: "",
        openingHook: "",
        mainPromise: "",
        primaryPressureSource: "",
        coreSellingPoint: "",
        escalationMode: "",
        protagonistChange: "",
        midVolumeRisk: "",
        climax: "",
        payoffType: "",
        nextVolumeHook: "",
        resetPoint: "",
        openPayoffs: [],
        status: "draft",
        chapters: [
          { ...preDetailedChapter, beatKey: "opening" },
          { ...createChapter("chapter-2", 2, "Chapter 2"), beatKey: "opening" },
        ],
      },
    ],
  };

  const generatedTargets = [];
  const syncCalls = [];
  const resetFindManyCalls = [];
  let lastSyncedWorkspace = clone(baseWorkspace);
  const rebuildCalls = [];
  prisma.chapter.findMany = async (input) => {
    resetFindManyCalls.push(input);
    return [
      { id: "chapter-1" },
      { id: "chapter-2" },
    ];
  };
  prisma.$transaction = async (callback) => callback({
    chapter: { updateMany: async () => ({ count: 2 }) },
    chapterSummary: { deleteMany: async () => ({ count: 0 }) },
    consistencyFact: { deleteMany: async () => ({ count: 0 }) },
    characterTimeline: { deleteMany: async () => ({ count: 0 }) },
    characterCandidate: { deleteMany: async () => ({ count: 0 }) },
    characterFactionTrack: { deleteMany: async () => ({ count: 0 }) },
    characterRelationStage: { deleteMany: async () => ({ count: 0 }) },
    qualityReport: { deleteMany: async () => ({ count: 0 }) },
    auditReport: { deleteMany: async () => ({ count: 0 }) },
    stateChangeProposal: { deleteMany: async () => ({ count: 0 }) },
    openConflict: { deleteMany: async () => ({ count: 0 }) },
    storyStateSnapshot: { deleteMany: async () => ({ count: 0 }) },
  });
  const volumeService = {
    generateVolumes: async (_novelId, options) => {
      if (options.scope !== "chapter_detail") {
        return clone(options.draftWorkspace);
      }
      generatedTargets.push(`${options.targetChapterId}:${options.detailMode}`);
      const workspace = clone(options.draftWorkspace);
      const chapter = workspace.volumes[0].chapters.find((item) => item.id === options.targetChapterId);
      assert.ok(chapter, "target chapter should exist in draft workspace");
      applyCompleteChapterDetail(chapter);
      return workspace;
    },
    updateVolumes: async (_novelId, workspace) => clone(workspace),
    updateVolumesWithOptions: async (_novelId, workspace) => clone(workspace),
    syncVolumeChapters: async (_novelId, input) => {
      lastSyncedWorkspace = {
        ...lastSyncedWorkspace,
        volumes: clone(input.volumes),
      };
      return { creates: [], updates: [], deletes: [] };
    },
    syncVolumeChaptersWithOptions: async (_novelId, input) => {
      syncCalls.push({ input });
      lastSyncedWorkspace = {
        ...lastSyncedWorkspace,
        volumes: clone(input.volumes),
      };
      return { creates: [], updates: [], deletes: [] };
    },
  };

  const dependencies = {
    workflowService: {
      bootstrapTask: async () => undefined,
      markTaskRunning: async () => undefined,
      recordCheckpoint: async () => undefined,
    },
    novelContextService: {
      listChapters: async () => lastSyncedWorkspace.volumes[0].chapters.map(mapWorkspaceChapterToExecution),
      updateNovel: async () => undefined,
      // 收尾时会读作品的 creationExperience 决定要不要接着跑简版量产；
      // 这两条用例不走那条路，给 null 就是「没有 simple 标记」。
      getNovelById: async () => null,
    },
    characterDynamicsService: {
      rebuildDynamics: async (novelId, options) => {
        rebuildCalls.push({ novelId, options });
      },
    },
    characterPreparationService: {},
    volumeService,
  };

  const callbacks = {
    buildDirectorSeedPayload: (_request, novelId, extra) => ({
      novelId,
      ...extra,
    }),
    markDirectorTaskRunning: async () => undefined,
  };

  try {
    await runDirectorStructuredOutlinePhase({
      taskId: "task-2",
      novelId: "novel-demo",
      request: {
        runMode: "auto_to_execution",
        provider: "deepseek",
        model: "deepseek-chat",
        temperature: 0.7,
        autoExecutionPlan: {
          mode: "chapter_range",
          startOrder: 1,
          endOrder: 2,
        },
        candidate: {
          workingTitle: "Demo Novel",
        },
      },
      baseWorkspace,
      dependencies,
      callbacks,
    });
  } finally {
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.$transaction = originals.transaction;
  }

  assert.deepEqual(generatedTargets, [
    "chapter-2:task_sheet",
  ]);
  assert.deepEqual(syncCalls.map((call) => call.input.executionContractChapterRange), [
    {
      startOrder: 2,
      endOrder: 2,
    },
    {
      startOrder: 1,
      endOrder: 2,
    },
  ]);
  assert.deepEqual(resetFindManyCalls[0].where.order, { gte: 1, lte: 2 });
  assert.deepEqual(rebuildCalls, [{
    novelId: "novel-demo",
    options: { sourceType: "rebuild_projection" },
  }]);
});

function buildRebuildRecoveryHarness(rebuildDynamics) {
  const baseWorkspace = {
    novelId: "novel-demo",
    workspaceVersion: "v2",
    source: "volume",
    activeVersionId: "version-1",
    derivedOutline: "",
    derivedStructuredOutline: "",
    readiness: {},
    strategyPlan: null,
    critiqueReport: null,
    beatSheets: [createBeatSheet()],
    rebalanceDecisions: [],
    volumes: [{
      id: "volume-1",
      sortOrder: 1,
      title: "Volume 1",
      summary: "",
      openingHook: "",
      mainPromise: "",
      primaryPressureSource: "",
      coreSellingPoint: "",
      escalationMode: "",
      protagonistChange: "",
      midVolumeRisk: "",
      climax: "",
      payoffType: "",
      nextVolumeHook: "",
      resetPoint: "",
      openPayoffs: [],
      status: "draft",
      chapters: [
        { ...createChapter("chapter-1", 1, "Chapter 1"), beatKey: "opening" },
        { ...createChapter("chapter-2", 2, "Chapter 2"), beatKey: "opening" },
      ],
    }],
  };
  let lastSyncedWorkspace = clone(baseWorkspace);
  const noopTransaction = async (callback) => callback({
    chapter: { updateMany: async (input) => ({ count: input.where.id.in.length }) },
    chapterSummary: { deleteMany: async () => undefined },
    consistencyFact: { deleteMany: async () => undefined },
    characterTimeline: { deleteMany: async () => undefined },
    characterCandidate: { deleteMany: async () => undefined },
    characterFactionTrack: { deleteMany: async () => undefined },
    characterRelationStage: { deleteMany: async () => undefined },
    qualityReport: { deleteMany: async () => undefined },
    auditReport: { deleteMany: async () => undefined },
    stateChangeProposal: { deleteMany: async () => undefined },
    openConflict: { deleteMany: async () => undefined },
    storyStateSnapshot: { deleteMany: async () => undefined },
  });
  const syncWorkspace = (input) => {
    lastSyncedWorkspace = { ...lastSyncedWorkspace, volumes: clone(input.volumes) };
    return { creates: [], updates: [], deletes: [] };
  };
  return {
    baseWorkspace,
    noopTransaction,
    dependencies: {
      workflowService: {
        bootstrapTask: async () => undefined,
        markTaskRunning: async () => undefined,
        recordCheckpoint: async () => undefined,
      },
      novelContextService: {
        listChapters: async () => lastSyncedWorkspace.volumes[0].chapters.map(mapWorkspaceChapterToExecution),
        updateNovel: async () => undefined,
        getNovelById: async () => null,
      },
      characterDynamicsService: { rebuildDynamics },
      characterPreparationService: {},
      volumeService: {
        generateVolumes: async (_novelId, options) => {
          const workspace = clone(options.draftWorkspace);
          if (options.scope === "chapter_detail") {
            applyCompleteChapterDetail(
              workspace.volumes[0].chapters.find((item) => item.id === options.targetChapterId),
            );
          }
          return workspace;
        },
        updateVolumes: async (_novelId, workspace) => clone(workspace),
        updateVolumesWithOptions: async (_novelId, workspace) => clone(workspace),
        syncVolumeChapters: async (_novelId, input) => syncWorkspace(input),
        syncVolumeChaptersWithOptions: async (_novelId, input) => syncWorkspace(input),
      },
    },
    callbacks: {
      buildDirectorSeedPayload: (_request, novelId, extra) => ({ novelId, ...extra }),
      markDirectorTaskRunning: async () => undefined,
    },
    request: {
      runMode: "auto_to_execution",
      provider: "deepseek",
      model: "deepseek-chat",
      temperature: 0.7,
      autoExecutionPlan: { mode: "chapter_range", startOrder: 1, endOrder: 2 },
      candidate: { workingTitle: "Demo Novel" },
    },
  };
}

test("a failed character dynamics rebuild is handed to the side-effect queue instead of only being logged", async () => {
  // 重建失败只打日志的话，角色投影会停在旧的章节规划上，而正文照样往下写。
  // 交给既有队列（退避重试 + 死信）才能自己恢复。
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    transaction: prisma.$transaction,
    enqueueJob: novelSideEffectJobService.enqueueJob,
  };
  const enqueued = [];
  const harness = buildRebuildRecoveryHarness(async () => {
    throw new Error("rebuild exploded");
  });
  prisma.chapter.findMany = async () => [{ id: "chapter-1" }, { id: "chapter-2" }];
  prisma.$transaction = harness.noopTransaction;
  novelSideEffectJobService.enqueueJob = async (input) => {
    enqueued.push(input);
    return { job: null, created: true };
  };

  try {
    await runDirectorStructuredOutlinePhase({
      taskId: "task-rebuild-recovery",
      novelId: "novel-demo",
      request: harness.request,
      baseWorkspace: harness.baseWorkspace,
      dependencies: harness.dependencies,
      callbacks: harness.callbacks,
    });
  } finally {
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.$transaction = originals.transaction;
    novelSideEffectJobService.enqueueJob = originals.enqueueJob;
  }

  assert.equal(enqueued.length, 1, "重建失败必须排一个兜底作业");
  assert.equal(enqueued[0].jobType, "character.volumeRebuild");
  assert.equal(enqueued[0].novelId, "novel-demo");
  // 来源标注要保留成拆章后的重投影，不能被兜底改写成卷结构投影。
  assert.deepEqual(enqueued[0].payload, {
    novelId: "novel-demo",
    sourceType: "rebuild_projection",
  });
  // 幂等键要带章节结构指纹：拆章再变一次是一件新的重建，不能被上一次的成功
  // 记录挡住（成功作业会一直留在表里）。
  assert.match(enqueued[0].idempotencyKey, /^character\.volumeRebuild:structured_outline:novel-demo:[0-9a-f]{40}$/);
});

test("a dead recovery job is reported instead of silently swallowing the rebuild", async () => {
  // 队列只 lease pending / failed 的作业，进了死信就再也不会被取走；而同键再排一次
  // 只会拿回那条死信记录。这种情况下投影其实没人管了，必须说出来。
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    transaction: prisma.$transaction,
    enqueueJob: novelSideEffectJobService.enqueueJob,
    consoleError: console.error,
  };
  const errors = [];
  const harness = buildRebuildRecoveryHarness(async () => {
    throw new Error("rebuild exploded");
  });
  prisma.chapter.findMany = async () => [{ id: "chapter-1" }, { id: "chapter-2" }];
  prisma.$transaction = harness.noopTransaction;
  novelSideEffectJobService.enqueueJob = async () => ({
    job: { status: "dead", attempts: 5, maxAttempts: 5 },
    created: false,
  });
  console.error = (message) => {
    errors.push(String(message));
  };

  try {
    await runDirectorStructuredOutlinePhase({
      taskId: "task-rebuild-dead",
      novelId: "novel-demo",
      request: harness.request,
      baseWorkspace: harness.baseWorkspace,
      dependencies: harness.dependencies,
      callbacks: harness.callbacks,
    });
  } finally {
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.$transaction = originals.transaction;
    novelSideEffectJobService.enqueueJob = originals.enqueueJob;
    console.error = originals.consoleError;
  }

  const reported = errors.filter((message) => message.includes("character_dynamics_rebuild_recovery_dead"));
  assert.equal(reported.length, 1, `死信兜底必须被显式报出来：${JSON.stringify(errors)}`);
  assert.match(reported[0], /attempts=5\/5/);
  assert.match(reported[0], /需要人工重建/);
});

test("an already queued recovery job is not reported as dead", async () => {
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    transaction: prisma.$transaction,
    enqueueJob: novelSideEffectJobService.enqueueJob,
    consoleError: console.error,
  };
  const errors = [];
  const harness = buildRebuildRecoveryHarness(async () => {
    throw new Error("rebuild exploded");
  });
  prisma.chapter.findMany = async () => [{ id: "chapter-1" }, { id: "chapter-2" }];
  prisma.$transaction = harness.noopTransaction;
  // 同键已有一条待跑的作业：重建已经在队列里，不该再报死信。
  novelSideEffectJobService.enqueueJob = async () => ({
    job: { status: "pending", attempts: 0, maxAttempts: 5 },
    created: false,
  });
  console.error = (message) => {
    errors.push(String(message));
  };

  try {
    await runDirectorStructuredOutlinePhase({
      taskId: "task-rebuild-queued",
      novelId: "novel-demo",
      request: harness.request,
      baseWorkspace: harness.baseWorkspace,
      dependencies: harness.dependencies,
      callbacks: harness.callbacks,
    });
  } finally {
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.$transaction = originals.transaction;
    novelSideEffectJobService.enqueueJob = originals.enqueueJob;
    console.error = originals.consoleError;
  }

  assert.equal(
    errors.filter((message) => message.includes("character_dynamics_rebuild_recovery_dead")).length,
    0,
  );
});

test("the rebuild recovery key changes when the chapter structure changes", () => {
  // 成功的 side-effect 作业会一直留在表里，幂等键固定就意味着后续重建永远排不
  // 进去。键必须随卷/章结构变化，拆章改一次就是一件新的重建。
  const workspaceWith = (chapterOrders) => ({
    volumes: [{
      id: "volume-1",
      sortOrder: 1,
      chapters: chapterOrders.map((chapterOrder) => ({ chapterOrder })),
    }],
  });

  const twoChapters = buildCharacterDynamicsRebuildRecoveryKey("novel-demo", workspaceWith([1, 2]));
  const threeChapters = buildCharacterDynamicsRebuildRecoveryKey("novel-demo", workspaceWith([1, 2, 3]));
  const reordered = buildCharacterDynamicsRebuildRecoveryKey("novel-demo", workspaceWith([2, 1]));
  const otherNovel = buildCharacterDynamicsRebuildRecoveryKey("novel-other", workspaceWith([1, 2]));

  assert.equal(twoChapters, buildCharacterDynamicsRebuildRecoveryKey("novel-demo", workspaceWith([1, 2])));
  assert.notEqual(twoChapters, threeChapters, "多了一章就是新的重建");
  assert.notEqual(twoChapters, reordered, "章节顺序变了也是新的重建");
  assert.notEqual(twoChapters, otherNovel, "不同作品不能共用一个键");
});
