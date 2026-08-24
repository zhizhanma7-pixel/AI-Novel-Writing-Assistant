const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

// Combination smoke: a dirty legacy pending-review item, promoted through the
// REAL auto-promotion path (not mocked StateCommitService / ledger deps),
// must surface as commitResult.rejected + a medium-severity DirectorEvent
// with rejectedCount, alongside a clean sibling item that commits normally.
// This is the seam CODE_REVIEW_STATE_APPLY_OBSERVABILITY.md's O2 covered
// with a hand-mocked commitExistingProposals; here the classification is
// produced by the real applier + real ledger write.

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
  const databasePath = path.join(tempDir, "pending-review-auto-promotion.db");
  const relativeDatabasePath = path.relative(serverRoot, databasePath).replace(/\\/g, "/");
  if (relativeDatabasePath.startsWith("../")) {
    throw new Error(`Database escaped the server root: ${databasePath}`);
  }
  const databaseUrl = `file:./${relativeDatabasePath}`;
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

function writeSmokeScript(tempDir) {
  const scriptPath = path.join(tempDir, "run-pending-review-auto-promotion-smoke.cjs");
  const script = `
const path = require("node:path");

async function main() {
  const repoRoot = process.cwd();
  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const {
    pendingReviewAutoPromotionService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "state", "PendingReviewAutoPromotionService.js"));

  try {
    const novel = await prisma.novel.create({ data: { title: "Auto-promotion smoke" } });
    const alice = await prisma.character.create({
      data: { novelId: novel.id, name: "Alice", role: "lead" },
    });
    const carol = await prisma.character.create({
      data: { novelId: novel.id, name: "Carol", role: "supporting" },
    });

    const createdAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    function seedRow(overrides) {
      return prisma.stateChangeProposal.create({
        data: {
          novelId: novel.id,
          chapterId: null,
          sourceType: "chapter_background_sync",
          sourceStage: "chapter_execution",
          proposalType: "relation_state_update",
          riskLevel: "medium",
          status: "pending_review",
          changeProposalId: null,
          summary: overrides.summary,
          payloadJson: JSON.stringify(overrides.payload),
          evidenceJson: JSON.stringify(["Alice and " + overrides.targetLabel + " talk after the ambush."]),
          validationNotesJson: JSON.stringify([]),
          createdAt,
          updatedAt: createdAt,
        },
      });
    }

    const validProposal = await seedRow({
      summary: "Alice and Carol grow closer after the ambush.",
      targetLabel: "Carol",
      payload: {
        sourceCharacterId: alice.id,
        targetCharacterId: carol.id,
        surfaceRelation: "allies",
        trustScore: 40,
      },
    });
    const dirtyProposal = await seedRow({
      summary: "Alice reconsiders trusting a stranger from the ambush.",
      targetLabel: "the stranger",
      payload: {
        sourceCharacterId: alice.id,
        targetCharacterId: "missing-character-00000000",
        surfaceRelation: "wary",
        trustScore: 10,
      },
    });

    const result = await pendingReviewAutoPromotionService.apply(novel.id, {
      since: since.toISOString(),
      dryRun: false,
      eligibleAfterDays: 14,
      runLimit: 50,
    });

    const dirtyRow = await prisma.stateChangeProposal.findUnique({ where: { id: dirtyProposal.id } });
    const validRow = await prisma.stateChangeProposal.findUnique({ where: { id: validProposal.id } });
    const relation = await prisma.characterRelation.findUnique({
      where: {
        novelId_sourceCharacterId_targetCharacterId: {
          novelId: novel.id,
          sourceCharacterId: alice.id,
          targetCharacterId: carol.id,
        },
      },
    });
    const ledgerEvent = await prisma.directorEvent.findFirst({
      where: { novelId: novel.id, type: "pending_review_auto_promotion" },
      orderBy: { occurredAt: "desc" },
    });

    console.log(JSON.stringify({
      commitResultRejectedCount: result.commitResult ? result.commitResult.rejected.length : null,
      commitResultCommittedCount: result.commitResult ? result.commitResult.committed.length : null,
      dirtyRowStatus: dirtyRow ? dirtyRow.status : null,
      dirtyRowNotes: dirtyRow ? JSON.parse(dirtyRow.validationNotesJson || "[]") : null,
      validRowStatus: validRow ? validRow.status : null,
      relationTrustScore: relation ? relation.trustScore : null,
      ledgerEventFound: Boolean(ledgerEvent),
      ledgerEventSeverity: ledgerEvent ? ledgerEvent.severity : null,
      ledgerEventSummary: ledgerEvent ? ledgerEvent.summary : null,
      ledgerEventMetadata: ledgerEvent ? JSON.parse(ledgerEvent.metadataJson || "{}") : null,
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

function runSmokeScenario() {
  const tempRoot = path.resolve(serverRoot, ".tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "pending-review-auto-promotion-"));
  const resolvedTempDir = path.resolve(tempDir);
  if (!resolvedTempDir.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`Unsafe temp directory: ${resolvedTempDir}`);
  }
  try {
    const databaseUrl = setupTempSqliteDatabase(resolvedTempDir);
    const scriptPath = writeSmokeScript(resolvedTempDir);
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
      throw new Error(`Smoke scenario did not return JSON. stdout=${stdout}`);
    }
    return JSON.parse(jsonLine);
  } finally {
    fs.rmSync(resolvedTempDir, { recursive: true, force: true });
  }
}

test("dirty legacy pending-review item produces rejectedCount + medium ledger event on real SQLite", () => {
  const result = runSmokeScenario();

  assert.equal(result.commitResultCommittedCount, 1);
  assert.equal(result.commitResultRejectedCount, 1);

  assert.equal(result.dirtyRowStatus, "rejected");
  assert.equal(
    result.dirtyRowNotes.some((note) => note.startsWith("legacy_apply_failed:relation_state_update:character_outside_novel:")),
    true,
  );

  assert.equal(result.validRowStatus, "committed");
  assert.equal(result.relationTrustScore, 40);

  assert.equal(result.ledgerEventFound, true);
  assert.equal(result.ledgerEventSeverity, "medium");
  assert.match(result.ledgerEventSummary, /其中 1 条因数据问题被拒绝/);
  assert.equal(result.ledgerEventMetadata.rejectedCount, 1);
  assert.equal(result.ledgerEventMetadata.promotedIds.length, 1);
});
