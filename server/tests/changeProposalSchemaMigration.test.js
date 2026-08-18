const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const prismaRoot = path.join(__dirname, "..", "src", "prisma");
const sqliteMigrationPath = path.join(
  prismaRoot,
  "migrations.sqlite",
  "20260819003000_change_proposal_core",
  "migration.sql",
);

test("change proposal SQLite migration creates the envelope, item fields, indexes, and foreign keys", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE "Novel" ("id" TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "Chapter" ("id" TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "NovelWorkflowTask" ("id" TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "StateChangeProposal" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "status" TEXT NOT NULL
      );
    `);
    database.exec(fs.readFileSync(sqliteMigrationPath, "utf8"));

    const proposalColumns = new Set(
      database.prepare('PRAGMA table_info("ChangeProposal")').all().map((column) => column.name),
    );
    assert.ok(proposalColumns.has("version"));
    assert.ok(proposalColumns.has("reasoningSummary"));
    assert.ok(proposalColumns.has("sourceRefsJson"));
    assert.ok(proposalColumns.has("expectedStateJson"));

    const itemColumns = new Set(
      database.prepare('PRAGMA table_info("StateChangeProposal")').all().map((column) => column.name),
    );
    for (const column of [
      "changeProposalId",
      "changePath",
      "operation",
      "category",
      "severity",
      "beforeJson",
      "afterJson",
      "userEditedPayloadJson",
      "reviewDecision",
      "sourceRefsJson",
    ]) {
      assert.ok(itemColumns.has(column), `expected StateChangeProposal.${column}`);
    }

    const indexes = new Set(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name),
    );
    assert.ok(indexes.has("ChangeProposal_novelId_status_updatedAt_idx"));
    assert.ok(indexes.has("StateChangeProposal_changeProposalId_status_idx"));

    const itemForeignKeys = database.prepare('PRAGMA foreign_key_list("StateChangeProposal")').all();
    assert.ok(itemForeignKeys.some((foreignKey) => (
      foreignKey.table === "ChangeProposal" && foreignKey.from === "changeProposalId"
    )));
  } finally {
    database.close();
  }
});

test("PostgreSQL and SQLite Prisma schemas keep ChangeProposal fields in sync", () => {
  const postgresSchema = fs.readFileSync(path.join(prismaRoot, "schema.prisma"), "utf8");
  const sqliteSchema = fs.readFileSync(path.join(prismaRoot, "schema.sqlite.prisma"), "utf8");
  const requiredPatterns = [
    /model ChangeProposal \{/,
    /version\s+Int\s+@default\(1\)/,
    /reasoningSummary\s+String\?/,
    /changeProposalId\s+String\?/,
    /userEditedPayloadJson\s+String\?/,
    /reviewDecision\s+String\?/,
  ];

  for (const pattern of requiredPatterns) {
    assert.match(postgresSchema, pattern);
    assert.match(sqliteSchema, pattern);
  }
});
