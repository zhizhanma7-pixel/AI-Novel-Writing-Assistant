const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

function pnpmInvocation(args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", ...args],
    };
  }
  return { command: "pnpm", args };
}

function setupTempSqliteDatabase(tempDir) {
  const databasePath = path.join(tempDir, "change-proposal-acceptance.db");
  const relativeDatabasePath = path.relative(serverRoot, databasePath).replace(/\\/g, "/");
  if (relativeDatabasePath.startsWith("../")) {
    throw new Error(`Database escaped the server root: ${databasePath}`);
  }
  // Prisma's Windows schema engine does not reliably accept absolute SQLite URLs.
  // Both prisma:push and the runtime resolve this URL relative to serverRoot.
  const databaseUrl = `file:./${relativeDatabasePath}`;
  const invocation = pnpmInvocation(["--filter", "@ai-novel/server", "prisma:push"]);
  childProcess.execFileSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      // Prisma 7.4's Windows schema-engine can exit before its RPC server is ready
      // unless its informational logger is enabled.
      ...(process.platform === "win32" ? { RUST_LOG: "info" } : {}),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return databaseUrl;
}

function writeAcceptanceScript(tempDir) {
  const scriptPath = path.join(tempDir, "run-change-proposal-acceptance.cjs");
  const script = `
const path = require("node:path");

async function main() {
  const repoRoot = process.cwd();
  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const {
    ChangeProposalService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "application", "ChangeProposalService.js"));
  const {
    ChangeProposalReviewService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "application", "ChangeProposalReviewService.js"));
  const {
    ChangeProposalApplyService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "proposal", "application", "ChangeProposalApplyService.js"));

  try {
    const novel = await prisma.novel.create({ data: { title: "Proposal acceptance" } });
    const source = await prisma.character.create({
      data: { novelId: novel.id, name: "A", role: "lead" },
    });
    const target = await prisma.character.create({
      data: { novelId: novel.id, name: "B", role: "partner" },
    });
    const task = await prisma.novelWorkflowTask.create({
      data: {
        novelId: novel.id,
        lane: "auto_director",
        title: "Proposal acceptance task",
      },
    });
    await prisma.characterRelation.create({
      data: {
        novelId: novel.id,
        sourceCharacterId: source.id,
        targetCharacterId: target.id,
        surfaceRelation: "partners",
        trustScore: 62,
      },
    });

    const proposalService = new ChangeProposalService();
    const reviewService = new ChangeProposalReviewService(proposalService);
    const applyService = new ChangeProposalApplyService(proposalService);
    const created = await proposalService.createProposal(novel.id, {
      taskId: task.id,
      proposalType: "relationship_change",
      summary: "A and B trust weakens.",
      reasoningSummary: "Their confrontation changes what they are willing to share.",
      changes: [{
        proposalType: "relation_state_update",
        path: "Character.A.relationship.B.trust",
        operation: "replace",
        category: "relationship",
        severity: "major",
        before: 62,
        after: 52,
        payload: {
          sourceCharacterId: source.id,
          targetCharacterId: target.id,
          surfaceRelation: "partners",
          stageLabel: "guarded partnership",
          stageSummary: "They cooperate but hold back critical information.",
          trustScore: 52,
        },
        reason: "The confrontation lowers mutual trust.",
        sourceRefs: [],
        evidence: ["Both characters conceal their next move."],
      }],
    });
    const taskAfterCreate = await prisma.novelWorkflowTask.findUnique({
      where: { id: task.id },
    });
    await reviewService.editProposedChange(novel.id, created.id, created.changes[0].id, {
      expectedVersion: 1,
      after: 55,
    });
    const approved = await reviewService.approveProposal(novel.id, created.id, {
      expectedVersion: 1,
    });
    const executed = await applyService.executeProposal(novel.id, created.id);
    const relation = await prisma.characterRelation.findUnique({
      where: {
        novelId_sourceCharacterId_targetCharacterId: {
          novelId: novel.id,
          sourceCharacterId: source.id,
          targetCharacterId: target.id,
        },
      },
    });
    const stage = await prisma.characterRelationStage.findFirst({
      where: {
        novelId: novel.id,
        sourceCharacterId: source.id,
        targetCharacterId: target.id,
        isCurrent: true,
      },
    });
    const item = await prisma.stateChangeProposal.findUnique({
      where: { id: created.changes[0].id },
    });
    const artifact = await prisma.directorArtifact.findFirst({
      where: {
        novelId: novel.id,
        artifactType: "change_proposal",
        contentId: created.id,
      },
    });

    console.log(JSON.stringify({
      approvedStatus: approved.status,
      executedStatus: executed.status,
      relationTrustScore: relation?.trustScore ?? null,
      stageSourceType: stage?.sourceType ?? null,
      itemStatus: item?.status ?? null,
      itemPayload: item?.userEditedPayloadJson ? JSON.parse(item.userEditedPayloadJson) : null,
      artifactSource: artifact?.source ?? null,
      artifactProtected: artifact?.protectedUserContent ?? null,
      taskStatusAfterCreate: taskAfterCreate?.status ?? null,
      taskCheckpointAfterCreate: taskAfterCreate?.checkpointType ?? null,
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

function runAcceptanceScenario() {
  const tempRoot = path.resolve(serverRoot, ".tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "change-proposal-"));
  const resolvedTempDir = path.resolve(tempDir);
  if (!resolvedTempDir.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`Unsafe temp directory: ${resolvedTempDir}`);
  }
  try {
    const databaseUrl = setupTempSqliteDatabase(resolvedTempDir);
    const scriptPath = writeAcceptanceScript(resolvedTempDir);
    const stdout = childProcess.execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const jsonLine = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse()
      .find((line) => line.startsWith("{"));
    if (!jsonLine) {
      throw new Error(`Acceptance scenario did not return JSON. stdout=${stdout}`);
    }
    return JSON.parse(jsonLine);
  } finally {
    fs.rmSync(resolvedTempDir, { recursive: true, force: true });
  }
}

test("relationship proposal writes only the user-edited trust value on real SQLite", () => {
  const result = runAcceptanceScenario();

  assert.equal(result.approvedStatus, "approved");
  assert.equal(result.executedStatus, "executed");
  assert.equal(result.relationTrustScore, 55);
  assert.equal(result.stageSourceType, "change_proposal");
  assert.equal(result.itemStatus, "committed");
  assert.equal(result.itemPayload.trustScore, 55);
  assert.equal(result.artifactSource, "user_edited");
  assert.equal(result.artifactProtected, true);
  assert.equal(result.taskStatusAfterCreate, "waiting_approval");
  assert.equal(result.taskCheckpointAfterCreate, "proposal_review_required");
});
