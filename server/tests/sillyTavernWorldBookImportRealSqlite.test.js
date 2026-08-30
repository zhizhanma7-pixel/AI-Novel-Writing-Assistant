const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pnpmInvocation, sqliteDatabaseUrl } = require("./helpers/processInvocation.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

function setupTempSqliteDatabase(tempDir) {
  const databasePath = path.join(tempDir, "sillytavern-world-book-import.db");
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
  const scriptPath = path.join(tempDir, "run-sillytavern-world-book-import.cjs");
  const script = `
const path = require("node:path");

const BOOK = {
  name: "北境设定",
  entries: {
    "0": { keys: ["影卫"], content: "影卫直属城主，不受旧律约束。", enabled: true, insertion_order: 0 },
    "1": { keys: ["宵禁"], content: "宵禁自戌时起。", enabled: true, insertion_order: 1, constant: true },
    "2": { keys: ["废稿"], content: "这条作者已经关掉。", enabled: false, insertion_order: 2 },
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
    SillyTavernWorldBookImportService,
  } = require(path.join(repoRoot, "server", "dist", "services", "sillytavern", "SillyTavernWorldBookImportService.js"));

  try {
    const service = new SillyTavernWorldBookImportService();

    const first = await service.importBook({ rawJson: BOOK });
    const afterFirstDocs = await prisma.knowledgeDocument.count();
    const afterFirstVersions = await prisma.knowledgeDocumentVersion.count();
    const storedFirst = await prisma.knowledgeDocument.findUnique({
      where: { id: first.documentId },
      include: { activeVersion: true },
    });

    // 同一本再导一次：内容没变，不该产生新版本，也不该重新排队索引。
    const second = await service.importBook({ rawJson: BOOK });
    const afterSecondDocs = await prisma.knowledgeDocument.count();
    const afterSecondVersions = await prisma.knowledgeDocumentVersion.count();

    // 内容变了：应当是同一份文档的新版本，而不是第二份文档。
    const edited = JSON.parse(JSON.stringify(BOOK));
    edited.entries["3"] = { keys: ["渡口"], content: "渡口每月初三通船。", enabled: true, insertion_order: 3 };
    const third = await service.importBook({ rawJson: edited });
    const afterThirdDocs = await prisma.knowledgeDocument.count();
    const storedThird = await prisma.knowledgeDocument.findUnique({
      where: { id: third.documentId },
      include: { activeVersion: true },
    });

    // 全部条目被禁用：拒绝导入，且不能留下任何空文档。
    const docsBeforeEmpty = await prisma.knowledgeDocument.count();
    const emptyOutcome = await expectRejection(() => service.importBook({
      rawJson: { name: "空设定", entries: { "0": { keys: ["x"], content: "关掉的", enabled: false } } },
    }));
    const docsAfterEmpty = await prisma.knowledgeDocument.count();

    console.log(JSON.stringify({
      firstDocumentId: first.documentId,
      firstUnchanged: first.unchanged,
      firstVersionNumber: first.versionNumber,
      afterFirstDocs,
      afterFirstVersions,
      firstContent: storedFirst.activeVersion.content,
      firstIndexStatus: storedFirst.latestIndexStatus,
      secondDocumentId: second.documentId,
      secondUnchanged: second.unchanged,
      secondVersionNumber: second.versionNumber,
      afterSecondDocs,
      afterSecondVersions,
      thirdDocumentId: third.documentId,
      thirdUnchanged: third.unchanged,
      thirdVersionNumber: third.versionNumber,
      afterThirdDocs,
      thirdContent: storedThird.activeVersion.content,
      emptyOutcome,
      docsBeforeEmpty,
      docsAfterEmpty,
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
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "sillytavern-world-book-import-"));
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

test("P6 — world book entries land in the knowledge base and get queued for indexing", () => {
  const result = scenarioResult();

  assert.equal(result.afterFirstDocs, 1);
  assert.equal(result.afterFirstVersions, 1);
  assert.equal(result.firstUnchanged, false);
  assert.equal(result.firstVersionNumber, 1);

  assert.ok(result.firstContent.includes("影卫直属城主"));
  assert.ok(result.firstContent.includes("宵禁自戌时起"));
  assert.ok(result.firstContent.includes("关键词：影卫"));

  // 走既有索引队列，不新建索引路径。
  assert.notEqual(result.firstIndexStatus, "idle", "导入后应当排队重建索引");
});

test("P6 — an entry disabled in the source file never reaches the searchable text", () => {
  const result = scenarioResult();

  assert.equal(
    result.firstContent.includes("这条作者已经关掉"),
    false,
    "原文件里关掉的条目不能进入检索内容",
  );
});

test("P7 — importing the same book twice does not create a second document or version", () => {
  const result = scenarioResult();

  assert.equal(result.secondUnchanged, true, "内容一致时应当识别为未变更");
  assert.equal(result.secondDocumentId, result.firstDocumentId);
  assert.equal(result.afterSecondDocs, 1, "不能产生第二份文档");
  assert.equal(
    result.afterSecondVersions,
    result.afterFirstVersions,
    "内容没变就不该产生新版本，也不该因此重新索引",
  );
  assert.equal(result.secondVersionNumber, result.firstVersionNumber);
});

test("P7 — an edited book becomes a new version of the same document", () => {
  const result = scenarioResult();

  assert.equal(result.thirdDocumentId, result.firstDocumentId, "改过内容仍应落在同一份文档上");
  assert.equal(result.afterThirdDocs, 1);
  assert.equal(result.thirdUnchanged, false);
  assert.equal(result.thirdVersionNumber, result.firstVersionNumber + 1);
  assert.ok(result.thirdContent.includes("渡口每月初三通船"));
});

test("a book with nothing enabled is refused and leaves no empty document behind", () => {
  const result = scenarioResult();

  // 书名和描述本身就能撑起正文，所以这里必须按「有多少条会进检索」判断。
  assert.equal(result.emptyOutcome.rejected, true);
  assert.equal(result.emptyOutcome.code, "empty_world_book");
  assert.equal(result.docsAfterEmpty, result.docsBeforeEmpty, "被拒绝的导入不能留下文档");
});
