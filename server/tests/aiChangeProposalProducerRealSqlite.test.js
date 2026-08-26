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
  const databasePath = path.join(tempDir, "ai-proposal-producer.db");
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

function writeScenarioScript(tempDir) {
  const scriptPath = path.join(tempDir, "run-ai-proposal-producer.cjs");
  const script = `
const path = require("node:path");

async function main() {
  const repoRoot = process.cwd();
  const { prisma } = require(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const { DirectorRuntimeService } = require(path.join(repoRoot, "server", "dist", "services", "novel", "director", "runtime", "DirectorRuntimeService.js"));
  const { getAgentToolDefinition } = require(path.join(repoRoot, "server", "dist", "agents", "toolRegistry.js"));

  try {
    const novel = await prisma.novel.create({ data: { title: "AI proposal policy acceptance" } });
    const source = await prisma.character.create({
      data: { novelId: novel.id, name: "A", role: "lead" },
    });
    const target = await prisma.character.create({
      data: { novelId: novel.id, name: "B", role: "partner" },
    });
    await prisma.characterRelation.create({
      data: {
        novelId: novel.id,
        sourceCharacterId: source.id,
        targetCharacterId: target.id,
        surfaceRelation: "partners",
        trustScore: 50,
      },
    });
    const l3Task = await prisma.novelWorkflowTask.create({
      data: { novelId: novel.id, lane: "auto_director", title: "L3 proposal task" },
    });
    const defaultTask = await prisma.novelWorkflowTask.create({
      data: { novelId: novel.id, lane: "auto_director", title: "Default proposal task" },
    });
    const runtime = new DirectorRuntimeService();
    await runtime.initializeRun({
      taskId: l3Task.id,
      novelId: novel.id,
      entrypoint: "ai_change_proposal_test",
      policyMode: "auto_safe_scope",
    });
    await runtime.initializeRun({
      taskId: defaultTask.id,
      novelId: novel.id,
      entrypoint: "ai_change_proposal_test",
      policyMode: "run_until_gate",
    });
    await runtime.updatePolicy({
      taskId: l3Task.id,
      mode: "auto_safe_scope",
      patch: { proposalAutonomyLevel: "L3" },
    });

    const proposalTool = getAgentToolDefinition("propose_novel_change");
    const toolContext = {
      runId: "ai-proposal-real-sqlite",
      agentName: "Planner",
      contextMode: "novel",
      novelId: novel.id,
    };
    function proposalInput(taskId, severity, trustScore, summary) {
      return {
        taskId,
        proposalType: "relationship_change",
        outlineFidelity: "balanced",
        summary,
        reasoningSummary: "The latest structured story state changes mutual trust.",
        sourceRefs: [],
        warnings: [],
        changes: [{
          proposalType: "relation_state_update",
          path: "Character.A.relationship.B.trust",
          operation: "replace",
          category: "relationship",
          severity,
          before: 50,
          after: trustScore,
          payload: {
            sourceCharacterId: source.id,
            targetCharacterId: target.id,
            surfaceRelation: "partners",
            stageLabel: "changing trust",
            stageSummary: summary,
            trustScore,
          },
          reason: summary,
          sourceRefs: [],
          evidence: ["Structured state evidence"],
        }],
      };
    }

    const defaultMinor = await proposalTool.execute(
      toolContext,
      { novelId: novel.id, ...proposalInput(defaultTask.id, "minor", 55, "A small default-path trust improvement.") },
    );
    const relationAfterDefault = await prisma.characterRelation.findUnique({
      where: {
        novelId_sourceCharacterId_targetCharacterId: {
          novelId: novel.id,
          sourceCharacterId: source.id,
          targetCharacterId: target.id,
        },
      },
    });
    const l3Minor = await proposalTool.execute(
      toolContext,
      { novelId: novel.id, ...proposalInput(l3Task.id, "minor", 55, "A small trust improvement.") },
    );
    const relationAfterMinor = await prisma.characterRelation.findUnique({
      where: {
        novelId_sourceCharacterId_targetCharacterId: {
          novelId: novel.id,
          sourceCharacterId: source.id,
          targetCharacterId: target.id,
        },
      },
    });
    const l3Major = await proposalTool.execute(
      toolContext,
      { novelId: novel.id, ...proposalInput(l3Task.id, "minor", 10, "A large relationship break under-reported as minor.") },
    );
    const relationAfterGates = await prisma.characterRelation.findUnique({
      where: {
        novelId_sourceCharacterId_targetCharacterId: {
          novelId: novel.id,
          sourceCharacterId: source.id,
          targetCharacterId: target.id,
        },
      },
    });
    const [l3TaskAfter, defaultTaskAfter] = await Promise.all([
      prisma.novelWorkflowTask.findUnique({ where: { id: l3Task.id } }),
      prisma.novelWorkflowTask.findUnique({ where: { id: defaultTask.id } }),
    ]);

    console.log(JSON.stringify({
      defaultMinorDisposition: defaultMinor.disposition,
      defaultMinorStatus: defaultMinor.proposal.status,
      defaultMinorAutonomy: defaultMinor.autonomyLevel,
      defaultDirectorMode: defaultMinor.directorPolicyMode,
      trustAfterDefault: relationAfterDefault?.trustScore ?? null,
      l3MinorDisposition: l3Minor.disposition,
      l3MinorStatus: l3Minor.proposal.status,
      l3MinorAutonomy: l3Minor.autonomyLevel,
      trustAfterMinor: relationAfterMinor?.trustScore ?? null,
      l3MajorDisposition: l3Major.disposition,
      l3MajorStatus: l3Major.proposal.status,
      trustAfterGates: relationAfterGates?.trustScore ?? null,
      l3TaskCheckpoint: l3TaskAfter?.checkpointType ?? null,
      defaultTaskCheckpoint: defaultTaskAfter?.checkpointType ?? null,
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
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "ai-proposal-producer-"));
  const resolvedTempDir = path.resolve(tempDir);
  if (!resolvedTempDir.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`Unsafe temp directory: ${resolvedTempDir}`);
  }
  try {
    const databaseUrl = setupTempSqliteDatabase(resolvedTempDir);
    const scriptPath = writeScenarioScript(resolvedTempDir);
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
      throw new Error(`AI proposal scenario did not return JSON. stdout=${stdout}`);
    }
    return JSON.parse(jsonLine);
  } finally {
    fs.rmSync(resolvedTempDir, { recursive: true, force: true });
  }
}

test("AI proposal producer enforces L1/L3 policy on real SQLite", () => {
  const result = runScenario();

  assert.equal(result.defaultMinorDisposition, "pending_review");
  assert.equal(result.defaultMinorStatus, "pending_review");
  assert.equal(result.defaultMinorAutonomy, "L1");
  assert.equal(result.defaultDirectorMode, "run_until_gate");
  assert.equal(result.trustAfterDefault, 50);
  assert.equal(result.l3MinorDisposition, "executed");
  assert.equal(result.l3MinorStatus, "executed");
  assert.equal(result.l3MinorAutonomy, "L3");
  assert.equal(result.trustAfterMinor, 55);
  assert.equal(result.l3MajorDisposition, "pending_review");
  assert.equal(result.l3MajorStatus, "pending_review");
  assert.equal(result.trustAfterGates, 55);
  assert.equal(result.l3TaskCheckpoint, "proposal_review_required");
  assert.equal(result.defaultTaskCheckpoint, "proposal_review_required");
});
