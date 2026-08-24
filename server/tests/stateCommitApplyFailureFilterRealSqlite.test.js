const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRoot = path.resolve(repoRoot, "server");

// Combination smoke: a REAL StateCommitService.proposeAndCommit run mixing a
// routine validation rejection (empty summary, rejected before any DB write)
// with a real legacy apply-domain rejection (character_not_found, rejected
// after a real failed applier attempt) in the same batch. Feeds the actual
// stateCommitResult.rejected produced by that run into the real, unmocked
// filterLegacyApplyFailureProposals(). This is the seam
// CODE_REVIEW_STATE_APPLY_OBSERVABILITY.md's L1 flagged: the existing
// chapterRuntimeCoordinator.test.js case only feeds the filter a hand-typed
// rejected array, so it can't catch a mismatch between what StateCommitService
// actually produces and what the filter expects.

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
  const databasePath = path.join(tempDir, "state-commit-apply-failure-filter.db");
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
  const scriptPath = path.join(tempDir, "run-state-commit-apply-failure-filter-smoke.cjs");
  const script = `
const path = require("node:path");

async function main() {
  const repoRoot = process.cwd();
  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const {
    stateCommitService,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "state", "StateCommitService.js"));
  const {
    filterLegacyApplyFailureProposals,
  } = require(path.join(repoRoot, "server", "dist", "services", "novel", "runtime", "ChapterArtifactDeltaService.js"));

  try {
    const novel = await prisma.novel.create({ data: { title: "Apply-failure filter smoke" } });
    const dana = await prisma.character.create({
      data: { novelId: novel.id, name: "Dana", role: "supporting" },
    });

    const routineInvalid = {
      novelId: novel.id,
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "character_state_update",
      riskLevel: "low",
      summary: "",
      payload: { characterId: dana.id, currentState: "should never be applied" },
      evidence: [],
      validationNotes: [],
    };
    const legacyDirty = {
      novelId: novel.id,
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "character_state_update",
      riskLevel: "low",
      summary: "Dana's condition worsens after the ambush.",
      payload: { characterId: "missing-character-00000000", currentState: "wounded" },
      evidence: ["Dana clutches her side after the fight."],
      validationNotes: [],
    };
    const valid = {
      novelId: novel.id,
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "character_state_update",
      riskLevel: "low",
      summary: "Dana grows more determined after the ambush.",
      payload: { characterId: dana.id, currentState: "determined", currentGoal: "protect the caravan" },
      evidence: ["Dana grits her teeth and presses on."],
      validationNotes: [],
    };

    const result = await stateCommitService.proposeAndCommit({
      novelId: novel.id,
      chapterId: null,
      chapterOrder: 1,
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      skipFactExtraction: true,
      proposals: [routineInvalid, legacyDirty, valid],
    });

    const filtered = filterLegacyApplyFailureProposals(result.rejected);
    const danaAfter = await prisma.character.findUnique({ where: { id: dana.id } });

    console.log(JSON.stringify({
      rejectedCount: result.rejected.length,
      rejectedNotesById: Object.fromEntries(
        result.rejected.map((proposal) => [proposal.id, proposal.validationNotes]),
      ),
      filteredCount: filtered.length,
      filteredNotes: filtered.map((proposal) => proposal.validationNotes),
      committedCount: result.committed.length,
      danaCurrentState: danaAfter ? danaAfter.currentState : null,
      danaCurrentGoal: danaAfter ? danaAfter.currentGoal : null,
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
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "state-commit-apply-failure-filter-"));
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

test("routine validation rejection is excluded from the real apply-failure filter output; legacy apply rejection is kept", () => {
  const result = runSmokeScenario();

  assert.equal(result.rejectedCount, 2);
  assert.equal(result.filteredCount, 1);

  const filteredNotes = result.filteredNotes[0] || [];
  assert.equal(
    filteredNotes.some((note) => note.startsWith("legacy_apply_failed:character_state_update:character_not_found:")),
    true,
  );
  assert.equal(
    Object.values(result.rejectedNotesById).some((notes) => notes.includes("missing summary")),
    true,
  );

  assert.equal(result.committedCount, 1);
  assert.equal(result.danaCurrentState, "determined");
  assert.equal(result.danaCurrentGoal, "protect the caravan");
});
