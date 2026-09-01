const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  ChangeProposalService,
} = require("../dist/services/novel/proposal/application/ChangeProposalService.js");
const {
  ChangeProposalReviewService,
} = require("../dist/services/novel/proposal/application/ChangeProposalReviewService.js");
const {
  ChangeProposalApplyService,
} = require("../dist/services/novel/proposal/application/ChangeProposalApplyService.js");
const {
  registerNovelChangeProposalRoutes,
} = require("../dist/modules/novel/proposal/http/novelChangeProposalRoutes.js");
const {
  ChangeProposalStalenessService,
} = require("../dist/services/novel/proposal/infrastructure/ChangeProposalStalenessService.js");

function makeStore() {
  return {
    proposals: new Map(),
    changes: new Map(),
    proposalSequence: 0,
    changeSequence: 0,
    stale: false,
    committedBatches: [],
    events: [],
    editLockConflict: false,
  };
}

let store = makeStore();

function proposalWithChanges(proposal) {
  if (!proposal) {
    return null;
  }
  return {
    ...proposal,
    changes: [...store.changes.values()]
      .filter((change) => change.changeProposalId === proposal.id)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
  };
}

function matchesStatus(actual, expected) {
  if (typeof expected === "string") {
    return actual === expected;
  }
  if (expected?.in) {
    return expected.in.includes(actual);
  }
  return true;
}

function matchesProposal(proposal, where = {}) {
  return (!where.id || proposal.id === where.id)
    && (!where.novelId || proposal.novelId === where.novelId)
    && (!where.version || proposal.version === where.version)
    && (!where.status || matchesStatus(proposal.status, where.status));
}

const originals = {
  transaction: prisma.$transaction,
  novelFindUnique: prisma.novel.findUnique,
  chapterFindFirst: prisma.chapter.findFirst,
  workflowTaskFindFirst: prisma.novelWorkflowTask.findFirst,
  proposalCreate: prisma.changeProposal.create,
  proposalFindFirst: prisma.changeProposal.findFirst,
  proposalFindMany: prisma.changeProposal.findMany,
  proposalUpdateMany: prisma.changeProposal.updateMany,
  changeUpdate: prisma.stateChangeProposal.update,
  changeUpdateMany: prisma.stateChangeProposal.updateMany,
  changeCount: prisma.stateChangeProposal.count,
};

