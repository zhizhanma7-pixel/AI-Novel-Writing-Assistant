const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pnpmInvocation, sqliteDatabaseUrl } = require("./helpers/processInvocation.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

function setupTempSqliteDatabase(tempDir) {
  const databasePath = path.join(tempDir, "sillytavern-preset-import.db");
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
  const scriptPath = path.join(tempDir, "run-sillytavern-preset-import.cjs");
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

const PRESET = {
  name: "北境写作",
  temperature: 0.92,
  frequency_penalty: 0.7,
  top_p: 1,
  prompts: [
    { identifier: "main", name: "主指令", content: "用冷硬的短句写，不要抒情。", enabled: true },
    { identifier: "style", name: "文风", content: "多用动作推进，少解释。", enabled: true },
    { identifier: "legacy", name: "旧指令", content: "这条已经作废，不要遵守。", enabled: false },
  ],
  chat_completion_source: "openai",
};

async function main() {
  const repoRoot = process.cwd();
  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const {
    SillyTavernPresetImportService,
  } = require(path.join(repoRoot, "server", "dist", "services", "sillytavern", "SillyTavernPresetImportService.js"));

  try {
    const service = new SillyTavernPresetImportService();

    // 预览必须是纯读：先单独验证它不碰库。
    const beforePreview = await snapshotDatabase(prisma);
    const preview = service.preview(PRESET);
    const afterPreview = await snapshotDatabase(prisma);

    // 首次导入会补齐风格引擎的种子数据，先跑一次让它就位，
    // 这样第二次导入的表差异才只反映导入本身。
    await service.importPreset({ rawJson: PRESET, name: "预热" });

    const beforeImport = await snapshotDatabase(prisma);
    const imported = await service.importPreset({ rawJson: PRESET });
    const afterImport = await snapshotDatabase(prisma);

    // 对照写入：证明快照看得见变化。
    await prisma.styleProfile.update({
      where: { id: imported.profile.id },
      data: { description: "对照写入" },
    });
    const control = await snapshotDatabase(prisma);

    const stored = await prisma.styleProfile.findUnique({ where: { id: imported.profile.id } });

    console.log(JSON.stringify({
      previewChangedTables: diffSnapshots(beforePreview, afterPreview),
      previewEffective: preview.effectiveInstructions,
      previewEnabledCount: preview.enabledCount,
      previewDisabledCount: preview.disabledCount,
      previewParametersApplied: preview.generationParametersApplied,
      importChangedTables: diffSnapshots(beforeImport, afterImport),
      controlChangedTables: diffSnapshots(afterImport, control),
      profileName: stored.name,
      profileSourceType: stored.sourceType,
      profileSourceContent: stored.sourceContent,
      narrativeRules: JSON.parse(stored.narrativeRulesJson || "{}"),
      characterRules: JSON.parse(stored.characterRulesJson || "{}"),
      languageRules: JSON.parse(stored.languageRulesJson || "{}"),
      rhythmRules: JSON.parse(stored.rhythmRulesJson || "{}"),
      extractedFeatures: JSON.parse(stored.extractedFeaturesJson || "[]"),
      analysisMarkdown: stored.analysisMarkdown,
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
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "sillytavern-preset-import-"));
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

test("P4 — an imported preset becomes a style profile that can be traced back to its file", () => {
  const result = scenarioResult();

  assert.equal(result.profileName, "北境写作", "预设自带的名字应当被采用");
  assert.equal(result.profileSourceType, "from_sillytavern_preset");

  // 原文无损：外部格式会演进，导入后仍要能回溯。
  const original = JSON.parse(result.profileSourceContent);
  assert.equal(original.chat_completion_source, "openai");
  assert.equal(original.prompts.length, 3);
});

test("P4 — only the enabled instructions reach the writing rules", () => {
  const result = scenarioResult();

  assert.equal(result.narrativeRules.summary.includes("用冷硬的短句写"), true);
  assert.equal(result.narrativeRules.summary.includes("多用动作推进"), true);
  // 被作者关掉的片段不该影响写作。
  assert.equal(
    result.narrativeRules.summary.includes("这条已经作废"),
    false,
    "禁用的指令不能进入生效的写作规则",
  );
  // 但它仍要能看到，否则用户不知道原预设里有这一段。
  assert.equal(result.analysisMarkdown.includes("这条已经作废"), true);
  assert.equal(result.analysisMarkdown.includes("已禁用"), true);

  assert.equal(result.previewEnabledCount, 2);
  assert.equal(result.previewDisabledCount, 1);
});

test("P4 — instructions stay as a summary instead of being invented into structured rules", () => {
  const result = scenarioResult();

  // preset 不携带「这条属于叙事还是语言」的分类。硬拆会让风格合同谎称自己是
  // structured，而它其实只有一段自由文本。
  assert.deepEqual(result.characterRules, {});
  assert.deepEqual(result.languageRules, {});
  assert.deepEqual(result.rhythmRules, {});
  assert.deepEqual(Object.keys(result.narrativeRules), ["summary"]);
});

test("P5 — sampling parameters are kept for reference but never applied", () => {
  const result = scenarioResult();

  assert.equal(result.previewParametersApplied, false);

  // 参数不能混进写作规则，也不能伪装成提取出来的风格特征。
  assert.deepEqual(result.extractedFeatures, []);
  const rulesText = JSON.stringify([
    result.narrativeRules,
    result.characterRules,
    result.languageRules,
    result.rhythmRules,
  ]);
  for (const key of ["temperature", "frequency_penalty", "top_p"]) {
    assert.equal(rulesText.includes(key), false, `${key} 不该出现在写作规则里`);
  }

  // 展示层要如实说明它不生效，否则用户会以为温度已经被接管。
  assert.equal(result.analysisMarkdown.includes("0.92"), true);
  assert.equal(result.analysisMarkdown.includes("不会改变本项目实际的模型调用参数"), true);
});

test("P5 — importing writes only the style profile, and preview writes nothing at all", () => {
  const result = scenarioResult();

  assert.deepEqual(
    result.previewChangedTables,
    [],
    "预览必须是纯读",
  );
  assert.deepEqual(
    result.controlChangedTables,
    ["StyleProfile"],
    "对照写入必须可见，否则下面这条什么都没证明",
  );
  // 导入一份预设不该碰模型设置、API key 或任何其他子系统的表。
  assert.deepEqual(
    result.importChangedTables,
    ["StyleProfile"],
    `导入只能写 StyleProfile，实际变化：${result.importChangedTables.join(", ")}`,
  );
});
