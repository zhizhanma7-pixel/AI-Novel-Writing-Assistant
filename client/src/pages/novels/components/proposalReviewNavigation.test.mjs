import assert from "node:assert/strict";
import test from "node:test";
import { buildProposalReviewHref } from "./proposalReviewNavigation.ts";

test("proposal checkpoints use the edit-route novel when resume target is absent", () => {
  assert.equal(buildProposalReviewHref({
    checkpointType: "proposal_review_required",
    routeNovelId: "novel-route",
    resumeTargetNovelId: null,
    taskId: "task-1",
  }), "/novels/novel-route/edit?directorTaskId=task-1&proposalPanel=1");
});

test("proposal checkpoints retain resume target as an off-route fallback", () => {
  assert.equal(buildProposalReviewHref({
    checkpointType: "proposal_review_required",
    routeNovelId: null,
    resumeTargetNovelId: "novel-resume",
    taskId: "task-1",
  }), "/novels/novel-resume/edit?directorTaskId=task-1&proposalPanel=1");
});

test("other checkpoints never create a proposal review route", () => {
  assert.equal(buildProposalReviewHref({
    checkpointType: "step_review_required",
    routeNovelId: "novel-route",
    resumeTargetNovelId: null,
    taskId: "task-1",
  }), null);
});