function installPrismaHarness() {
  prisma.novel.findUnique = async ({ where }) => (where.id === "novel-1" ? { id: where.id } : null);
  prisma.chapter.findFirst = async ({ where, select }) => {
    if (where.id !== "chapter-1" || where.novelId !== "novel-1") {
      return null;
    }
    return select?.order ? { order: 1 } : { id: where.id };
  };
  prisma.novelWorkflowTask.findFirst = async () => null;
  prisma.changeProposal.create = async ({ data }) => {
    const now = new Date(Date.UTC(2026, 7, 19, 0, 0, store.proposalSequence));
    const id = `proposal-${++store.proposalSequence}`;
    const proposal = {
      id,
      novelId: data.novelId,
      chapterId: data.chapterId ?? null,
      taskId: data.taskId ?? null,
      proposalType: data.proposalType,
      version: data.version ?? 1,
      supersedesId: data.supersedesId ?? null,
      status: data.status ?? "draft",
      outlineFidelity: data.outlineFidelity ?? null,
      summary: data.summary,
      reasoningSummary: data.reasoningSummary ?? null,
      sourceRefsJson: data.sourceRefsJson ?? null,
      warningsJson: data.warningsJson ?? null,
      expectedStateJson: data.expectedStateJson ?? null,
      approvedAt: data.approvedAt ?? null,
      executedAt: data.executedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    store.proposals.set(id, proposal);
    for (const dataItem of data.changes?.create ?? []) {
      const changeId = `change-${++store.changeSequence}`;
      store.changes.set(changeId, {
        id: changeId,
        changeProposalId: id,
        proposalType: dataItem.proposalType,
        status: dataItem.status,
        summary: dataItem.summary,
        payloadJson: dataItem.payloadJson,
        evidenceJson: dataItem.evidenceJson ?? null,
        changePath: dataItem.changePath ?? null,
        operation: dataItem.operation ?? null,
        category: dataItem.category ?? null,
        severity: dataItem.severity ?? null,
        beforeJson: dataItem.beforeJson ?? null,
        afterJson: dataItem.afterJson ?? null,
        userEditedPayloadJson: null,
        reviewDecision: null,
        sourceRefsJson: dataItem.sourceRefsJson ?? null,
        validationNotesJson: dataItem.validationNotesJson ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
    return proposalWithChanges(proposal);
  };
  prisma.changeProposal.findFirst = async ({ where }) => {
    const proposal = [...store.proposals.values()].find((entry) => matchesProposal(entry, where));
    return proposalWithChanges(proposal);
  };
  prisma.changeProposal.findMany = async ({ where = {} }) => [...store.proposals.values()]
    .filter((proposal) => matchesProposal(proposal, where))
    .map(proposalWithChanges);
  prisma.changeProposal.updateMany = async ({ where, data }) => {
    if (store.editLockConflict && data.updatedAt instanceof Date) {
      return { count: 0 };
    }
    let count = 0;
    for (const proposal of store.proposals.values()) {
      if (!matchesProposal(proposal, where)) {
        continue;
      }
      Object.assign(proposal, data, { updatedAt: new Date(proposal.updatedAt.getTime() + 1000) });
      count += 1;
    }
    return { count };
  };
  prisma.stateChangeProposal.update = async ({ where, data }) => {
    const change = store.changes.get(where.id);
    if (!change) {
      throw new Error(`Missing proposed change ${where.id}`);
    }
    Object.assign(change, data, { updatedAt: new Date(change.updatedAt.getTime() + 1000) });
    return change;
  };
  prisma.stateChangeProposal.updateMany = async ({ where, data }) => {
    let count = 0;
    for (const change of store.changes.values()) {
      if (typeof where.id === "string" && change.id !== where.id) {
        continue;
      }
      if (where.id?.in && !where.id.in.includes(change.id)) {
        continue;
      }
      if (where.changeProposalId && change.changeProposalId !== where.changeProposalId) {
        continue;
      }
      if (where.status && !matchesStatus(change.status, where.status)) {
        continue;
      }
      Object.assign(change, data, { updatedAt: new Date(change.updatedAt.getTime() + 1000) });
      count += 1;
    }
    return { count };
  };
  prisma.stateChangeProposal.count = async ({ where }) => [...store.changes.values()].filter((change) => (
    (!where.id?.in || where.id.in.includes(change.id))
      && (!where.changeProposalId || change.changeProposalId === where.changeProposalId)
      && (!where.status || change.status === where.status)
      && (!where.reviewDecision?.in || where.reviewDecision.in.includes(change.reviewDecision))
  )).length;
  prisma.$transaction = async (callback) => callback({
    changeProposal: prisma.changeProposal,
    stateChangeProposal: prisma.stateChangeProposal,
  });
}

function restorePrismaHarness() {
  prisma.$transaction = originals.transaction;
  prisma.novel.findUnique = originals.novelFindUnique;
  prisma.chapter.findFirst = originals.chapterFindFirst;
  prisma.novelWorkflowTask.findFirst = originals.workflowTaskFindFirst;
  prisma.changeProposal.create = originals.proposalCreate;
  prisma.changeProposal.findFirst = originals.proposalFindFirst;
  prisma.changeProposal.findMany = originals.proposalFindMany;
  prisma.changeProposal.updateMany = originals.proposalUpdateMany;
  prisma.stateChangeProposal.update = originals.changeUpdate;
  prisma.stateChangeProposal.updateMany = originals.changeUpdateMany;
  prisma.stateChangeProposal.count = originals.changeCount;
}

const artifactService = {
  index: async () => "artifact-proposal",
  markStatus: async () => {},
  markUserEdited: async () => {},
};
const eventService = {
  recordEvent: async (event) => {
    store.events.push(event);
  },
};
const stalenessService = {
  inspect: async () => ({
    isStale: store.stale,
    reasons: store.stale ? ["source_artifact_version_changed:artifact-1:1->2"] : [],
  }),
};

function services(options = {}) {
  const proposalService = new ChangeProposalService(artifactService, eventService, stalenessService);
  const reviewService = new ChangeProposalReviewService(
    proposalService,
    artifactService,
    eventService,
    stalenessService,
  );
  const commitService = {
    commitExistingProposals: async ({ proposalIds }) => {
      store.committedBatches.push([...proposalIds]);
      const committed = proposalIds.map((id) => {
        const change = store.changes.get(id);
        change.status = "committed";
        return { id };
      });
      return { committed, pendingReview: [], rejected: [], versionRecord: null };
    },
  };
  const applyService = new ChangeProposalApplyService(
    proposalService,
    commitService,
    artifactService,
    eventService,
    stalenessService,
    options.policyGate ?? {
      evaluate: async () => ({
        autonomyLevel: "L2",
        policyMode: "run_until_gate",
        policy: {
          mode: "run_until_gate",
          proposalAutonomyLevel: "L2",
          mayOverwriteUserContent: false,
          maxAutoRepairAttempts: 1,
          allowExpensiveReview: false,
          modelTier: "balanced",
          updatedAt: "2026-08-26T00:00:00.000Z",
        },
        decision: {
          canRun: true,
          requiresApproval: false,
          gateType: "none",
          reason: "test policy allows execution",
          mayOverwriteUserContent: false,
          affectedArtifacts: [],
          riskTags: [],
          autoRetryBudget: 0,
          onQualityFailure: "continue_with_risk",
        },
      }),
    },
  );
  return { proposalService, reviewService, applyService };
}

function proposalInput() {
  return {
    chapterId: "chapter-1",
    proposalType: "character_state",
    summary: "Update the hero state and record the next event.",
    reasoningSummary: "The approved chapter explicitly establishes both changes.",
    sourceRefs: [{ kind: "director_artifact", artifactId: "artifact-1", version: 1 }],
    changes: [
      {
        proposalType: "character_state_update",
        path: "Character.hero.currentGoal",
        operation: "replace",
        category: "character",
        severity: "major",
        before: "wait",
        after: "act",
        payload: { characterId: "hero", currentGoal: "act" },
        reason: "The hero commits to acting.",
        sourceRefs: [],
        evidence: ["The hero accepts the mission."],
      },
      {
        proposalType: "event_record",
        path: "Timeline.events.missionAccepted",
        operation: "add",
        category: "timeline",
        severity: "minor",
        after: true,
        payload: { eventKey: "mission-accepted" },
        reason: "Record the accepted mission.",
        sourceRefs: [],
        evidence: ["The mission is accepted."],
      },
    ],
  };
}

test("Phase 1 ChangeProposal core", async (t) => {
  installPrismaHarness();
  try {
    await t.test("create proposal", async () => {
      store = makeStore();
      const { proposalService } = services();
      const proposal = await proposalService.createProposal("novel-1", proposalInput());

      assert.equal(proposal.status, "pending_review");
      assert.equal(proposal.version, 1);
      assert.equal(proposal.changes.length, 2);
      assert.equal(proposal.reasoningSummary, proposalInput().reasoningSummary);
      assert.equal(store.events.at(-1).type, "proposal_created");
    });

    await t.test("approve proposal", async () => {
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      const approved = await reviewService.approveProposal("novel-1", created.id, { expectedVersion: 1 });

      assert.equal(approved.status, "approved");
      assert.deepEqual(approved.changes.map((change) => change.reviewDecision), ["accepted", "accepted"]);
      assert.equal(store.events.at(-1).type, "proposal_reviewed");
    });

    await t.test("reject proposal", async () => {
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      const rejected = await reviewService.rejectProposal("novel-1", created.id, {
        expectedVersion: 1,
        reason: "Conflicts with the outline.",
      });

      assert.equal(rejected.status, "rejected");
      assert.ok(rejected.changes.every((change) => change.reviewDecision === "rejected"));
    });

    await t.test("partial approval", async () => {
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      const partial = await reviewService.approveProposal("novel-1", created.id, {
        itemDecisions: [{ id: created.changes[0].id, decision: "accepted" }],
        unlistedDecision: "rejected",
      });

      assert.equal(partial.status, "partially_approved");
      assert.equal(partial.changes[0].reviewDecision, "accepted");
      assert.equal(partial.changes[1].reviewDecision, "rejected");
    });

    await t.test("partial decisions cannot silently reject unlisted changes", async () => {
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());

      await assert.rejects(
        reviewService.approveProposal("novel-1", created.id, {
          itemDecisions: [{ id: created.changes[0].id, decision: "accepted" }],
        }),
        (error) => error.code === "invalid_review",
      );
      assert.ok(created.changes.every((change) => change.reviewDecision === null));
    });

    await t.test("edit proposed value before approval", async () => {
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      await reviewService.editProposedChange("novel-1", created.id, created.changes[0].id, {
        payload: { characterId: "hero", currentGoal: "negotiate" },
        after: "negotiate",
      });
      const approved = await reviewService.approveProposal("novel-1", created.id);

      assert.equal(approved.changes[0].reviewDecision, "modified");
      assert.deepEqual(approved.changes[0].userEditedPayload, {
        characterId: "hero",
        currentGoal: "negotiate",
      });
      assert.equal(approved.changes[0].after, "negotiate");
    });

    await t.test("full payload edits keep the displayed after value in sync", async () => {
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      await reviewService.editProposedChange("novel-1", created.id, created.changes[0].id, {
        payload: { characterId: "hero", currentGoal: "bargain" },
      });
      const approved = await reviewService.approveProposal("novel-1", created.id);

      assert.equal(approved.changes[0].after, "bargain");
      assert.equal(approved.changes[0].userEditedPayload.currentGoal, "bargain");
    });

    await t.test("partial approval reuses an item payload saved by an earlier edit", async () => {
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      await reviewService.editProposedChange("novel-1", created.id, created.changes[0].id, {
        payload: { characterId: "hero", currentGoal: "reassess" },
      });
      const approved = await reviewService.approveProposal("novel-1", created.id, {
        itemDecisions: [
          { id: created.changes[0].id, decision: "modified" },
          { id: created.changes[1].id, decision: "rejected" },
        ],
      });

      assert.equal(approved.status, "partially_approved");
      assert.equal(approved.changes[0].after, "reassess");
      assert.equal(approved.changes[0].userEditedPayload.currentGoal, "reassess");
    });

    await t.test("bare modified decisions require a stored edit", async () => {
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());

      await assert.rejects(
        reviewService.approveProposal("novel-1", created.id, {
          itemDecisions: [
            { id: created.changes[0].id, decision: "modified" },
            { id: created.changes[1].id, decision: "rejected" },
          ],
        }),
        (error) => error.code === "invalid_review",
      );
    });

    await t.test("modified approval payload becomes both diff and executable value", async () => {
      store = makeStore();
      const { proposalService, reviewService, applyService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      const approved = await reviewService.approveProposal("novel-1", created.id, {
        itemDecisions: [{
          id: created.changes[0].id,
          decision: "modified",
          editedPayload: { characterId: "hero", currentGoal: "prepare" },
        }],
        unlistedDecision: "rejected",
      });

      assert.equal(approved.changes[0].after, "prepare");
      assert.equal(approved.changes[0].userEditedPayload.currentGoal, "prepare");
      const executed = await applyService.executeProposal("novel-1", created.id);
      assert.equal(executed.status, "executed");
    });

    await t.test("accepted approval cannot execute a payload that disagrees with the displayed value", async () => {
      store = makeStore();
      const { proposalService, reviewService, applyService } = services();
      const input = proposalInput();
      input.changes = [{
        proposalType: "relation_state_update",
        path: "Character.hero.relationship.partner.trust",
        operation: "replace",
        category: "relationship",
        severity: "minor",
        before: 62,
        after: 61,
        payload: {
          sourceCharacterId: "hero",
          targetCharacterId: "partner",
          trustScore: 5,
        },
        reason: "The displayed diff and executable state disagree.",
        sourceRefs: [],
        evidence: ["Structured state evidence"],
      }];
      const created = await proposalService.createProposal("novel-1", input);
      await reviewService.approveProposal("novel-1", created.id);

      await assert.rejects(
        applyService.executeProposal("novel-1", created.id),
        (error) => error.code === "invalid_review",
      );
      assert.equal(store.committedBatches.length, 0);
    });

    await t.test("concurrent proposal review prevents a late item edit", async () => {
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      store.editLockConflict = true;

      await assert.rejects(
        reviewService.editProposedChange("novel-1", created.id, created.changes[0].id, {
          expectedVersion: 1,
          payload: { characterId: "hero", currentGoal: "negotiate" },
        }),
        (error) => error.code === "version_conflict",
      );
      assert.equal(store.changes.get(created.changes[0].id).userEditedPayloadJson, null);
    });

    await t.test("approving cannot silently ratify an item edited after it was read", async () => {
      // 「proposal source changed before approval」。
      //
      // 审批者读到提案（version 1），看到的是 negotiate。另一个人把这一项改成了
      // 别的内容——version 不变，只有 updatedAt 变了。审批者带着 expectedVersion: 1
      // 点批准，乐观锁看的是 version，于是照过，批准的其实是他没看过的内容。
      //
      // version 的含义是重新生成的世代号（supersede 时 +1），不该被逐项编辑挪用；
      // 所以并发守卫另走 expectedUpdatedAt。
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      const seenByReviewer = created.updatedAt;

      await reviewService.editProposedChange("novel-1", created.id, created.changes[0].id, {
        payload: { characterId: "hero", currentGoal: "negotiate" },
        after: "negotiate",
      });

      await assert.rejects(
        reviewService.approveProposal("novel-1", created.id, {
          expectedVersion: 1,
          expectedUpdatedAt: seenByReviewer,
        }),
        (error) => error.code === "version_conflict",
        "读过之后被改动，批准必须被挡下",
      );

      // 不传 expectedUpdatedAt 的老调用方行为不变。
      const approved = await reviewService.approveProposal("novel-1", created.id, {
        expectedVersion: 1,
      });
      assert.equal(approved.status, "approved");
    });

    await t.test("edited relation after value updates the executable trust score", async () => {
      store = makeStore();
      const { proposalService, reviewService } = services();
      const input = proposalInput();
      input.changes = [{
        proposalType: "relation_state_update",
        path: "Character.hero.relationship.partner.trust",
        operation: "replace",
        category: "relationship",
        severity: "major",
        before: 62,
        after: 52,
        payload: {
          sourceCharacterId: "hero",
          targetCharacterId: "partner",
          trustScore: 52,
        },
        reason: "Trust decreases after the confrontation.",
        sourceRefs: [],
        evidence: ["They stop sharing information."],
      }];
      const created = await proposalService.createProposal("novel-1", input);
      await reviewService.editProposedChange("novel-1", created.id, created.changes[0].id, {
        expectedVersion: 1,
        after: 55,
      });
      const approved = await reviewService.approveProposal("novel-1", created.id);

      assert.equal(approved.changes[0].reviewDecision, "modified");
      assert.equal(approved.changes[0].after, 55);
      assert.equal(approved.changes[0].userEditedPayload.trustScore, 55);
    });

    await t.test("stale proposal cannot be approved", async () => {
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      store.stale = true;

      await assert.rejects(
        reviewService.approveProposal("novel-1", created.id),
        (error) => error.code === "stale_proposal",
      );
      assert.equal(store.proposals.get(created.id).status, "pending_review");
    });

    await t.test("stale detection reports a changed source artifact version", async () => {
      const originalArtifactFindMany = prisma.directorArtifact.findMany;
      const originalArtifactFindFirst = prisma.directorArtifact.findFirst;
      const originalChapterFindMany = prisma.chapter.findMany;
      prisma.directorArtifact.findMany = async () => [{
        id: "artifact-1",
        version: 2,
        status: "active",
        contentHash: "hash-2",
        dependencies: [],
      }];
      prisma.directorArtifact.findFirst = async () => ({ status: "active" });
      prisma.chapter.findMany = async () => [];
      try {
        const stale = await new ChangeProposalStalenessService().inspect({
          proposalId: "proposal-1",
          novelId: "novel-1",
          sourceRefs: [{ kind: "director_artifact", artifactId: "artifact-1", version: 1 }],
        });
        assert.equal(stale.isStale, true);
        assert.deepEqual(stale.reasons, ["source_artifact_version_changed:artifact-1:1->2"]);
      } finally {
        prisma.directorArtifact.findMany = originalArtifactFindMany;
        prisma.directorArtifact.findFirst = originalArtifactFindFirst;
        prisma.chapter.findMany = originalChapterFindMany;
      }
    });

    await t.test("apply approved changes only", async () => {
      store = makeStore();
      const { proposalService, reviewService, applyService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      const partial = await reviewService.approveProposal("novel-1", created.id, {
        itemDecisions: [{ id: created.changes[0].id, decision: "accepted" }],
        unlistedDecision: "rejected",
      });
      const executed = await applyService.executeProposal("novel-1", created.id);

      assert.equal(executed.status, "executed");
      assert.deepEqual(store.committedBatches, [[partial.changes[0].id]]);
      assert.equal(store.changes.get(partial.changes[0].id).status, "committed");
      assert.equal(store.changes.get(partial.changes[1].id).status, "rejected");
      assert.equal(store.events.at(-1).type, "proposal_applied");
    });

    await t.test("automation obeys proposal policy while explicit review satisfies the approval gate", async () => {
      store = makeStore();
      const policyCalls = [];
      const policyGate = {
        evaluate: async (proposal) => {
          policyCalls.push(proposal.id);
          return {
            autonomyLevel: "L3",
            policyMode: "auto_safe_scope",
            policy: {
              mode: "auto_safe_scope",
              proposalAutonomyLevel: "L3",
              mayOverwriteUserContent: false,
              maxAutoRepairAttempts: 1,
              allowExpensiveReview: false,
              modelTier: "balanced",
              updatedAt: "2026-08-26T00:00:00.000Z",
            },
            decision: {
              canRun: false,
              requiresApproval: true,
              gateType: "approval",
              reason: "major proposal requires review",
              mayOverwriteUserContent: false,
              affectedArtifacts: [],
              riskTags: ["proposal_major"],
              autoRetryBudget: 0,
              onQualityFailure: "pause_for_manual",
            },
          };
        },
      };
      const { proposalService, reviewService, applyService } = services({ policyGate });
      const input = proposalInput();
      input.changes = [input.changes[0]];
      const created = await proposalService.createProposal("novel-1", input);
      await reviewService.approveProposal("novel-1", created.id);

      await assert.rejects(
        applyService.executeProposal("novel-1", created.id, { authority: "automation" }),
        (error) => error.code === "approval_required",
      );
      assert.deepEqual(store.committedBatches, []);

      const executed = await applyService.executeProposal("novel-1", created.id, {
        authority: "explicit_review",
      });
      assert.equal(executed.status, "executed");
      assert.deepEqual(policyCalls, [created.id]);
    });

    await t.test("approved ledger-only changes remain unsupported instead of claiming execution", async () => {
      store = makeStore();
      const { proposalService, reviewService, applyService } = services();
      const input = proposalInput();
      input.changes = [input.changes[1]];
      const created = await proposalService.createProposal("novel-1", input);
      await reviewService.approveProposal("novel-1", created.id);

      await assert.rejects(
        applyService.executeProposal("novel-1", created.id),
        (error) => error.code === "unsupported_change",
      );
      assert.equal(store.proposals.get(created.id).status, "approved");
      assert.deepEqual(store.committedBatches, []);
    });

    await t.test("invalid state transition", async () => {
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      await reviewService.rejectProposal("novel-1", created.id);

      await assert.rejects(
        reviewService.approveProposal("novel-1", created.id),
        (error) => error.code === "invalid_transition",
      );
    });

    await t.test("regenerate creates a new proposal version and supersedes the old one", async () => {
      store = makeStore();
      const { proposalService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      const regenerated = await proposalService.regenerateProposal("novel-1", created.id, {
        summary: "Updated proposal after source review.",
      });

      assert.equal(regenerated.version, 2);
      assert.equal(regenerated.supersedesId, created.id);
      assert.equal(store.proposals.get(created.id).status, "superseded");
      assert.equal(store.events.at(-1).type, "proposal_superseded");
    });

    await t.test("a rejected proposal can still be regenerated", async () => {
      // 「reject then regenerate」。驳回不是终点：作者说「这版不行」之后，
      // 应当能再出一版，而不是把这条线锁死。
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      const rejected = await reviewService.rejectProposal("novel-1", created.id, {
        reason: "方向不对，重来。",
      });
      assert.equal(rejected.status, "rejected");

      const regenerated = await proposalService.regenerateProposal("novel-1", created.id, {
        summary: "第二版。",
      });

      assert.equal(regenerated.version, 2);
      assert.equal(regenerated.supersedesId, created.id);
      assert.equal(store.proposals.get(created.id).status, "superseded");
      // 新一版从待审开始，不继承上一版的结论——否则作者一打开就看到「已驳回」。
      assert.notEqual(regenerated.status, "rejected");
      assert.equal(regenerated.changes.length, created.changes.length);
    });

    await t.test("a regenerated proposal leaves the superseded one unreviewable", async () => {
      // 「stale proposal」的一种：旧信封还开在另一个标签页里，
      // 在那儿点批准不能生效，否则两版会各自往下走。
      store = makeStore();
      const { proposalService, reviewService } = services();
      const created = await proposalService.createProposal("novel-1", proposalInput());
      await proposalService.regenerateProposal("novel-1", created.id, { summary: "第二版。" });

      await assert.rejects(
        reviewService.approveProposal("novel-1", created.id),
        (error) => error.code === "invalid_transition" || error.code === "version_conflict",
        "已被取代的提案不能再批准",
      );
    });

    await t.test("approve, partial approve, reject, edit, and execute APIs are registered", () => {
      const routes = [];
      const router = {
        get: (path) => routes.push(`GET ${path}`),
        post: (path) => routes.push(`POST ${path}`),
        patch: (path) => routes.push(`PATCH ${path}`),
      };
      registerNovelChangeProposalRoutes(router);

      assert.ok(routes.includes("POST /:id/change-proposals/:proposalId/approve"));
      assert.ok(routes.includes("POST /:id/change-proposals/:proposalId/partial-approve"));
      assert.ok(routes.includes("POST /:id/change-proposals/:proposalId/reject"));
      assert.ok(routes.includes("PATCH /:id/change-proposals/:proposalId/items/:itemId"));
      assert.ok(routes.includes("POST /:id/change-proposals/:proposalId/execute"));
    });
  } finally {
    restorePrismaHarness();
  }
});

test("并发守卫贯穿审批的整条链路，不止服务层", () => {
  // 审批走命令队列：路由收到 expectedUpdatedAt → 命令载荷 → 执行器 → 审批服务。
  // 中间任何一环没带上，排队期间的改动就查不出来——审批者点「批准」时看到的那一版，
  // 到真正执行时可能已经不是它了。这条链断在哪都是静默失效，所以逐段钉住。
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

  const routes = read("src/modules/novel/proposal/http/novelChangeProposalRoutes.ts");
  const payload = read("src/services/novel/director/commands/DirectorCommandServiceHelpers.ts");
  const executor = read("src/services/novel/director/commands/DirectorCommandExecutor.ts");
  const reviewService = read("src/services/novel/proposal/application/ChangeProposalReviewService.ts");

  assert.match(routes, /expectedUpdatedAt: req\.body\.expectedUpdatedAt/);
  assert.match(payload, /expectedUpdatedAt\?: string;/);
  assert.match(executor, /expectedUpdatedAt: request\.expectedUpdatedAt/);
  // 审批、部分审批、驳回、逐项编辑四个入口都要查。
  assert.equal(
    (reviewService.match(/assertExpectedProposalUpdatedAt\(/g) ?? []).length,
    3,
    "三个校验点都要带上并发守卫",
  );
});

test("时间戳按毫秒比较，不比字符串", () => {
  // DTO 里是 ISO 字符串，数据库里是 Date，两边序列化格式不必一致。
  // 直接比字符串会在格式差一位（毫秒补零、时区写法）时误判成冲突。
  const {
    assertExpectedProposalUpdatedAt,
  } = require("../dist/services/novel/proposal/domain/ChangeProposalStateMachine.js");

  const at = new Date("2026-09-01T10:00:00.000Z");
  assert.doesNotThrow(() => assertExpectedProposalUpdatedAt(at, "2026-09-01T10:00:00.000Z"));
  assert.doesNotThrow(() => assertExpectedProposalUpdatedAt(at, "2026-09-01T18:00:00.000+08:00"));
  assert.doesNotThrow(() => assertExpectedProposalUpdatedAt(at, undefined), "不传就不查，老调用方不受影响");
  assert.throws(
    () => assertExpectedProposalUpdatedAt(at, "2026-09-01T10:00:01.000Z"),
    (error) => error.code === "version_conflict",
  );
  assert.throws(
    () => assertExpectedProposalUpdatedAt(at, "不是时间"),
    (error) => error.code === "version_conflict",
  );
});
