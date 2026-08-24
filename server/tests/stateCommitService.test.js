const test = require("node:test");
const assert = require("node:assert/strict");

const {
  StateCommitService,
} = require("../dist/services/novel/state/StateCommitService.js");
const { prisma } = require("../dist/db/prisma.js");
const { canonicalStateService } = require("../dist/services/novel/state/CanonicalStateService.js");
const { stateVersionLog } = require("../dist/services/novel/state/StateVersionLog.js");
const {
  applyStateChangeProposal,
} = require("../dist/services/novel/state/StateProposalApplierRegistry.js");
const {
  StateProposalDomainError,
} = require("../dist/services/novel/state/StateProposalDomainError.js");

function makeResourceProposal(overrides = {}) {
  const { payload: payloadOverrides = {}, ...proposalOverrides } = overrides;
  return {
    novelId: "novel-1",
    chapterId: "chapter-5",
    sourceSnapshotId: null,
    sourceType: "chapter_background_sync",
    sourceStage: "chapter_execution",
    proposalType: "character_resource_update",
    riskLevel: "low",
    status: "validated",
    summary: "hero acquires the service tunnel key",
    payload: {
      resourceKey: "service_tunnel_key:char-1",
      resourceName: "service tunnel key",
      chapterOrder: 5,
      resourceType: "credential",
      narrativeFunction: "key",
      updateType: "acquired",
      ownerType: "character",
      ownerId: "char-1",
      ownerName: "Hero",
      holderCharacterId: "char-1",
      holderCharacterName: "Hero",
      statusAfter: "available",
      visibilityAfter: {
        readerKnows: true,
        holderKnows: true,
        knownByCharacterIds: ["char-1"],
      },
      narrativeImpact: "Hero can enter the service tunnel but cannot bypass the vault door.",
      expectedFutureUse: "reach the underground corridor",
      constraints: ["only opens the service tunnel"],
      confidence: 0.86,
      ...payloadOverrides,
    },
    evidence: ["Hero puts the service tunnel key in his inner pocket."],
    validationNotes: [],
    ...proposalOverrides,
  };
}

test("state proposal appliers expose stable typed domain reasons", async () => {
  const baseProposal = {
    novelId: "novel-1",
    chapterId: "chapter-5",
    sourceSnapshotId: null,
    sourceType: "chapter_background_sync",
    sourceStage: "chapter_execution",
    riskLevel: "low",
    status: "committed",
    summary: "typed domain error fixture",
    evidence: ["fixture evidence"],
    validationNotes: [],
  };
  const expectReason = async (proposal, tx, expectedReason) => {
    await assert.rejects(
      applyStateChangeProposal(tx, proposal),
      (error) => {
        assert.ok(error instanceof StateProposalDomainError);
        assert.equal(error.proposalType, proposal.proposalType);
        assert.equal(error.reason, expectedReason);
        return true;
      },
    );
  };

  await expectReason({
    ...baseProposal,
    proposalType: "character_state_update",
    payload: {},
  }, {}, "missing_character_id");
  await expectReason({
    ...baseProposal,
    proposalType: "character_state_update",
    payload: { characterId: "missing-character" },
  }, {
    character: { updateMany: async () => ({ count: 0 }) },
  }, "character_not_found");
  await expectReason({
    ...baseProposal,
    proposalType: "relation_state_update",
    payload: { sourceCharacterId: "character-1" },
  }, {}, "invalid_payload");
  await expectReason({
    ...baseProposal,
    proposalType: "relation_state_update",
    payload: { sourceCharacterId: "character-1", targetCharacterId: "character-1" },
  }, {}, "same_character_relation");
  await expectReason({
    ...baseProposal,
    proposalType: "relation_state_update",
    payload: { sourceCharacterId: "character-1", targetCharacterId: "character-2" },
  }, {
    character: { count: async () => 1 },
  }, "character_outside_novel");
  await expectReason({
    ...baseProposal,
    proposalType: "character_resource_update",
    payload: {},
  }, {}, "invalid_payload");
});

