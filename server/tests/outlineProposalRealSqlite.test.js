const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pnpmInvocation, sqliteDatabaseUrl } = require("./helpers/processInvocation.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

test("approved outline proposal updates planning assets and preserves existing chapter content", () => {
  const tempRoot = path.join(serverRoot, ".tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "outline-proposal-"));
  try {
    const databaseUrl = sqliteDatabaseUrl(serverRoot, path.join(tempDir, "outline.db"));
    const invocation = pnpmInvocation(["--filter", "@ai-novel/server", "prisma:push"]);
    childProcess.execFileSync(invocation.command, invocation.args, {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, ...(process.platform === "win32" ? { RUST_LOG: "info" } : {}) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const scriptPath = path.join(tempDir, "run.cjs");
    fs.writeFileSync(scriptPath, `
const path = require("node:path");
async function main() {
  const root = process.cwd();
  const { prisma } = require(path.join(root, "server/dist/db/prisma.js"));
  const { changeProposalService } = require(path.join(root, "server/dist/services/novel/proposal/application/ChangeProposalService.js"));
  const { changeProposalReviewService } = require(path.join(root, "server/dist/services/novel/proposal/application/ChangeProposalReviewService.js"));
  const { changeProposalApplyService } = require(path.join(root, "server/dist/services/novel/proposal/application/ChangeProposalApplyService.js"));
  try {
    const novel = await prisma.novel.create({ data: { title: "大纲导入测试" } });
    const existing = await prisma.chapter.create({ data: { novelId: novel.id, order: 23, title: "旧标题", content: "不可删除的已有正文" } });
    const chapters = [
      { order: 22, title: "吃饭", summary: "主角吃饭", purpose: "铺垫", sourceEventIds: ["e22"], beats: ["完成吃饭"] },
      { order: 23, title: "A离开", summary: "A决定离开", purpose: "转折", sourceEventIds: ["e23"], beats: ["A离开"] },
      { order: 24, title: "B调查", summary: "B开始调查", purpose: "推进", sourceEventIds: ["e24"], beats: ["B调查"] },
    ];
    const obligations = chapters.map((chapter, index) => ({ id: "ob" + index, eventId: chapter.sourceEventIds[0], kind: "event", description: chapter.summary, requiredOrder: index }));
    const proposal = await changeProposalService.createProposal(novel.id, {
      proposalType: "outline_edit",
      outlineFidelity: "strict",
      summary: "严格导入三章大纲",
      sourceRefs: [], warnings: [], expectedState: { obligations }, submitForReview: true,
      changes: [{
        proposalType: "outline_plan_update", path: "outline.plan", operation: "add", category: "outline", severity: "major",
        payload: { fidelity: "strict", sourceText: "22 吃饭\\n23 A离开\\n24 B调查", polishedSummary: "三章规划", preservationObligations: obligations, chapters, dependencyImpacts: [{ chapterOrder: 23, summary: "已有正文", severity: "major", hasExistingContent: true }] },
        reason: "写入正式规划", sourceRefs: [], evidence: ["22 吃饭", "23 A离开", "24 B调查"],
      }],
    });
    await changeProposalReviewService.approveProposal(novel.id, proposal.id, {});
    const executed = await changeProposalApplyService.executeProposal(novel.id, proposal.id);
    const refreshed = await prisma.novel.findUnique({ where: { id: novel.id } });
    const finalChapters = await prisma.chapter.findMany({ where: { novelId: novel.id }, orderBy: { order: "asc" } });
    const volumePlans = await prisma.volumeChapterPlan.findMany({ where: { volume: { novelId: novel.id } }, orderBy: { chapterOrder: "asc" } });
    console.log(JSON.stringify({ status: executed.status, outline: refreshed.outline, structuredOutline: refreshed.structuredOutline, chapters: finalChapters.map((chapter) => ({ order: chapter.order, title: chapter.title, content: chapter.content })), volumeOrders: volumePlans.map((chapter) => chapter.chapterOrder), existingId: existing.id }));
  } finally { await prisma.$disconnect(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
`, "utf8");
    const stdout = childProcess.execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
    assert.equal(result.status, "executed");
    assert.match(result.outline, /22 吃饭/);
    assert.deepEqual(result.chapters.map((chapter) => chapter.order), [22, 23, 24]);
    assert.equal(result.chapters.find((chapter) => chapter.order === 23).content, "不可删除的已有正文");
    assert.deepEqual(result.volumeOrders, [22, 23, 24]);
    assert.match(result.structuredOutline, /B调查/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
