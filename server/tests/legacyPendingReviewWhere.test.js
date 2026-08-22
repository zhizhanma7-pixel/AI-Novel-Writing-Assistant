const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildLegacyPendingReviewWhere,
} = require("../dist/services/novel/state/legacyPendingReviewWhere.js");
const {
  buildBlockingPendingReviewProposalWhere,
} = require("../dist/services/novel/runtime/context/pendingReviewContext.js");

test("legacy pending-review queries exclude proposal-envelope items", () => {
  assert.deepEqual(buildLegacyPendingReviewWhere("novel-1"), {
    novelId: "novel-1",
    status: "pending_review",
    changeProposalId: null,
  });
  assert.deepEqual(buildBlockingPendingReviewProposalWhere("novel-1", "chapter-1"), {
    novelId: "novel-1",
    status: "pending_review",
    changeProposalId: null,
    OR: [{ chapterId: "chapter-1" }, { chapterId: null }],
  });
});