test("StateCommitService validate auto-commits low-risk runtime updates", () => {
  const service = new StateCommitService();
  const result = service.validate([
    {
      novelId: "novel-1",
      chapterId: "chapter-5",
      sourceSnapshotId: "snapshot-5",
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "character_state_update",
      riskLevel: "low",
      status: "validated",
      summary: "hero state advanced",
      payload: {
        characterId: "char-1",
        currentState: "takes initiative",
        currentGoal: "push the counterattack",
      },
      evidence: ["hero finally starts moving"],
      validationNotes: [],
    },
  ]);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.pendingReview.length, 0);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0].status, "committed");
});

test("StateCommitService validate routes debt runtime updates into pending review", () => {
  const service = new StateCommitService();
  const result = service.validate([
    {
      novelId: "novel-1",
      chapterId: "chapter-5",
      sourceSnapshotId: "snapshot-5",
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "character_state_update",
      riskLevel: "low",
      status: "validated",
      sourceQuality: "debt",
      summary: "hero state advanced from degraded chapter content",
      payload: {
        characterId: "char-1",
        currentState: "takes initiative",
        currentGoal: "push the counterattack",
      },
      evidence: ["hero finally starts moving"],
      validationNotes: [],
    },
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.pendingReview[0].status, "pending_review");
  assert.match(result.pendingReview[0].validationNotes.join(" "), /source_quality:debt/);
  assert.match(result.pendingReview[0].validationNotes.join(" "), /quality debt source requires manual review/);
});

test("StateCommitService validate auto-commits low-risk character resource updates", () => {
  const service = new StateCommitService();
  const result = service.validate([makeResourceProposal()]);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.pendingReview.length, 0);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0].status, "committed");
});

test("StateCommitService validate auto-commits medium background character resource updates", () => {
  const service = new StateCommitService();
  const result = service.validate([
    makeResourceProposal({
      riskLevel: "medium",
      payload: {
        narrativeImpact: "Hero can use the marked sword in the next escape beat.",
      },
    }),
  ]);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.pendingReview.length, 0);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0].status, "committed");
  assert.match(result.accepted[0].validationNotes.join(" "), /auto-committed background resource update/);
});

test("StateCommitService validate routes debt resource updates around background auto-commit", () => {
  const service = new StateCommitService();
  const result = service.validate([
    makeResourceProposal({
      riskLevel: "medium",
      sourceQuality: "debt",
      payload: {
        narrativeImpact: "Hero can use the marked sword in the next escape beat.",
      },
    }),
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.pendingReview[0].status, "pending_review");
  assert.match(result.pendingReview[0].validationNotes.join(" "), /source_quality:debt/);
});

test("StateCommitService validate routes manual medium character resource updates into pending review", () => {
  const service = new StateCommitService();
  const result = service.validate([
    makeResourceProposal({
      sourceType: "manual_resource_extract",
      riskLevel: "medium",
    }),
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.pendingReview[0].status, "pending_review");
});

test("StateCommitService validate routes risky character resource updates into pending review", () => {
  const service = new StateCommitService();
  const result = service.validate([
    makeResourceProposal({
      riskLevel: "high",
      payload: {
        resourceName: "villain hidden ledger",
        narrativeFunction: "hidden_card",
        updateType: "destroyed",
        statusAfter: "destroyed",
        confidence: 0.42,
        narrativeImpact: "The villain loses a core blackmail resource.",
      },
    }),
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.pendingReview[0].status, "pending_review");
  assert.match(result.pendingReview[0].validationNotes.join(" "), /low confidence|manual review/);
});

test("StateCommitService validate rejects character resource updates without evidence", () => {
  const service = new StateCommitService();
  const result = service.validate([
    makeResourceProposal({
      evidence: [],
    }),
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].validationNotes.join(" "), /missing evidence/);
});

test("StateCommitService validate routes disclosure and relation drift into pending review", () => {
  const service = new StateCommitService();
  const result = service.validate([
    {
      novelId: "novel-1",
      chapterId: "chapter-5",
      sourceSnapshotId: "snapshot-5",
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "information_disclosure",
      riskLevel: "medium",
      status: "validated",
      summary: "reader now knows the hidden employer",
      payload: {
        fact: "the employer is the prince",
      },
      evidence: ["the reveal is on page"],
      validationNotes: [],
    },
    {
      novelId: "novel-1",
      chapterId: "chapter-5",
      sourceSnapshotId: "snapshot-5",
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "relation_state_update",
      riskLevel: "medium",
      status: "validated",
      summary: "trust shifts between leads",
      payload: {
        sourceCharacterId: "char-1",
        targetCharacterId: "char-2",
      },
      evidence: ["they finally exchange the evidence"],
      validationNotes: [],
    },
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 2);
  assert.equal(result.rejected.length, 0);
  assert.deepEqual(
    result.pendingReview.map((item) => item.status),
    ["pending_review", "pending_review"],
  );
});

test("StateCommitService validate rejects malformed character updates", () => {
  const service = new StateCommitService();
  const result = service.validate([
    {
      novelId: "novel-1",
      chapterId: "chapter-5",
      sourceSnapshotId: "snapshot-5",
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "character_state_update",
      riskLevel: "low",
      status: "validated",
      summary: "missing character id",
      payload: {
        currentState: "unstable",
      },
      evidence: [],
      validationNotes: [],
    },
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].validationNotes.join(" "), /missing characterId/);
});

test("StateCommitService conflict check routes holder mismatch into pending review", async () => {
  const service = new StateCommitService();
  const originalFindUnique = prisma.characterResourceLedgerItem.findUnique;

  try {
    prisma.characterResourceLedgerItem.findUnique = async () => ({
      holderCharacterId: "char-9",
      ownerCharacterId: "char-1",
      status: "available",
      readerKnows: true,
      holderKnows: true,
    });

    const validation = service.validate([
      makeResourceProposal({
        payload: {
          updateType: "transferred",
          previousHolderCharacterId: "char-1",
          holderCharacterId: "char-2",
          ownerId: "char-1",
        },
      }),
    ]);
    const checked = await service.applyCharacterResourceConflictChecks("novel-1", validation);

    assert.equal(checked.accepted.length, 0);
    assert.equal(checked.pendingReview.length, 1);
    assert.equal(checked.pendingReview[0].status, "pending_review");
    assert.equal(checked.pendingReview[0].riskLevel, "high");
    assert.match(checked.pendingReview[0].validationNotes.join(" "), /resource_conflict/);
  } finally {
    prisma.characterResourceLedgerItem.findUnique = originalFindUnique;
  }
});

test("StateCommitService commitExistingProposals applies ledger update and writes committed version", async () => {
  const service = new StateCommitService();
  const now = new Date();
  const proposalRow = {
    id: "proposal-1",
    novelId: "novel-1",
    chapterId: "chapter-5",
    sourceSnapshotId: null,
    sourceType: "manual_resource_extract",
    sourceStage: "chapter_resource_review",
    proposalType: "character_resource_update",
    riskLevel: "medium",
    status: "pending_review",
    summary: "confirm resource update",
    payloadJson: JSON.stringify(makeResourceProposal().payload),
    evidenceJson: JSON.stringify(["Hero puts the service tunnel key in his inner pocket."]),
    validationNotesJson: JSON.stringify(["medium risk resource update"]),
    createdAt: now,
    updatedAt: now,
  };
  const calls = {
    upsert: 0,
    eventCreate: 0,
    proposalUpdate: 0,
    updateMany: 0,
    version: 0,
  };
  const originals = {
    proposalFindMany: prisma.stateChangeProposal.findMany,
    transaction: prisma.$transaction,
    proposalUpdateMany: prisma.stateChangeProposal.updateMany,
    getSnapshot: canonicalStateService.getSnapshot,
    createVersion: stateVersionLog.createVersion,
  };

  try {
    prisma.stateChangeProposal.findMany = async () => [proposalRow];
    prisma.$transaction = async (callback) => callback({
      characterResourceLedgerItem: {
        findUnique: async () => null,
        upsert: async () => {
          calls.upsert += 1;
          return { id: "resource-1" };
        },
      },
      characterResourceEvent: {
        create: async () => {
          calls.eventCreate += 1;
        },
      },
      stateChangeProposal: {
        update: async (args) => {
          calls.proposalUpdate += 1;
          assert.equal(args.where.id, "proposal-1");
          assert.equal(args.data.status, "committed");
        },
      },
    });
    prisma.stateChangeProposal.updateMany = async (args) => {
      calls.updateMany += 1;
      assert.deepEqual(args.where.id.in, ["proposal-1"]);
      assert.equal(args.data.committedVersionId, "version-1");
    };
    canonicalStateService.getSnapshot = async () => ({ novelId: "novel-1", snapshot: true });
    stateVersionLog.createVersion = async (input) => {
      calls.version += 1;
      assert.deepEqual(input.acceptedProposalIds, ["proposal-1"]);
      return { id: "version-1" };
    };

    const result = await service.commitExistingProposals({
      novelId: "novel-1",
      proposalIds: ["proposal-1"],
      chapterId: "chapter-5",
      chapterOrder: 5,
      reason: "test_confirm",
    });

    assert.equal(result.committed.length, 1);
    assert.equal(result.versionRecord.id, "version-1");
    assert.deepEqual(calls, {
      upsert: 1,
      eventCreate: 1,
      proposalUpdate: 1,
      updateMany: 1,
      version: 1,
    });
  } finally {
    prisma.stateChangeProposal.findMany = originals.proposalFindMany;
    prisma.$transaction = originals.transaction;
    prisma.stateChangeProposal.updateMany = originals.proposalUpdateMany;
    canonicalStateService.getSnapshot = originals.getSnapshot;
    stateVersionLog.createVersion = originals.createVersion;
  }
});

test("StateCommitService rejects an invalid legacy item without blocking valid legacy commits", async () => {
  const service = new StateCommitService();
  const now = new Date();
  const invalidRow = {
    id: "proposal-invalid-character",
    novelId: "novel-1",
    chapterId: "chapter-5",
    sourceSnapshotId: null,
    sourceType: "chapter_background_sync",
    sourceStage: "chapter_execution",
    proposalType: "character_state_update",
    riskLevel: "low",
    status: "pending_review",
    summary: "update a deleted character",
    payloadJson: JSON.stringify({ characterId: "deleted-character", currentState: "missing" }),
    evidenceJson: JSON.stringify(["legacy evidence"]),
    validationNotesJson: JSON.stringify([]),
    changeProposalId: null,
    createdAt: now,
    updatedAt: now,
  };
  const validRow = {
    id: "proposal-valid-resource",
    novelId: "novel-1",
    chapterId: "chapter-5",
    sourceSnapshotId: null,
    sourceType: "manual_resource_extract",
    sourceStage: "chapter_resource_review",
    proposalType: "character_resource_update",
    riskLevel: "medium",
    status: "pending_review",
    summary: "confirm resource update",
    payloadJson: JSON.stringify(makeResourceProposal().payload),
    evidenceJson: JSON.stringify(["Hero keeps the key."]),
    validationNotesJson: JSON.stringify([]),
    changeProposalId: null,
    createdAt: now,
    updatedAt: now,
  };
  const rejectedUpdates = [];
  const committedUpdates = [];
  const originals = {
    proposalFindMany: prisma.stateChangeProposal.findMany,
    proposalUpdate: prisma.stateChangeProposal.update,
    transaction: prisma.$transaction,
    proposalUpdateMany: prisma.stateChangeProposal.updateMany,
    getSnapshot: canonicalStateService.getSnapshot,
    createVersion: stateVersionLog.createVersion,
  };

  try {
    prisma.stateChangeProposal.findMany = async () => [invalidRow, validRow];
    prisma.stateChangeProposal.update = async (args) => {
      rejectedUpdates.push(args);
      return { ...invalidRow, ...args.data };
    };
    prisma.$transaction = async (callback) => callback({
      character: {
        updateMany: async () => ({ count: 0 }),
      },
      characterResourceLedgerItem: {
        findUnique: async () => null,
        upsert: async () => ({ id: "resource-1" }),
      },
      characterResourceEvent: {
        create: async () => ({ id: "event-1" }),
      },
      stateChangeProposal: {
        update: async (args) => {
          committedUpdates.push(args);
          return { ...validRow, ...args.data };
        },
      },
    });
    prisma.stateChangeProposal.updateMany = async (args) => {
      assert.deepEqual(args.where.id.in, ["proposal-valid-resource"]);
      return { count: 1 };
    };
    canonicalStateService.getSnapshot = async () => ({ novelId: "novel-1" });
    stateVersionLog.createVersion = async (input) => {
      assert.deepEqual(input.acceptedProposalIds, ["proposal-valid-resource"]);
      return { id: "version-legacy" };
    };

    const result = await service.commitExistingProposals({
      novelId: "novel-1",
      proposalIds: [invalidRow.id, validRow.id],
      chapterId: "chapter-5",
      chapterOrder: 5,
      reason: "legacy_batch",
    });

    assert.deepEqual(result.committed.map((proposal) => proposal.id), [validRow.id]);
    assert.deepEqual(result.rejected.map((proposal) => proposal.id), [invalidRow.id]);
    assert.match(
      result.rejected[0].validationNotes.join(" "),
      /legacy_apply_failed:character_state_update:character_not_found/,
    );
    assert.equal(rejectedUpdates[0].data.status, "rejected");
    assert.equal(committedUpdates[0].data.status, "committed");
  } finally {
    prisma.stateChangeProposal.findMany = originals.proposalFindMany;
    prisma.stateChangeProposal.update = originals.proposalUpdate;
    prisma.$transaction = originals.transaction;
    prisma.stateChangeProposal.updateMany = originals.proposalUpdateMany;
    canonicalStateService.getSnapshot = originals.getSnapshot;
    stateVersionLog.createVersion = originals.createVersion;
  }
});

test("StateCommitService keeps envelope apply failures strict", async () => {
  const service = new StateCommitService();
  const row = {
    id: "proposal-envelope-invalid",
    novelId: "novel-1",
    chapterId: "chapter-5",
    sourceSnapshotId: null,
    sourceType: "change_proposal",
    sourceStage: "proposal_core",
    proposalType: "character_state_update",
    riskLevel: "low",
    status: "pending_review",
    summary: "invalid envelope item",
    payloadJson: JSON.stringify({ characterId: "deleted-character", currentState: "missing" }),
    evidenceJson: JSON.stringify(["proposal evidence"]),
    validationNotesJson: JSON.stringify([]),
    changeProposalId: "change-proposal-1",
    reviewDecision: "accepted",
  };
  const originals = {
    proposalFindMany: prisma.stateChangeProposal.findMany,
    transaction: prisma.$transaction,
  };

  try {
    prisma.stateChangeProposal.findMany = async () => [row];
    prisma.$transaction = async (callback) => callback({
      character: {
        updateMany: async () => ({ count: 0 }),
      },
      stateChangeProposal: {
        update: async () => {
          throw new Error("envelope item must not be marked committed");
        },
      },
    });

    await assert.rejects(
      service.commitExistingProposals({
        novelId: "novel-1",
        proposalIds: [row.id],
        reason: "envelope_apply",
      }),
      /missing character/,
    );
  } finally {
    prisma.stateChangeProposal.findMany = originals.proposalFindMany;
    prisma.$transaction = originals.transaction;
  }
});

test("StateCommitService keeps legacy infrastructure failures strict", async () => {
  const service = new StateCommitService();
  const row = {
    id: "proposal-legacy-infrastructure-failure",
    novelId: "novel-1",
    chapterId: "chapter-5",
    sourceSnapshotId: null,
    sourceType: "chapter_background_sync",
    sourceStage: "chapter_execution",
    proposalType: "character_state_update",
    riskLevel: "low",
    status: "pending_review",
    summary: "infrastructure failure must abort",
    payloadJson: JSON.stringify({ characterId: "character-1", currentState: "ready" }),
    evidenceJson: JSON.stringify(["legacy evidence"]),
    validationNotesJson: JSON.stringify([]),
    changeProposalId: null,
  };
  const originals = {
    proposalFindMany: prisma.stateChangeProposal.findMany,
    proposalUpdate: prisma.stateChangeProposal.update,
    transaction: prisma.$transaction,
  };
  let proposalUpdateCalled = false;

  try {
    prisma.stateChangeProposal.findMany = async () => [row];
    prisma.stateChangeProposal.update = async () => {
      proposalUpdateCalled = true;
      return {};
    };
    prisma.$transaction = async (callback) => callback({
      character: {
        updateMany: async () => {
          throw new Error("database connection lost");
        },
      },
      stateChangeProposal: {
        update: async () => {
          throw new Error("proposal must not be marked committed");
        },
      },
    });

    await assert.rejects(
      service.commitExistingProposals({
        novelId: "novel-1",
        proposalIds: [row.id],
        reason: "legacy_infrastructure_failure",
      }),
      /database connection lost/,
    );
    assert.equal(proposalUpdateCalled, false);
  } finally {
    prisma.stateChangeProposal.findMany = originals.proposalFindMany;
    prisma.stateChangeProposal.update = originals.proposalUpdate;
    prisma.$transaction = originals.transaction;
  }
});

test("StateCommitService does not classify ordinary errors by legacy message prefix", async () => {
  const service = new StateCommitService();
  const row = {
    id: "proposal-legacy-prefix-infrastructure-failure",
    novelId: "novel-1",
    chapterId: "chapter-5",
    sourceSnapshotId: null,
    sourceType: "chapter_background_sync",
    sourceStage: "chapter_execution",
    proposalType: "character_state_update",
    riskLevel: "low",
    status: "pending_review",
    summary: "message prefix must not define error semantics",
    payloadJson: JSON.stringify({ characterId: "character-1", currentState: "ready" }),
    evidenceJson: JSON.stringify(["legacy evidence"]),
    validationNotesJson: JSON.stringify([]),
    changeProposalId: null,
  };
  const originals = {
    proposalFindMany: prisma.stateChangeProposal.findMany,
    proposalUpdate: prisma.stateChangeProposal.update,
    transaction: prisma.$transaction,
  };
  let proposalUpdateCalled = false;

  try {
    prisma.stateChangeProposal.findMany = async () => [row];
    prisma.stateChangeProposal.update = async () => {
      proposalUpdateCalled = true;
      return {};
    };
    prisma.$transaction = async (callback) => callback({
      character: {
        updateMany: async () => {
          throw new Error("Character state proposal database connection lost");
        },
      },
      stateChangeProposal: {
        update: async () => {
          throw new Error("proposal must not be marked committed");
        },
      },
    });

    await assert.rejects(
      service.commitExistingProposals({
        novelId: "novel-1",
        proposalIds: [row.id],
        reason: "legacy_prefix_infrastructure_failure",
      }),
      /Character state proposal database connection lost/,
    );
    assert.equal(proposalUpdateCalled, false);
  } finally {
    prisma.stateChangeProposal.findMany = originals.proposalFindMany;
    prisma.stateChangeProposal.update = originals.proposalUpdate;
    prisma.$transaction = originals.transaction;
  }
});

test("StateCommitService legacy persistence converts domain apply failures into rejected rows", async () => {
  const service = new StateCommitService();
  const rows = new Map();
  let sequence = 0;
  const originals = {
    transaction: prisma.$transaction,
  };
  const makeRow = (data) => ({
    id: `persisted-${++sequence}`,
    ...data,
    changeProposalId: null,
    userEditedPayloadJson: null,
    reviewDecision: null,
  });

  try {
    prisma.$transaction = async (callback) => callback({
      character: {
        updateMany: async () => ({ count: 0 }),
      },
      stateChangeProposal: {
        create: async ({ data }) => {
          const row = makeRow(data);
          rows.set(row.id, row);
          return row;
        },
        update: async ({ where, data }) => {
          const row = { ...rows.get(where.id), ...data };
          rows.set(where.id, row);
          return row;
        },
      },
    });

    const result = await service.persistValidated({
      accepted: [
        {
          novelId: "novel-1",
          chapterId: "chapter-5",
          sourceSnapshotId: null,
          sourceType: "chapter_background_sync",
          sourceStage: "chapter_execution",
          proposalType: "character_state_update",
          riskLevel: "low",
          status: "committed",
          summary: "deleted character state",
          payload: { characterId: "deleted-character", currentState: "missing" },
          evidence: ["legacy evidence"],
          validationNotes: [],
        },
        {
          novelId: "novel-1",
          chapterId: "chapter-5",
          sourceSnapshotId: null,
          sourceType: "chapter_background_sync",
          sourceStage: "chapter_execution",
          proposalType: "event_record",
          riskLevel: "low",
          status: "committed",
          summary: "valid legacy event",
          payload: { eventKey: "valid-event" },
          evidence: ["event evidence"],
          validationNotes: [],
        },
      ],
      pendingReview: [],
      rejected: [],
    });

    assert.equal(result.committed.length, 1);
    assert.equal(result.committed[0].proposalType, "event_record");
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].proposalType, "character_state_update");
    assert.match(
      result.rejected[0].validationNotes.join(" "),
      /legacy_apply_failed:character_state_update:character_not_found/,
    );
  } finally {
    prisma.$transaction = originals.transaction;
  }
});

test("StateCommitService legacy persistence keeps infrastructure failures strict", async () => {
  const service = new StateCommitService();
  const originals = {
    transaction: prisma.$transaction,
  };
  let proposalUpdateCalled = false;

  try {
    prisma.$transaction = async (callback) => callback({
      character: {
        updateMany: async () => {
          throw new Error("database connection lost");
        },
      },
      stateChangeProposal: {
        create: async ({ data }) => ({
          id: "persisted-infrastructure-failure",
          ...data,
          changeProposalId: null,
          userEditedPayloadJson: null,
          reviewDecision: null,
        }),
        update: async () => {
          proposalUpdateCalled = true;
          return {};
        },
      },
    });

    await assert.rejects(
      service.persistValidated({
        accepted: [{
          novelId: "novel-1",
          chapterId: "chapter-5",
          sourceSnapshotId: null,
          sourceType: "chapter_background_sync",
          sourceStage: "chapter_execution",
          proposalType: "character_state_update",
          riskLevel: "low",
          status: "committed",
          summary: "infrastructure failure must abort",
          payload: { characterId: "character-1", currentState: "ready" },
          evidence: ["legacy evidence"],
          validationNotes: [],
        }],
        pendingReview: [],
        rejected: [],
      }),
      /database connection lost/,
    );
    assert.equal(proposalUpdateCalled, false);
  } finally {
    prisma.$transaction = originals.transaction;
  }
});
